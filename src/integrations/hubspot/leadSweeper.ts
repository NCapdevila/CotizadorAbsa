import { config } from "../../config.js";
import { logger } from "../../logger.js";
import type { JobQueue } from "../../queue/jobQueue.js";
import { HubspotClient } from "./client.js";
import { dealYContactoAPayload } from "./leadSweeperMapper.js";
import { enProcesoDealProperties } from "./mapper.js";

/**
 * Barrido de rescate: encuentra Deals que hay que cotizar y nadie encolo.
 *
 * Por que existe: el webhook del Workflow de HubSpot es un **push sin
 * garantia**. El 2026-08-28 seis leads no se cotizaron nunca y el motivo no
 * fue nuestro — el access.log de nginx mostro que HubSpot simplemente no
 * disparo para esos Deals (los que si llegaron respondieron todos 202), y los
 * Deals nacieron en el mismo stage que los que si dispararon. Sin un camino
 * alternativo, un lead perdido asi no se recupera nunca: nadie se entera hasta
 * que el cliente reclama.
 *
 * Con esto, el webhook pasa a ser una optimizacion de latencia (cotiza a los
 * 90 segundos) y no una dependencia: lo que se pierda lo levanta el barrido en
 * la pasada siguiente. Cubre igual el rato que el servicio este caido, un
 * filtro de inscripcion mal puesto, o un cambio en el Workflow dentro de seis
 * meses que nadie relacione con esto.
 *
 * No duplica trabajo: encola con la MISMA `JobQueue` que el webhook, y
 * `enqueue()` ya descarta un Deal que tenga un job pendiente o en vuelo.
 */
export interface LeadSweeperDeps {
  queue: JobQueue;
  hubspotClient?: Pick<HubspotClient, "buscarDealsSinCotizar" | "contactoDeDeal" | "leerContacto" | "updateDealProperties">;
  /** Default: HUBSPOT_BARRIDO_*. Se fuerzan en tests. */
  intervalMs?: number;
  horasHaciaAtras?: number;
  maxPorPasada?: number;
  /** Loguea lo que encolaria y no encola nada. Para la primera puesta en marcha. */
  simulacro?: boolean;
}

export class LeadSweeper {
  private readonly queue: JobQueue;
  private readonly hubspot: NonNullable<LeadSweeperDeps["hubspotClient"]>;
  private readonly intervalMs: number;
  private readonly horasHaciaAtras: number;
  private readonly maxPorPasada: number;
  private readonly simulacro: boolean;
  private timer: ReturnType<typeof setInterval> | null = null;
  private corriendo = false;

  constructor(deps: LeadSweeperDeps) {
    this.queue = deps.queue;
    this.hubspot = deps.hubspotClient ?? new HubspotClient();
    this.intervalMs = deps.intervalMs ?? config.HUBSPOT_BARRIDO_INTERVAL_MS;
    this.horasHaciaAtras = deps.horasHaciaAtras ?? config.HUBSPOT_BARRIDO_HORAS;
    this.maxPorPasada = deps.maxPorPasada ?? config.HUBSPOT_BARRIDO_MAX;
    this.simulacro = deps.simulacro ?? config.HUBSPOT_BARRIDO_SIMULACRO;
  }

  start(): void {
    if (this.timer) return;
    logger.info(
      {
        intervalMs: this.intervalMs,
        horasHaciaAtras: this.horasHaciaAtras,
        maxPorPasada: this.maxPorPasada,
        simulacro: this.simulacro,
      },
      this.simulacro
        ? "Barrido de Deals sin cotizar arrancado EN SIMULACRO: loguea lo que encolaria, no encola nada"
        : "Barrido de Deals sin cotizar arrancado",
    );
    const pasada = () => this.runOnce().catch((err) => logger.error({ err }, "Error inesperado en el barrido de Deals"));

    // Una pasada al arrancar y despues cada intervalo. Arrancar barriendo es
    // deliberado: si el servicio estuvo caido, los leads que se perdieron
    // mientras tanto son justo los que hay que recuperar, y esperar diez
    // minutos para empezar a hacerlo no tiene sentido. Repetirla en cada
    // reinicio no molesta: el filtro por `absa_estado` sin valor y la
    // deduplicacion de la cola hacen que una pasada sin nada nuevo no haga
    // nada.
    void pasada();
    this.timer = setInterval(pasada, this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Una pasada. Publico para tests y para poder dispararlo a mano. */
  async runOnce(): Promise<{ encontrados: number; encolados: number }> {
    if (this.corriendo) return { encontrados: 0, encolados: 0 }; // una pasada puede tardar mas que el intervalo
    this.corriendo = true;
    try {
      const desde = new Date(Date.now() - this.horasHaciaAtras * 60 * 60 * 1000);
      const deals = await this.hubspot.buscarDealsSinCotizar(desde, this.maxPorPasada);
      if (deals.length === 0) return { encontrados: 0, encolados: 0 };

      logger.warn(
        { deals: deals.length, desde: desde.toISOString(), simulacro: this.simulacro },
        "El barrido encontro Deals sin cotizar: son leads cuyo webhook no llego",
      );

      let encolados = 0;
      for (const deal of deals) {
        if (await this.encolar(deal.id, deal.properties)) encolados++;
      }
      return { encontrados: deals.length, encolados };
    } finally {
      this.corriendo = false;
    }
  }

  /**
   * Un Deal cuyo webhook no llego. Los errores son por lead y no cortan la
   * pasada: un Contact borrado no puede impedir que se recuperen los otros
   * cinco.
   */
  private async encolar(dealId: string, propiedadesDeal: Record<string, string | null>): Promise<boolean> {
    try {
      const contactId = await this.hubspot.contactoDeDeal(dealId);
      if (!contactId) {
        // Sin Contact no hay DNI, fecha de nacimiento, sexo ni codigo postal:
        // ABSA rechaza la cotizacion. Se avisa y se saltea en vez de encolar
        // algo que ya sabemos que va a fallar.
        logger.warn({ dealId }, "El barrido salteo un Deal sin Contact asociado: ahi viven los datos del asegurado");
        return false;
      }

      const contacto = await this.hubspot.leerContacto(contactId);
      const payload = dealYContactoAPayload(dealId, propiedadesDeal, contacto, contactId);

      if (this.simulacro) {
        logger.info(
          { dealId, contactId, vehiculo: `${payload.marca_vehiculo} ${payload.modelo_vehiculo} ${payload.anio_vehiculo}` },
          "SIMULACRO: este lead se encolaria",
        );
        return false;
      }

      const { job, duplicado } = await this.queue.enqueue(payload);
      if (duplicado) {
        logger.info({ dealId, jobId: job.id }, "El barrido encontro un Deal que ya estaba en la cola, no se encola de nuevo");
        return false;
      }

      logger.warn({ dealId, contactId, jobId: job.id }, "Lead recuperado por el barrido y encolado para cotizar");

      // Igual que el webhook: se marca en proceso apenas se encola, para que
      // no quede indistinguible de un lead que nadie tomo. Si falla, el lead
      // ya esta encolado y el worker va a escribir el estado final igual.
      try {
        await this.hubspot.updateDealProperties(dealId, enProcesoDealProperties().properties);
      } catch (err) {
        logger.warn({ err, dealId }, "No se pudo marcar como en proceso el Deal recuperado (sigue encolado igual)");
      }
      return true;
    } catch (err) {
      logger.error({ err, dealId }, "El barrido no pudo recuperar este Deal, sigue con los demas");
      return false;
    }
  }
}
