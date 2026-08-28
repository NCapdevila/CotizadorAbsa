import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JobQueue } from "../src/queue/jobQueue.js";
import { LeadSweeper } from "../src/integrations/hubspot/leadSweeper.js";
import { dealYContactoAPayload } from "../src/integrations/hubspot/leadSweeperMapper.js";

/**
 * Propiedades REALES del 2026-08-28. El Contact 218176476590 y su Deal
 * 64476744595 cotizaron bien por webhook: son la referencia de que el barrido
 * arma el mismo payload que arma el Workflow.
 */
const CONTACTO_REAL = {
  firstname: "Cecilia",
  lastname: "Cedeira",
  email: "ceciliacedeira@gmail.com",
  phone: "+5491156632495",
  dni: "33558067",
  date_of_birth: "1988-12-06",
  gender: "F",
  zip: "1684",
  city: "El Palomar",
  state: "Buenos Aires",
  productor_agencia: "Ardama (REFERIDO)",
};

const DEAL_REAL = {
  marca_vehiculo: "HONDA",
  modelo_vehiculo: "HR-V EX CVT",
  version_vehiculo: "SEDAN 5 PUERTAS",
  anio_vehiculo: "2017",
  patente_vehiculo: "AB149RR",
};

function stubHubspot(overrides: Partial<Record<string, unknown>> = {}) {
  const escrituras: string[] = [];
  return {
    escrituras,
    buscarDealsSinCotizar: async () => [{ id: "64476744595", properties: DEAL_REAL as Record<string, string | null> }],
    contactoDeDeal: async () => "218176476590",
    leerContacto: async () => CONTACTO_REAL as Record<string, string | null>,
    updateDealProperties: async (dealId: string) => {
      escrituras.push(dealId);
    },
    ...overrides,
  };
}

describe("dealYContactoAPayload", () => {
  it("arma el mismo payload que manda el Workflow, uniendo Deal y Contact", () => {
    const payload = dealYContactoAPayload("64476744595", DEAL_REAL, CONTACTO_REAL, "218176476590");

    // Del Contact, con los nombres ESTANDAR de HubSpot (no los del webhook).
    expect(payload.dni).toBe("33558067");
    expect(payload.fecha_nacimiento).toBe("1988-12-06");
    expect(payload.sexo).toBe("F");
    expect(payload.codigo_postal).toBe("1684");
    expect(payload.localidad).toBe("El Palomar");
    expect(payload.productor).toBe("Ardama (REFERIDO)");
    // Del Deal.
    expect(payload.marca_vehiculo).toBe("HONDA");
    expect(payload.anio_vehiculo).toBe("2017");
    expect(payload.patente).toBe("AB149RR");
    expect(payload.dealId).toBe("64476744595");
  });

  it("trata null y cadena vacia como ausente, que es como HubSpot devuelve lo vacio", () => {
    const payload = dealYContactoAPayload("1", { marca_vehiculo: "FIAT" }, { dni: "", zip: null, gender: "  " });
    expect(payload.dni).toBeUndefined();
    expect(payload.codigo_postal).toBeUndefined();
    expect(payload.sexo).toBeUndefined();
  });
});

describe("LeadSweeper", () => {
  let storePath: string;
  let queue: JobQueue;

  beforeEach(() => {
    storePath = path.join(os.tmpdir(), `absa-sweeper-test-${Date.now()}-${Math.random()}.json`);
    queue = new JobQueue(storePath);
  });

  afterEach(() => {
    if (fs.existsSync(storePath)) fs.unlinkSync(storePath);
  });

  it("encola el Deal que el webhook no trajo y lo marca en proceso", async () => {
    const hubspot = stubHubspot();
    const sweeper = new LeadSweeper({ queue, hubspotClient: hubspot as never, simulacro: false });

    expect(await sweeper.runOnce()).toEqual({ encontrados: 1, encolados: 1 });

    const jobs = await queue.list();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload.dealId).toBe("64476744595");
    expect(jobs[0]!.payload.codigo_postal).toBe("1684");
    expect(hubspot.escrituras).toEqual(["64476744595"]);
  });

  it("en simulacro no encola ni escribe nada", async () => {
    const hubspot = stubHubspot();
    const sweeper = new LeadSweeper({ queue, hubspotClient: hubspot as never, simulacro: true });

    expect(await sweeper.runOnce()).toEqual({ encontrados: 1, encolados: 0 });
    expect(await queue.list()).toHaveLength(0);
    expect(hubspot.escrituras).toEqual([]);
  });

  /**
   * Lo que impide cotizar dos veces el mismo Deal cuando el webhook llega
   * tarde: el barrido y el webhook comparten la misma JobQueue.
   */
  it("no encola un Deal que el webhook ya habia encolado", async () => {
    await queue.enqueue({ dealId: "64476744595", marca_vehiculo: "HONDA" });
    const hubspot = stubHubspot();
    const sweeper = new LeadSweeper({ queue, hubspotClient: hubspot as never, simulacro: false });

    expect(await sweeper.runOnce()).toEqual({ encontrados: 1, encolados: 0 });
    expect(await queue.list()).toHaveLength(1);
  });

  it("saltea el Deal sin Contact: ahi viven los datos que ABSA exige", async () => {
    const hubspot = stubHubspot({ contactoDeDeal: async () => undefined });
    const sweeper = new LeadSweeper({ queue, hubspotClient: hubspot as never, simulacro: false });

    expect(await sweeper.runOnce()).toEqual({ encontrados: 1, encolados: 0 });
    expect(await queue.list()).toHaveLength(0);
  });

  it("un lead que falla no se lleva puesta la pasada entera", async () => {
    const hubspot = stubHubspot({
      buscarDealsSinCotizar: async () => [
        { id: "roto", properties: DEAL_REAL },
        { id: "64476744595", properties: DEAL_REAL },
      ],
      contactoDeDeal: async (dealId: string) => {
        if (dealId === "roto") throw new Error("HubSpot exploto");
        return "218176476590";
      },
    });
    const sweeper = new LeadSweeper({ queue, hubspotClient: hubspot as never, simulacro: false });

    expect(await sweeper.runOnce()).toEqual({ encontrados: 2, encolados: 1 });
    expect((await queue.list()).map((j) => j.payload.dealId)).toEqual(["64476744595"]);
  });
});
