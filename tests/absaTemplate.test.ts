import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * `config` se congela al importarse, y `loadComercialTemplate` cachea. Para
 * probar distintos valores de ABSA_ASEGURADORAS_EXCLUIDAS hay que reimportar
 * los dos modulos con el env ya seteado.
 */
async function cargarConTemplate(excluidas: string, plantillaPath: string) {
  vi.resetModules();
  process.env.ABSA_ASEGURADORAS_EXCLUIDAS = excluidas;
  process.env.ABSA_COMERCIAL_TEMPLATE_PATH = plantillaPath;
  const { loadComercialTemplate } = await import("../src/quote/absaTemplate.js");
  return loadComercialTemplate();
}

const PLANTILLA = {
  idOrganizador: 1,
  idUsuario: 1,
  idProductor: 1,
  idConfiguracion: 1,
  comision: 20,
  idTipoPago: 3,
  aseguradoras: [
    { id: 97, nombre: "EXPERTA SEGUROS (P)" },
    { id: 21, nombre: "SANCOR" },
    { id: 2, nombre: "ZURICH" },
    { id: 28, nombre: "GALICIA (Ex SURA)" },
  ],
  camposPorAseguradora: { "Poliza.id_TipoPolizaSancor": 3, "Item.RebajasComerciales[0].Id_Aseguradora": 21 },
};

describe("loadComercialTemplate: exclusion de aseguradoras", () => {
  let plantillaPath: string;
  const envOriginal = { ...process.env };

  beforeEach(() => {
    plantillaPath = path.join(os.tmpdir(), `absa-template-test-${Date.now()}-${Math.random()}.json`);
    fs.writeFileSync(plantillaPath, JSON.stringify(PLANTILLA));
  });

  afterEach(() => {
    fs.rmSync(plantillaPath, { force: true });
    process.env = { ...envOriginal };
    vi.resetModules();
  });

  it("sin exclusiones cotiza todas", async () => {
    const template = await cargarConTemplate("", plantillaPath);
    expect(template.aseguradoras).toHaveLength(4);
  });

  it("excluye por nombre", async () => {
    const template = await cargarConTemplate("SANCOR", plantillaPath);
    expect(template.aseguradoras.map((a) => a.nombre)).toEqual(["EXPERTA SEGUROS (P)", "ZURICH", "GALICIA (Ex SURA)"]);
  });

  it("excluye por id", async () => {
    const template = await cargarConTemplate("21", plantillaPath);
    expect(template.aseguradoras.some((a) => a.id === 21)).toBe(false);
  });

  it("matchea por substring del nombre (no hay que escribirlo entero)", async () => {
    const template = await cargarConTemplate("galicia", plantillaPath);
    expect(template.aseguradoras.some((a) => a.nombre.includes("GALICIA"))).toBe(false);
  });

  it("acepta varias separadas por coma, mezclando nombre e id", async () => {
    const template = await cargarConTemplate("SANCOR, 2", plantillaPath);
    expect(template.aseguradoras.map((a) => a.id).sort((a, b) => a - b)).toEqual([28, 97]);
  });

  it("deja los campos comerciales de la excluida (no adivina de quien es cada campo)", async () => {
    const template = await cargarConTemplate("SANCOR", plantillaPath);
    expect(template.camposPorAseguradora["Poliza.id_TipoPolizaSancor"]).toBe(3);
  });

  it("falla claro si se excluyen todas (si no, el sintoma seria 'ninguna aseguradora cotizo')", async () => {
    await expect(cargarConTemplate("SANCOR,ZURICH,EXPERTA,GALICIA", plantillaPath)).rejects.toThrow(/excluye TODAS/i);
  });
});
