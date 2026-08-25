import { describe, expect, it } from "vitest";
import { formatearResultado } from "../src/quote/resultadoConsola.js";
import type { CotizacionResult } from "../src/quote/types.js";

/** Recorte de una corrida real: dos aseguradoras, coberturas mezcladas y dos fallos. */
const RESULT: CotizacionResult = {
  ok: true,
  numeroCotizacion: "41322632",
  opciones: [
    { plan: "ZURICH - D1 - Fcia 1%", cobertura: "D1 - Fcia 1%", premio: 1132470, moneda: "ARS" },
    { plan: "EXPERTA SEGUROS (P) - XL TC", cobertura: "XL TC", premio: 534660, moneda: "ARS" },
    { plan: "ZURICH - RESP. CIVIL", cobertura: "RESP. CIVIL", premio: 248490, moneda: "ARS" },
    { plan: "EXPERTA SEGUROS (P) - ROBO E INCENDIO", cobertura: "ROBO E INCENDIO", premio: 182184, moneda: "ARS" },
  ],
  rawAbsaResponse: { fallos: ["BARBUSS (ex HDI): Error al Cotizar", "FEDERACION: Error al Cotizar"] },
  obtenidoEn: "2026-08-25T00:00:00.000Z",
};

describe("formatearResultado", () => {
  const salida = formatearResultado(RESULT);
  const lineas = salida.split("\n");

  it("encabeza con el numero de cotizacion y cuanto trajo", () => {
    expect(lineas[0]).toContain("Cotizacion 41322632");
    expect(lineas[0]).toContain("2 aseguradoras");
    expect(lineas[0]).toContain("4 coberturas");
  });

  it("agrupa por aseguradora en vez de mezclar todo en una lista plana", () => {
    expect(salida).toContain("   EXPERTA SEGUROS (P)");
    expect(salida).toContain("   ZURICH");
    // La cobertura va sola: la aseguradora ya es el titulo del bloque.
    expect(salida).toContain("XL TC");
    expect(salida).not.toContain("EXPERTA SEGUROS (P) - XL TC");
  });

  it("ordena las aseguradoras por su cobertura mas barata", () => {
    // EXPERTA arranca en 182.184 y ZURICH en 248.490.
    expect(salida.indexOf("EXPERTA SEGUROS (P)")).toBeLessThan(salida.indexOf("ZURICH"));
  });

  it("dentro de cada aseguradora ordena por premio", () => {
    const zurich = lineas.slice(lineas.findIndex((l) => l.trim() === "ZURICH"));
    expect(zurich[1]).toContain("RESP. CIVIL");
    expect(zurich[2]).toContain("D1 - Fcia 1%");
  });

  it("junta las que no cotizaron por motivo, en vez de repetir el mismo texto", () => {
    expect(salida).toContain("Sin cotizacion (2):");
    expect(salida).toContain("BARBUSS (ex HDI), FEDERACION: Error al Cotizar");
  });

  it("no imprime la seccion de fallos cuando cotizaron todas", () => {
    const sinFallos = formatearResultado({ ...RESULT, rawAbsaResponse: {} });
    expect(sinFallos).not.toContain("Sin cotizacion");
  });

  it("aguanta un resultado sin numero y sin opciones sin romper", () => {
    const vacio = formatearResultado({ ...RESULT, numeroCotizacion: undefined, opciones: [], rawAbsaResponse: {} });
    expect(vacio).toContain("(sin numero)");
    expect(vacio).toContain("0 aseguradoras");
  });
});
