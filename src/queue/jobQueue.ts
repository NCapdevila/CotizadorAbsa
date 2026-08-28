import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { HubspotLeadWebhookPayload, QueueJob, QueueJobOrigen } from "../integrations/hubspot/types.js";
import { logger } from "../logger.js";

/**
 * Cola persistida en un JSON plano en disco. Deliberadamente simple (sin
 * Redis/DB externa) porque el volumen esperado es bajo (leads de un
 * formulario, no miles por minuto) y el deploy objetivo es un solo proceso
 * always-on en un VPS (ver docs/hubspot-integration.md) — mismo criterio que
 * SessionStore para la sesion de ABSA.
 *
 * El archivo contiene PII de leads (nombre, DNI, etc): mismo trato que un
 * secreto, gitignored (ver QUEUE_STORE_PATH / .gitignore).
 *
 * Las escrituras se serializan con una cadena de promesas en memoria para
 * evitar carreras entre el webhook (que encola) y el worker (que
 * lee/actualiza) dentro del mismo proceso Node. Si en algun momento esto
 * corre con mas de un proceso, hay que reemplazar esto por algo con locking
 * real (ej. una tabla en SQLite/Postgres).
 */
export class JobQueue {
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  private readAll(): QueueJob[] {
    try {
      if (!fs.existsSync(this.filePath)) return [];
      const raw = fs.readFileSync(this.filePath, "utf8");
      if (!raw.trim()) return [];
      return JSON.parse(raw) as QueueJob[];
    } catch (err) {
      logger.error({ err, filePath: this.filePath }, "Cola de leads corrupta o ilegible — revisar a mano, no se pierde el archivo");
      throw err;
    }
  }

  private writeAll(jobs: QueueJob[]): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(jobs, null, 2), { mode: 0o600 });
    fs.renameSync(tmpPath, this.filePath); // rename es atomico en el mismo filesystem, evita dejar el archivo a medio escribir
  }

  private async withLock<T>(fn: (jobs: QueueJob[]) => { jobs: QueueJob[]; result: T }): Promise<T> {
    let result!: T;
    this.writeChain = this.writeChain.then(() => {
      const current = this.readAll();
      const { jobs, result: r } = fn(current);
      this.writeAll(jobs);
      result = r;
    });
    await this.writeChain;
    return result;
  }

  /**
   * Encola un lead. Si ese Deal YA tiene una cotizacion en vuelo (pending o
   * processing), devuelve el job existente y no encola nada: el formulario
   * puede reintentar el submit, Vercel puede reejecutar la funcion y HubSpot
   * puede reintentar un webhook — y cada duplicado costaria 3-4 minutos de
   * sesion de ABSA (que es de a una por vez) para pisar el mismo Deal con el
   * mismo resultado.
   *
   * Un Deal ya cotizado (job "done") SI se puede volver a encolar: es el caso
   * legitimo de recotizar porque cambiaron los datos.
   */
  async enqueue(
    payload: HubspotLeadWebhookPayload,
    origen: QueueJobOrigen = "webhook",
  ): Promise<{ job: QueueJob; duplicado: boolean }> {
    const now = new Date().toISOString();
    const job: QueueJob = {
      id: crypto.randomUUID(),
      status: "pending",
      origen,
      payload,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    };
    return this.withLock<{ job: QueueJob; duplicado: boolean }>((jobs) => {
      const enVuelo = jobs.find(
        (j) => j.payload.dealId === payload.dealId && (j.status === "pending" || j.status === "processing"),
      );
      if (enVuelo) return { jobs, result: { job: enVuelo, duplicado: true } };
      return { jobs: [...jobs, job], result: { job, duplicado: false } };
    });
  }

  /**
   * Toma el proximo job "pending" y lo marca "processing" (para que no lo
   * agarre otra pasada del worker).
   *
   * Los del WEBHOOK van primero. No es un detalle de eficiencia: un lead del
   * webhook es alguien que acaba de cargar el formulario y esta esperando el
   * precio, mientras que uno del barrido es una recuperacion de algo que ya
   * venia perdido. Con FIFO puro, un barrido de 94 Deals (medido en
   * produccion) dejaba a los leads nuevos esperando hasta 2,5 horas detras de
   * la puesta al dia.
   *
   * Dentro de cada prioridad se respeta el orden de llegada: el barrido no se
   * muere de hambre, solo cede el paso.
   */
  async claimNext(): Promise<QueueJob | null> {
    return this.withLock((jobs) => {
      const pendientes = jobs.filter((j) => j.status === "pending");
      // `origen` ausente = job viejo, de cuando solo existia el webhook.
      const next = pendientes.find((j) => (j.origen ?? "webhook") !== "barrido") ?? pendientes[0];
      if (!next) return { jobs, result: null };
      const claimed: QueueJob = { ...next, status: "processing", updatedAt: new Date().toISOString() };
      return { jobs: jobs.map((j) => (j.id === claimed.id ? claimed : j)), result: claimed };
    });
  }

  async markDone(id: string): Promise<void> {
    await this.withLock((jobs) => ({
      jobs: jobs.map((j) => (j.id === id ? { ...j, status: "done" as const, updatedAt: new Date().toISOString() } : j)),
      result: undefined,
    }));
  }

  /** Reintenta (vuelve a "pending") si quedan intentos, o lo marca "failed" definitivo si se agotaron. */
  async markFailedOrRetry(id: string, errorMessage: string, maxAttempts: number): Promise<QueueJob | undefined> {
    return this.withLock((jobs) => {
      let updated: QueueJob | undefined;
      const next = jobs.map((j) => {
        if (j.id !== id) return j;
        const attempts = j.attempts + 1;
        updated = {
          ...j,
          attempts,
          status: attempts >= maxAttempts ? ("failed" as const) : ("pending" as const),
          lastError: errorMessage,
          updatedAt: new Date().toISOString(),
        };
        return updated;
      });
      return { jobs: next, result: updated };
    });
  }

  async list(): Promise<QueueJob[]> {
    return this.withLock((jobs) => ({ jobs, result: jobs }));
  }
}
