import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JobQueue } from "../src/queue/jobQueue.js";
import type { HubspotLeadWebhookPayload } from "../src/integrations/hubspot/types.js";

const SAMPLE_PAYLOAD: HubspotLeadWebhookPayload = { dealId: "1" };

describe("JobQueue", () => {
  let filePath: string;
  let queue: JobQueue;

  beforeEach(() => {
    filePath = path.join(os.tmpdir(), `absa-queue-test-${Date.now()}-${Math.random()}.json`);
    queue = new JobQueue(filePath);
  });

  afterEach(() => {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  });

  it("encola un job en estado pending", async () => {
    const { job } = await queue.enqueue(SAMPLE_PAYLOAD);
    expect(job.status).toBe("pending");
    expect(job.attempts).toBe(0);

    const all = await queue.list();
    expect(all).toHaveLength(1);
  });

  it("claimNext toma el mas viejo pending y lo pasa a processing; no devuelve el mismo dos veces", async () => {
    const { job } = await queue.enqueue(SAMPLE_PAYLOAD);

    const claimed = await queue.claimNext();
    expect(claimed?.id).toBe(job.id);
    expect(claimed?.status).toBe("processing");

    const second = await queue.claimNext();
    expect(second).toBeNull();
  });

  it("markDone marca el job como done", async () => {
    const { job } = await queue.enqueue(SAMPLE_PAYLOAD);
    await queue.claimNext();
    await queue.markDone(job.id);

    const [stored] = await queue.list();
    expect(stored?.status).toBe("done");
  });

  it("markFailedOrRetry vuelve a pending si quedan intentos, y a failed si se agotan", async () => {
    const { job } = await queue.enqueue(SAMPLE_PAYLOAD);
    await queue.claimNext();

    const afterFirst = await queue.markFailedOrRetry(job.id, "error 1", 2);
    expect(afterFirst?.status).toBe("pending");
    expect(afterFirst?.attempts).toBe(1);

    await queue.claimNext();
    const afterSecond = await queue.markFailedOrRetry(job.id, "error 2", 2);
    expect(afterSecond?.status).toBe("failed");
    expect(afterSecond?.attempts).toBe(2);
    expect(afterSecond?.lastError).toBe("error 2");
  });

  it("no encola dos veces el mismo Deal si ya tiene una cotizacion en vuelo", async () => {
    // El form puede reintentar el submit y Vercel puede reejecutar la funcion:
    // cada duplicado costaria 3-4 minutos de la unica sesion de ABSA.
    const primero = await queue.enqueue(SAMPLE_PAYLOAD);
    const segundo = await queue.enqueue(SAMPLE_PAYLOAD);

    expect(segundo.duplicado).toBe(true);
    expect(segundo.job.id).toBe(primero.job.id);
    expect(await queue.list()).toHaveLength(1);

    // Tampoco mientras se esta cotizando (status "processing").
    await queue.claimNext();
    const tercero = await queue.enqueue(SAMPLE_PAYLOAD);
    expect(tercero.duplicado).toBe(true);
    expect(await queue.list()).toHaveLength(1);
  });

  it("deja recotizar un Deal que ya termino (recotizacion legitima)", async () => {
    const { job } = await queue.enqueue(SAMPLE_PAYLOAD);
    await queue.claimNext();
    await queue.markDone(job.id);

    const otra = await queue.enqueue(SAMPLE_PAYLOAD);
    expect(otra.duplicado).toBe(false);
    expect(await queue.list()).toHaveLength(2);
  });

  it("serializa encolados concurrentes sin perder jobs (evita carreras de lectura-escritura)", async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) => queue.enqueue({ dealId: String(i) })));
    const all = await queue.list();
    expect(all).toHaveLength(20);
    expect(new Set(all.map((j) => j.id)).size).toBe(20);
  });
});

/**
 * Un lead del webhook es alguien que acaba de cargar el formulario y espera el
 * precio; uno del barrido es una recuperacion de algo que ya venia perdido.
 * Con FIFO puro, un barrido de 94 Deals (medido en produccion el 2026-08-28)
 * dejaba a los leads nuevos esperando hasta 2,5 horas detras de la puesta al dia.
 */
describe("JobQueue: prioridad por origen", () => {
  let storePath: string;
  let queue: JobQueue;

  beforeEach(() => {
    storePath = path.join(os.tmpdir(), `absa-prioridad-${Date.now()}-${Math.random()}.json`);
    queue = new JobQueue(storePath);
  });

  afterEach(() => {
    if (fs.existsSync(storePath)) fs.unlinkSync(storePath);
  });

  it("el webhook se atiende antes que el barrido aunque haya llegado despues", async () => {
    await queue.enqueue({ dealId: "barrido-1" }, "barrido");
    await queue.enqueue({ dealId: "barrido-2" }, "barrido");
    await queue.enqueue({ dealId: "del-form" }, "webhook");

    expect((await queue.claimNext())?.payload.dealId).toBe("del-form");
  });

  it("dentro de cada prioridad manda el orden de llegada: el barrido no se muere de hambre", async () => {
    await queue.enqueue({ dealId: "barrido-1" }, "barrido");
    await queue.enqueue({ dealId: "barrido-2" }, "barrido");
    await queue.enqueue({ dealId: "del-form" }, "webhook");

    const orden: Array<string | undefined> = [];
    for (let i = 0; i < 3; i++) orden.push((await queue.claimNext())?.payload.dealId);
    expect(orden).toEqual(["del-form", "barrido-1", "barrido-2"]);
  });

  it("por default se encola como webhook (el llamador de siempre no cambia)", async () => {
    const { job } = await queue.enqueue({ dealId: "x" });
    expect(job.origen).toBe("webhook");
  });

  it("un job sin origen (encolado antes de que existiera el barrido) tiene prioridad de webhook", async () => {
    await queue.enqueue({ dealId: "barrido-1" }, "barrido");
    // Se simula un job viejo escribiendo el archivo a mano, sin `origen`.
    const jobs = JSON.parse(fs.readFileSync(storePath, "utf8"));
    jobs.push({
      id: "viejo",
      status: "pending",
      payload: { dealId: "job-viejo" },
      attempts: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    fs.writeFileSync(storePath, JSON.stringify(jobs));

    expect((await queue.claimNext())?.payload.dealId).toBe("job-viejo");
  });
});
