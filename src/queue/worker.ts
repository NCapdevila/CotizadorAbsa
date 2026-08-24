import { config } from "../config.js";
import { logger } from "../logger.js";
import { JobQueue } from "./jobQueue.js";
import type { QueueJob } from "../integrations/hubspot/types.js";
import { QuoteClient } from "../quote/quoteClient.js";
import { SessionManager } from "../session/sessionManager.js";
import { SessionStore } from "../session/sessionStore.js";
import { HttpFormAuthStrategy } from "../session/authStrategies.js";
import { BusinessValidationError } from "../quote/errors.js";
import { VehicleCatalogUnresolvedError } from "../quote/errors.js";
import type { AbsaEntityResolver } from "../quote/vehicleCatalog.js";
import { AbsaHttpVehicleCatalogResolver } from "../quote/absaCatalogClient.js";
import { HubspotClient } from "../integrations/hubspot/client.js";
import {
  hubspotPayloadToCotizacionInput,
  cotizacionResultToDealProperties,
  errorToDealProperties,
  buildNoteBody,
} from "../integrations/hubspot/mapper.js";
import { descripcionCotizacion } from "../quote/mapper.js";
import { buildCotizacionPdf } from "../integrations/hubspot/quotePdf.js";
import type { CotizacionInput, CotizacionResult } from "../quote/types.js";
import type { AttachFileInput } from "../integrations/hubspot/client.js";

/** Subconjunto de QuoteClient que necesita el worker — permite inyectar un stub en tests sin armar un QuoteClient real. */
export interface QuoteExecutor {
  cotizar(input: CotizacionInput): Promise<CotizacionResult>;
  /** Deja la cotizacion guardada en la cuenta de ABSA (si no, es efimera y el link del Deal no abre nada). */
  guardarCotizacion(idEntity: number, nroCotizacion: string, descripcion: string): Promise<void>;
  /** La impresion en PDF que genera ABSA, la misma del boton "Exportar PDF" del cotizador. */
  exportarPdfCotizacion(
    idEntity: number,
    nroCotizacion: string,
    opciones?: { aseguradoras?: number[] },
  ): Promise<{ buffer: Buffer; filename: string }>;
}

/** Subconjunto de HubspotClient que necesita el worker — idem. El Deal ya existe (lo crea el formulario), este worker solo lo actualiza y le adjunta el PDF. */
export interface DealWriter {
  updateDealProperties(dealId: string, properties: Record<string, string | number>): Promise<void>;
  attachFileToDeal(dealId: string, file: AttachFileInput, noteBody: string): Promise<void>;
}

export interface LeadWorkerDeps {
  queue: JobQueue;
  quoteClient: QuoteExecutor;
  hubspotClient: DealWriter;
  resolver: AbsaEntityResolver;
  pollIntervalMs?: number;
  maxAttempts?: number;
  /** Default: HUBSPOT_ADJUNTAR_PDF. Se puede forzar en tests. */
  adjuntarPdf?: boolean;
}

/**
 * Worker en proceso (sin cola externa) que toma leads encolados por el
 * webhook de HubSpot, los cotiza en ABSA net y escribe el resultado (o el
 * motivo del fallo) de vuelta en el Deal EXISTENTE que ya creo el
 * formulario (nunca crea Deals ni Contacts) — actualiza propiedades de
 * estado y, si HUBSPOT_ADJUNTAR_PDF esta prendido, le adjunta el PDF de la
 * cotizacion via una Nota. Pensado para correr dentro del mismo proceso que el servidor
 * Express (un solo servicio always-on en un VPS, ver
 * docs/hubspot-integration.md) — `start()` arranca un polling liviano, no
 * hace falta infra de colas externa.
 */
export class LeadWorker {
  private readonly queue: JobQueue;
  private readonly quoteClient: QuoteExecutor;
  private readonly hubspotClient: DealWriter;
  private readonly resolver: AbsaEntityResolver;
  private readonly pollIntervalMs: number;
  private readonly maxAttempts: number;
  private readonly adjuntarPdf: boolean;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(deps: LeadWorkerDeps) {
    this.queue = deps.queue;
    this.quoteClient = deps.quoteClient;
    this.hubspotClient = deps.hubspotClient;
    this.resolver = deps.resolver;
    this.pollIntervalMs = deps.pollIntervalMs ?? config.QUEUE_POLL_INTERVAL_MS;
    this.maxAttempts = deps.maxAttempts ?? config.QUEUE_MAX_ATTEMPTS;
    this.adjuntarPdf = deps.adjuntarPdf ?? config.HUBSPOT_ADJUNTAR_PDF;
  }

  start(): void {
    if (this.timer) return;
    logger.info({ pollIntervalMs: this.pollIntervalMs, adjuntarPdf: this.adjuntarPdf }, "LeadWorker arrancado");
    this.timer = setInterval(() => {
      this.runOnce().catch((err) => logger.error({ err }, "Error inesperado en el ciclo del LeadWorker"));
    }, this.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Procesa como maximo un job pendiente. Publico para tests (evita depender de setInterval). */
  async runOnce(): Promise<QueueJob | null> {
    if (this.running) return null; // evita solaparse si un ciclo anterior todavia esta en vuelo
    this.running = true;
    try {
      const job = await this.queue.claimNext();
      if (!job) return null;
      try {
        await this.processJob(job);
      } catch (err) {
        // Red de seguridad: cualquier error no anticipado (bug, excepcion
        // rara) NO debe dejar el job trabado en "processing" para siempre —
        // lo devuelve a la cola (o lo marca failed si ya agoto intentos)
        // igual que un error tecnico de ABSA conocido.
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ err, jobId: job.id }, "Error no anticipado procesando el job, se reintenta");
        await this.queue.markFailedOrRetry(job.id, message, this.maxAttempts);
      }
      return job;
    } finally {
      this.running = false;
    }
  }

  private async processJob(job: QueueJob): Promise<void> {
    logger.info({ jobId: job.id, dealId: job.payload.dealId }, "Procesando lead encolado");

    let input: CotizacionInput;
    try {
      input = hubspotPayloadToCotizacionInput(job.payload);
    } catch (err) {
      if (err instanceof BusinessValidationError) {
        await this.finalizeError(job, "error_datos_incompletos", err.message);
        return;
      }
      throw err;
    }

    try {
      input.absa = await this.resolver.resolve(
        input.objetoAsegurado.vehiculo!,
        input.asegurado.codigoPostal ?? input.asegurado.localidad,
      );
    } catch (err) {
      if (err instanceof VehicleCatalogUnresolvedError) {
        await this.finalizeError(job, "error_catalogo_no_resuelto", err.message);
        return;
      }
      throw err;
    }

    try {
      const result: CotizacionResult = await this.quoteClient.cotizar(input);
      await this.finalizeSuccess(job, input, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof BusinessValidationError) {
        // Error de negocio: no tiene sentido reintentar sin cambiar el input.
        await this.finalizeError(job, "error_negocio_absa", message);
        return;
      }

      const updated = await this.queue.markFailedOrRetry(job.id, message, this.maxAttempts);
      if (updated?.status === "failed") {
        logger.error({ jobId: job.id, attempts: updated.attempts }, "Job agoto reintentos, se marca error en HubSpot");
        await this.hubspotClient.updateDealProperties(job.payload.dealId, errorToDealProperties("error_absa", message).properties);
      } else {
        logger.warn({ jobId: job.id, attempts: updated?.attempts }, "Fallo cotizando, vuelve a la cola para reintento");
      }
    }
  }

  /**
   * Cotizacion exitosa: la guarda en ABSA y actualiza las propiedades del Deal
   * (incluida la URL para abrirla y recotizar).
   *
   * El PDF va aparte y apagado por default (HUBSPOT_ADJUNTAR_PDF): la
   * cotizacion automatica es orientativa, y un PDF con formato de cotizacion
   * formal en el Deal se lee como definitivo. Cuando se prende, se adjunta via
   * una Nota, que es lo que lo hace aparecer en "Archivos adjuntos".
   */
  private async finalizeSuccess(job: QueueJob, input: CotizacionInput, result: CotizacionResult): Promise<void> {
    try {
      await this.guardarEnAbsa(job, input, result);
      await this.hubspotClient.updateDealProperties(job.payload.dealId, cotizacionResultToDealProperties(result).properties);

      // Con el PDF apagado, el Deal igual queda con el resultado (premios,
      // opciones) y el link a la cotizacion en ABSA para abrirla y ajustarla.
      if (this.adjuntarPdf) {
        const pdf = await this.obtenerPdf(input, result);
        await this.hubspotClient.attachFileToDeal(
          job.payload.dealId,
          { buffer: pdf.buffer, filename: pdf.filename, contentType: "application/pdf" },
          buildNoteBody(job.payload, "ok"),
        );
      }
      await this.queue.markDone(job.id);
    } catch (err) {
      logger.error({ err, jobId: job.id }, "No se pudo escribir el resultado/adjunto en HubSpot, se reintenta el job completo");
      await this.queue.markFailedOrRetry(job.id, `Fallo escribiendo a HubSpot: ${err instanceof Error ? err.message : String(err)}`, this.maxAttempts);
    }
  }

  /**
   * Guarda la cotizacion en la cuenta de ABSA. Sin esto queda como una
   * consulta efimera: no aparece en el listado del productor y la URL que se
   * escribe en el Deal (`?accion=4`) no abre nada.
   *
   * No es fatal si falla: la cotizacion ya se hizo y los numeros son validos,
   * asi que se prefiere un Deal con datos y sin link antes que reintentar todo
   * el flujo de 3 minutos por un guardado.
   */
  private async guardarEnAbsa(job: QueueJob, input: CotizacionInput, result: CotizacionResult): Promise<void> {
    if (!result.numeroCotizacion || !input.absa) return;
    const descripcion = descripcionCotizacion(input, `Deal ${job.payload.dealId}`);
    try {
      await this.quoteClient.guardarCotizacion(input.absa.idEntity, result.numeroCotizacion, descripcion);
    } catch (err) {
      logger.warn(
        { err, jobId: job.id, nroCotizacion: result.numeroCotizacion },
        "No se pudo guardar la cotizacion en ABSA: el Deal se completa igual, pero el link puede no abrir",
      );
    }
  }

  /**
   * El PDF que se adjunta al Deal es la impresion de ABSA (la misma que
   * imprime el productor desde el portal). Si ABSA no lo devuelve, se cae al
   * PDF propio armado con los resultados: es preferible un comparativo hecho
   * por nosotros que un Deal sin ningun adjunto.
   */
  private async obtenerPdf(input: CotizacionInput, result: CotizacionResult): Promise<{ buffer: Buffer; filename: string }> {
    if (result.numeroCotizacion && input.absa) {
      try {
        return await this.quoteClient.exportarPdfCotizacion(input.absa.idEntity, result.numeroCotizacion, {
          aseguradoras: result.aseguradorasCotizadas,
        });
      } catch (err) {
        logger.warn({ err, nroCotizacion: result.numeroCotizacion }, "ABSA no devolvio el PDF, se adjunta el comparativo propio");
      }
    }
    return {
      buffer: await buildCotizacionPdf(input, result),
      filename: `cotizacion-absa-${result.numeroCotizacion ?? "sin-numero"}.pdf`,
    };
  }

  /** Estado terminal de error (datos incompletos / catalogo / negocio): solo actualiza propiedades, no genera adjunto. */
  private async finalizeError(job: QueueJob, estado: string, mensaje: string): Promise<void> {
    try {
      await this.hubspotClient.updateDealProperties(job.payload.dealId, errorToDealProperties(estado, mensaje).properties);
      await this.queue.markDone(job.id);
    } catch (err) {
      logger.error({ err, jobId: job.id }, "No se pudo escribir el error en HubSpot, se reintenta el job completo");
      await this.queue.markFailedOrRetry(job.id, `Fallo escribiendo a HubSpot: ${err instanceof Error ? err.message : String(err)}`, this.maxAttempts);
    }
  }
}

/**
 * Arma un LeadWorker con las dependencias reales (ABSA + HubSpot) a partir
 * de la config. Recibe la `JobQueue` por parametro (en vez de crear la
 * suya) para que el webhook (que encola) y el worker (que procesa) usen la
 * MISMA instancia — dos `JobQueue` separadas apuntando al mismo archivo
 * podrian pisarse escrituras entre si, porque el lock en memoria es por
 * instancia, no por archivo.
 *
 * El `SessionManager` de ABSA se comparte entre `QuoteClient` y el resolver
 * de catalogo (`AbsaHttpVehicleCatalogResolver`) para no loguearse dos veces.
 */
export function createDefaultLeadWorker(queue: JobQueue): LeadWorker {
  const sessionManager = new SessionManager({
    credentials: { user: config.ABSA_USER, password: config.ABSA_PASSWORD },
    authStrategy: new HttpFormAuthStrategy(),
    store: new SessionStore(config.ABSA_SESSION_STORE_PATH),
  });

  return new LeadWorker({
    queue,
    quoteClient: new QuoteClient(sessionManager),
    hubspotClient: new HubspotClient(),
    resolver: new AbsaHttpVehicleCatalogResolver(sessionManager),
  });
}
