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
