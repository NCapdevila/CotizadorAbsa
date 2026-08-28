import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JobQueue } from "../src/queue/jobQueue.js";
import { LeadSweeper, comienzoDelDia } from "../src/integrations/hubspot/leadSweeper.js";
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

/**
 * "De ayer para atras no se toca" es dia CALENDARIO, no 24h corridas: a las 10
 * de la maniana una ventana de 24h todavia agarraria Deals de ayer a las 10.
 */
describe("comienzoDelDia", () => {
  const ZONA = "America/Argentina/Buenos_Aires";

  it("da la medianoche local, no la UTC", () => {
    // 2026-08-28 14:30 UTC = 11:30 en Buenos Aires (UTC-3).
    const inicio = comienzoDelDia(new Date("2026-08-28T14:30:00.000Z"), ZONA);
    expect(inicio.toISOString()).toBe("2026-08-28T03:00:00.000Z");
  });

  it("antes de la medianoche UTC sigue siendo el mismo dia local", () => {
    // 2026-08-28 23:30 UTC = 20:30 del 28 en Buenos Aires: el dia arranco a las 03:00Z del 28.
    expect(comienzoDelDia(new Date("2026-08-28T23:30:00.000Z"), ZONA).toISOString()).toBe("2026-08-28T03:00:00.000Z");
  });

  it("despues de la medianoche UTC pero antes de la local, todavia es el dia anterior", () => {
    // 2026-08-29 01:00 UTC = 22:00 del 28 en Buenos Aires.
    expect(comienzoDelDia(new Date("2026-08-29T01:00:00.000Z"), ZONA).toISOString()).toBe("2026-08-28T03:00:00.000Z");
  });

  it("nunca queda adelante del instante que se le pasa", () => {
    const ahora = new Date("2026-08-28T03:30:00.000Z"); // 00:30 en Buenos Aires
    expect(comienzoDelDia(ahora, ZONA).getTime()).toBeLessThanOrEqual(ahora.getTime());
  });
});

describe("LeadSweeper: ventana", () => {
  it("con soloHoy no pide nada de ayer, aunque las horas alcancen", async () => {
    let pedido: Date | undefined;
    const hubspot = stubHubspot({
      buscarDealsSinCotizar: async (desde: Date) => {
        pedido = desde;
        return [];
      },
    });
    const queue = new JobQueue(path.join(os.tmpdir(), `absa-ventana-${Date.now()}-${Math.random()}.json`));
    const sweeper = new LeadSweeper({ queue, hubspotClient: hubspot as never, horasHaciaAtras: 24, soloHoy: true });

    await sweeper.runOnce();
    expect(pedido).toBeDefined();
    expect(pedido!.getTime()).toBe(comienzoDelDia(new Date(), "America/Argentina/Buenos_Aires").getTime());
  });

  it("con soloHoy en false vuelve a ser una ventana corrida", async () => {
    let pedido: Date | undefined;
    const hubspot = stubHubspot({
      buscarDealsSinCotizar: async (desde: Date) => {
        pedido = desde;
        return [];
      },
    });
    const queue = new JobQueue(path.join(os.tmpdir(), `absa-ventana2-${Date.now()}-${Math.random()}.json`));
    const sweeper = new LeadSweeper({ queue, hubspotClient: hubspot as never, horasHaciaAtras: 24, soloHoy: false });

    await sweeper.runOnce();
    const esperado = Date.now() - 24 * 60 * 60 * 1000;
    expect(Math.abs(pedido!.getTime() - esperado)).toBeLessThan(5000);
  });
});

/**
 * El servicio esta clavado en ID_RIESGO_AUTO = 9: una MOTO buscada en el
 * catalogo de autos no encuentra nada y el lead muere como
 * "error_catalogo_no_resuelto", que no es lo que paso. Medido el 2026-08-28:
 * de 73 Deals del dia, 3 eran MOTO.
 */
describe("LeadSweeper: tipo de riesgo", () => {
  function espia(overrides = {}) {
    const pedidos: Array<string | undefined> = [];
    const hubspot = stubHubspot({
      buscarDealsSinCotizar: async (_desde: Date, _limite: number, tipoRiesgo?: string) => {
        pedidos.push(tipoRiesgo);
        return [];
      },
      ...overrides,
    });
    return { hubspot, pedidos };
  }

  function colaTemporal() {
    return new JobQueue(path.join(os.tmpdir(), `absa-riesgo-${Date.now()}-${Math.random()}.json`));
  }

  it("solo pide los AUTO", async () => {
    const { hubspot, pedidos } = espia();
    await new LeadSweeper({ queue: colaTemporal(), hubspotClient: hubspot as never, tipoRiesgo: "AUTO" }).runOnce();
    expect(pedidos).toEqual(["AUTO"]);
  });

  it("vacio significa sin filtro, para el dia que se cotice otra cosa", async () => {
    const { hubspot, pedidos } = espia();
    await new LeadSweeper({ queue: colaTemporal(), hubspotClient: hubspot as never, tipoRiesgo: "" }).runOnce();
    expect(pedidos).toEqual([""]);
  });
});
