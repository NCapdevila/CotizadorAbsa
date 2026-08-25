import { beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LeadWorker, type QuoteExecutor, type DealWriter } from "../src/queue/worker.js";
import { JobQueue } from "../src/queue/jobQueue.js";
import { resetHubspotPropertiesCache } from "../src/integrations/hubspot/propertiesConfig.js";
import type { AbsaEntityResolver, AbsaEntityIds } from "../src/quote/vehicleCatalog.js";
import { VehicleCatalogUnresolvedError, BusinessValidationError } from "../src/quote/errors.js";
import type { HubspotLeadWebhookPayload } from "../src/integrations/hubspot/types.js";
import type { CotizacionInput, CotizacionResult } from "../src/quote/types.js";
import type { AttachFileInput } from "../src/integrations/hubspot/client.js";

const VALID_PAYLOAD: HubspotLeadWebhookPayload = {
  dealId: "777",
  contactId: "555",
  firstname: "Juan",
  lastname: "Perez",
  dni: "30123456",
  fecha_nacimiento: "1990-01-15",
  sexo: "M",
  estado_civil: "Casado",
  marca_vehiculo: "Ford",
  modelo_vehiculo: "Fiesta",
  anio_vehiculo: "2020",
  patente: "AB123CD",
};

const ABSA_IDS: AbsaEntityIds = {
  idEntity: 1,
  idVehiculo: 2,
  idMarcaVehiculo: 3,
  idModeloVehiculo: 4,
  idOrigenVehiculo: 1,
  infoAuto: 5,
  idLocalidad: 6,
};

const RESULT_OK: CotizacionResult = {
  ok: true,
  numeroCotizacion: "123",
  aseguradorasCotizadas: [2, 21],
  opciones: [{ plan: "ZURICH", premio: 1000, moneda: "ARS", cobertura: "terceros completo" }],
  rawAbsaResponse: {},
  obtenidoEn: "2026-08-20T00:00:00.000Z",
};

class RecordingDealWriter implements DealWriter {
  propertyCalls: Array<{ dealId: string; properties: Record<string, string | number> }> = [];
  attachCalls: Array<{ dealId: string; file: AttachFileInput; noteBody: string }> = [];
  shouldThrowOnUpdate = false;
  shouldThrowOnAttach = false;

  async updateDealProperties(dealId: string, properties: Record<string, string | number>): Promise<void> {
    if (this.shouldThrowOnUpdate) throw new Error("HubSpot no disponible");
    this.propertyCalls.push({ dealId, properties });
  }

  async attachFileToDeal(dealId: string, file: AttachFileInput, noteBody: string): Promise<void> {
    if (this.shouldThrowOnAttach) throw new Error("HubSpot no disponible");
    this.attachCalls.push({ dealId, file, noteBody });
  }
}

class FixedResolver implements AbsaEntityResolver {
  constructor(
    private readonly ids: AbsaEntityIds | null,
    private readonly err?: Error,
  ) {}
  async resolve(): Promise<AbsaEntityIds> {
    if (this.err) throw this.err;
    return this.ids!;
  }
}

class FixedQuoteExecutor implements QuoteExecutor {
  readonly guardados: Array<{ idEntity: number; nroCotizacion: string; descripcion: string }> = [];
  readonly pdfsPedidos: string[] = [];
  aseguradorasPedidas: number[] | undefined;

  constructor(
    private readonly fn: (input: CotizacionInput) => Promise<CotizacionResult>,
    /** Para simular que ABSA no devuelve el PDF (o que falla el guardado) y ver el fallback. */
    private readonly fallas: { guardar?: boolean; pdf?: boolean } = {},
  ) {}

  cotizar(input: CotizacionInput): Promise<CotizacionResult> {
    return this.fn(input);
  }

  async guardarCotizacion(idEntity: number, nroCotizacion: string, descripcion: string): Promise<void> {
    if (this.fallas.guardar) throw new Error("ABSA rechazo el guardado");
    this.guardados.push({ idEntity, nroCotizacion, descripcion });
  }

  async exportarPdfCotizacion(
    _idEntity: number,
    nroCotizacion: string,
    opciones?: { aseguradoras?: number[] },
  ): Promise<{ buffer: Buffer; filename: string }> {
    if (this.fallas.pdf) throw new Error("ABSA no devolvio el PDF");
    this.pdfsPedidos.push(nroCotizacion);
    this.aseguradorasPedidas = opciones?.aseguradoras;
    return { buffer: Buffer.from("%PDF-de-absa"), filename: `FIAT - ARGO 1.8 PRECISION L-21_2022.pdf` };
  }
}

function buildQueue(): { queue: JobQueue; filePath: string } {
  const filePath = path.join(os.tmpdir(), `absa-worker-test-${Date.now()}-${Math.random()}.json`);
  return { queue: new JobQueue(filePath), filePath };
}

describe("LeadWorker.runOnce", () => {
  beforeEach(() => resetHubspotPropertiesCache());

  it("cotiza, actualiza el Deal existente y le adjunta el PDF; marca el job done", async () => {
    const { queue, filePath } = buildQueue();
    const dealWriter = new RecordingDealWriter();
    const worker = new LeadWorker({
      queue,
      quoteClient: new FixedQuoteExecutor(async () => RESULT_OK),
      hubspotClient: dealWriter,
      resolver: new FixedResolver(ABSA_IDS),
      maxAttempts: 2,
    });

    await queue.enqueue(VALID_PAYLOAD);
    await worker.runOnce();

    expect(dealWriter.propertyCalls).toHaveLength(1);
    expect(dealWriter.propertyCalls[0]?.dealId).toBe("777");
    expect(dealWriter.propertyCalls[0]?.properties.absa_estado).toBe("ok");

    expect(dealWriter.attachCalls).toHaveLength(1);
    expect(dealWriter.attachCalls[0]?.dealId).toBe("777");
    expect(dealWriter.attachCalls[0]?.file.filename).toMatch(/\.pdf$/);
    expect(dealWriter.attachCalls[0]?.file.buffer.length).toBeGreaterThan(0);

    const [job] = await queue.list();
    expect(job?.status).toBe("done");
    fs.rmSync(filePath, { force: true });
  });

  it("guarda la cotizacion en ABSA, adjunta el PDF de ABSA y escribe la URL en el Deal", async () => {
    const { queue, filePath } = buildQueue();
    const dealWriter = new RecordingDealWriter();
    const quoteClient = new FixedQuoteExecutor(async () => RESULT_OK);
    const worker = new LeadWorker({ queue, quoteClient, hubspotClient: dealWriter, resolver: new FixedResolver(ABSA_IDS), maxAttempts: 2 });

    await queue.enqueue(VALID_PAYLOAD);
    await worker.runOnce();

    // Sin guardar, la cotizacion es efimera y la URL del Deal no abre nada.
    expect(quoteClient.guardados).toHaveLength(1);
    expect(quoteClient.guardados[0]?.nroCotizacion).toBe("123");
    // El nombre en el listado de ABSA identifica auto, patente y titular.
    expect(quoteClient.guardados[0]?.descripcion).toBe("Ford Fiesta 2020 - AB123CD - Juan Perez - 30123456");

    // El adjunto es la impresion de ABSA, no el comparativo propio.
    expect(quoteClient.pdfsPedidos).toEqual(["123"]);
    // Se tildan las coberturas de las que cotizaron, no de todas las de la plantilla.
    expect(quoteClient.aseguradorasPedidas).toEqual([2, 21]);
    expect(dealWriter.attachCalls[0]?.file.buffer.toString()).toBe("%PDF-de-absa");
    expect(dealWriter.attachCalls[0]?.file.filename).toBe("FIAT - ARGO 1.8 PRECISION L-21_2022.pdf");

    // La URL lleva el NUMERO DE COTIZACION, no el id_Entity.
    expect(dealWriter.propertyCalls[0]?.properties.cotizacion_absa).toBe(
      "https://absanet.test/AutoCotizador/Cotizar/123?accion=4&esRecotizacionAnalisis=False",
    );
    fs.rmSync(filePath, { force: true });
  });

  it("con HUBSPOT_ADJUNTAR_PDF apagado no adjunta nada, pero completa el Deal igual", async () => {
    // La cotizacion automatica es orientativa: por ahora se prefiere el Deal
    // con los numeros y el link a ABSA, sin un PDF que parezca definitivo.
    const { queue, filePath } = buildQueue();
    const dealWriter = new RecordingDealWriter();
    const quoteClient = new FixedQuoteExecutor(async () => RESULT_OK);
    const worker = new LeadWorker({
      queue,
      quoteClient,
      hubspotClient: dealWriter,
      resolver: new FixedResolver(ABSA_IDS),
      maxAttempts: 2,
      adjuntarPdf: false,
    });

    await queue.enqueue(VALID_PAYLOAD);
    await worker.runOnce();

    expect(dealWriter.attachCalls).toHaveLength(0);
    // Ni siquiera se le pide el PDF a ABSA (son 3 requests menos por lead).
    expect(quoteClient.pdfsPedidos).toHaveLength(0);
    // Lo que importa sigue estando: resultado, estado y link a la cotizacion.
    expect(dealWriter.propertyCalls[0]?.properties.absa_estado).toBe("ok");
    expect(dealWriter.propertyCalls[0]?.properties.cotizacion_absa).toContain("/AutoCotizador/Cotizar/123");
    const [jobSinPdf] = await queue.list();
    expect(jobSinPdf?.status).toBe("done");
    fs.rmSync(filePath, { force: true });
  });

  it("si ABSA no devuelve el PDF, adjunta el comparativo propio en vez de dejar el Deal sin adjunto", async () => {
    const { queue, filePath } = buildQueue();
    const dealWriter = new RecordingDealWriter();
    const quoteClient = new FixedQuoteExecutor(async () => RESULT_OK, { pdf: true });
    const worker = new LeadWorker({ queue, quoteClient, hubspotClient: dealWriter, resolver: new FixedResolver(ABSA_IDS), maxAttempts: 2 });

    await queue.enqueue(VALID_PAYLOAD);
    await worker.runOnce();

    expect(dealWriter.attachCalls).toHaveLength(1);
    expect(dealWriter.attachCalls[0]?.file.buffer.subarray(0, 4).toString()).toBe("%PDF");
    const [jobPdf] = await queue.list();
    expect(jobPdf?.status).toBe("done");
    fs.rmSync(filePath, { force: true });
  });

  it("si falla el guardado en ABSA igual completa el Deal (no reintenta 3 minutos de cotizacion por eso)", async () => {
    const { queue, filePath } = buildQueue();
    const dealWriter = new RecordingDealWriter();
    const quoteClient = new FixedQuoteExecutor(async () => RESULT_OK, { guardar: true });
    const worker = new LeadWorker({ queue, quoteClient, hubspotClient: dealWriter, resolver: new FixedResolver(ABSA_IDS), maxAttempts: 2 });

    await queue.enqueue(VALID_PAYLOAD);
    await worker.runOnce();

    expect(dealWriter.propertyCalls[0]?.properties.absa_estado).toBe("ok");
    const [jobGuardado] = await queue.list();
    expect(jobGuardado?.status).toBe("done");
    fs.rmSync(filePath, { force: true });
  });

  it("si faltan datos minimos del lead, actualiza error_datos_incompletos sin llamar a ABSA ni adjuntar nada", async () => {
    const { queue, filePath } = buildQueue();
    const dealWriter = new RecordingDealWriter();
    let cotizarCalled = false;
    const worker = new LeadWorker({
      queue,
      quoteClient: new FixedQuoteExecutor(async () => {
        cotizarCalled = true;
        return RESULT_OK;
      }),
      hubspotClient: dealWriter,
      resolver: new FixedResolver(ABSA_IDS),
    });

    const { marca_vehiculo, ...incompletePayload } = VALID_PAYLOAD;
    await queue.enqueue(incompletePayload);
    await worker.runOnce();

    expect(cotizarCalled).toBe(false);
    expect(dealWriter.propertyCalls[0]?.properties.absa_estado).toBe("error_datos_incompletos");
    expect(dealWriter.attachCalls).toHaveLength(0);
    const [job] = await queue.list();
    expect(job?.status).toBe("done");
    fs.rmSync(filePath, { force: true });
  });

  it("si el catalogo de vehiculos no esta resuelto, actualiza error_catalogo_no_resuelto", async () => {
    const { queue, filePath } = buildQueue();
    const dealWriter = new RecordingDealWriter();
    const worker = new LeadWorker({
      queue,
      quoteClient: new FixedQuoteExecutor(async () => RESULT_OK),
      hubspotClient: dealWriter,
      resolver: new FixedResolver(null, new VehicleCatalogUnresolvedError("no encontrado")),
    });

    await queue.enqueue(VALID_PAYLOAD);
    await worker.runOnce();

    expect(dealWriter.propertyCalls[0]?.properties.absa_estado).toBe("error_catalogo_no_resuelto");
    const [job] = await queue.list();
    expect(job?.status).toBe("done");
    fs.rmSync(filePath, { force: true });
  });

  it("un productor que el formulario manda y no esta mapeado cotiza igual, con el productor por defecto", async () => {
    const { queue, filePath } = buildQueue();
    const dealWriter = new RecordingDealWriter();
    let inputRecibido: CotizacionInput | undefined;
    const worker = new LeadWorker({
      queue,
      quoteClient: new FixedQuoteExecutor(async (input) => {
        inputRecibido = input;
        return RESULT_OK;
      }),
      hubspotClient: dealWriter,
      resolver: new FixedResolver(ABSA_IDS),
    });

    await queue.enqueue({ ...VALID_PAYLOAD, productor: "Concesionaria Que No Existe" });
    await worker.runOnce();

    // Decision de negocio: entre no atender el lead y cotizarlo con la cuenta
    // general, se cotiza. Que productor se termino usando lo resuelve
    // QuoteClient (ver resolverProductor), aca lo que importa es que no frena.
    expect(inputRecibido?.productor).toBe("Concesionaria Que No Existe");
    expect(dealWriter.propertyCalls.at(-1)?.properties.absa_estado).toBe("ok");
    const [job] = await queue.list();
    expect(job?.status).toBe("done");
    fs.rmSync(filePath, { force: true });
  });

  it("si ABSA tira un error de negocio, actualiza error_negocio_absa sin reintentar", async () => {
    const { queue, filePath } = buildQueue();
    const dealWriter = new RecordingDealWriter();
    const worker = new LeadWorker({
      queue,
      quoteClient: new FixedQuoteExecutor(async () => {
        throw new BusinessValidationError("dato rechazado por ABSA");
      }),
      hubspotClient: dealWriter,
      resolver: new FixedResolver(ABSA_IDS),
      maxAttempts: 3,
    });

    await queue.enqueue(VALID_PAYLOAD);
    await worker.runOnce();

    expect(dealWriter.propertyCalls[0]?.properties.absa_estado).toBe("error_negocio_absa");
    const [job] = await queue.list();
    expect(job?.status).toBe("done");
    expect(job?.attempts).toBe(0); // no cuenta como reintento de cola, es terminal
    fs.rmSync(filePath, { force: true });
  });

  it("si ABSA tira un error transitorio, reintenta en la cola hasta agotar intentos y recien ahi actualiza HubSpot", async () => {
    const { queue, filePath } = buildQueue();
    const dealWriter = new RecordingDealWriter();
    let attempts = 0;
    const worker = new LeadWorker({
      queue,
      quoteClient: new FixedQuoteExecutor(async () => {
        attempts++;
        throw new Error("timeout de red");
      }),
      hubspotClient: dealWriter,
      resolver: new FixedResolver(ABSA_IDS),
      maxAttempts: 2,
    });

    await queue.enqueue(VALID_PAYLOAD);

    await worker.runOnce();
    let [job] = await queue.list();
    expect(job?.status).toBe("pending"); // primer intento fallo, vuelve a la cola
    expect(dealWriter.propertyCalls).toHaveLength(0);

    await worker.runOnce();
    [job] = await queue.list();
    expect(job?.status).toBe("failed"); // segundo intento agoto los reintentos
    expect(attempts).toBe(2);
    expect(dealWriter.propertyCalls[0]?.properties.absa_estado).toBe("error_absa");
    fs.rmSync(filePath, { force: true });
  });

  it("si actualizar HubSpot falla, el job vuelve a la cola en vez de perderse", async () => {
    const { queue, filePath } = buildQueue();
    const dealWriter = new RecordingDealWriter();
    dealWriter.shouldThrowOnUpdate = true;
    const worker = new LeadWorker({
      queue,
      quoteClient: new FixedQuoteExecutor(async () => RESULT_OK),
      hubspotClient: dealWriter,
      resolver: new FixedResolver(ABSA_IDS),
      maxAttempts: 3,
    });

    await queue.enqueue(VALID_PAYLOAD);
    await worker.runOnce();

    const [job] = await queue.list();
    expect(job?.status).toBe("pending");
    expect(job?.attempts).toBe(1);
    fs.rmSync(filePath, { force: true });
  });

  it("si adjuntar el PDF falla, el job vuelve a la cola en vez de perderse (aunque las propiedades ya se hayan actualizado)", async () => {
    const { queue, filePath } = buildQueue();
    const dealWriter = new RecordingDealWriter();
    dealWriter.shouldThrowOnAttach = true;
    const worker = new LeadWorker({
      queue,
      quoteClient: new FixedQuoteExecutor(async () => RESULT_OK),
      hubspotClient: dealWriter,
      resolver: new FixedResolver(ABSA_IDS),
      maxAttempts: 3,
    });

    await queue.enqueue(VALID_PAYLOAD);
    await worker.runOnce();

    const [job] = await queue.list();
    expect(job?.status).toBe("pending");
    fs.rmSync(filePath, { force: true });
  });

  it("un error totalmente inesperado (no VehicleCatalogUnresolvedError/BusinessValidationError) no deja el job trabado en processing", async () => {
    const { queue, filePath } = buildQueue();
    const dealWriter = new RecordingDealWriter();
    const worker = new LeadWorker({
      queue,
      quoteClient: new FixedQuoteExecutor(async () => RESULT_OK),
      hubspotClient: dealWriter,
      resolver: new FixedResolver(null, new Error("boom inesperado")), // no es VehicleCatalogUnresolvedError
      maxAttempts: 2,
    });

    await queue.enqueue(VALID_PAYLOAD);
    await worker.runOnce();

    const [job] = await queue.list();
    expect(job?.status).toBe("pending"); // la red de seguridad lo devuelve a la cola, no queda en "processing"
    expect(job?.attempts).toBe(1);
    fs.rmSync(filePath, { force: true });
  });

  it("devuelve null si no hay jobs pendientes", async () => {
    const { queue, filePath } = buildQueue();
    const worker = new LeadWorker({
      queue,
      quoteClient: new FixedQuoteExecutor(async () => RESULT_OK),
      hubspotClient: new RecordingDealWriter(),
      resolver: new FixedResolver(ABSA_IDS),
    });

    const result = await worker.runOnce();
    expect(result).toBeNull();
    fs.rmSync(filePath, { force: true });
  });
});
