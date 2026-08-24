import { describe, expect, it } from "vitest";
import {
  consultasDeBusqueda,
  hayVersionEnLaBusqueda,
  normalizarDescripcion,
  rankearCandidatos,
} from "../src/quote/vehicleVersionMatch.js";
import type { VehiculoInput } from "../src/quote/types.js";

/**
 * Descripciones REALES del catalogo de ABSA, copiadas de la respuesta de
 * `/Combo/GetVehiculos?q=fiat argo` de la captura de Fase 0 (incluye la marca
 * repetida, los sufijos "L/21" de año de linea, el espacio de mas al final y
 * los otros modelos que ABSA cuela porque matchean por substring: "UNO CARGO"
 * y "DUCATO ... MAXICARGO" contienen "ARGO").
 */
const ARGO = [
  { text: "FIAT - FIAT - ARGO 1.3 DRIVE CVT L/26", value: "170908" },
  { text: "FIAT - FIAT - ARGO 1.3 DRIVE MT L/25", value: "170893" },
  { text: "FIAT - FIAT - ARGO 1.8 PRECISION PK PREMIUM L/21", value: "170842" },
  { text: "FIAT - FIAT - ARGO 1.8 PRECISION PK PREMIUM AT L/21 ", value: "170841" },
  { text: "FIAT - FIAT - ARGO 1.8 PRECISION L/21", value: "170840" },
  { text: "FIAT - FIAT - ARGO 1.8 HGT L/21", value: "170839" },
  { text: "FIAT - FIAT - ARGO 1.3 DRIVE GSE PK CONECTIVI. L/21", value: "170838" },
  { text: "FIAT - FIAT - ARGO 1.8 PRECISION PK PREMIUM AT", value: "170822" },
  { text: "FIAT - FIAT - ARGO 1.8 PRECISION TECHNOLOGY AUT", value: "170821" },
  { text: "FIAT - FIAT - ARGO 1.8 PRECISION PK PREMIUM", value: "170820" },
  { text: "FIAT - FIAT - ARGO 1.8 PRECISION TECHNOLOGY", value: "170819" },
  { text: "FIAT - FIAT - DUCATO 2.3 TD MAXICARGO L4H2 TA", value: "170817" },
  { text: "FIAT - FIAT - ARGO 1.3 DRIVE GSE PK CONECTIVIDAD", value: "170809" },
  { text: "FIAT - FIAT - ARGO 1.3 PRECISION TECHNOLOGY AT", value: "170808" },
  { text: "FIAT - FIAT - ARGO 1.3 PRECISION PREMIUM AT", value: "170807" },
  { text: "FIAT - FIAT - ARGO 1.3 PRECISION PREMIUM", value: "170806" },
  { text: "FIAT - FIAT - ARGO 1.3 PRECISION TECHNOLOGY", value: "170805" },
  { text: "FIAT - FIAT - ARGO 1.8 HGT", value: "170796" },
  { text: "FIAT - FIAT - ARGO 1.8 PRECISION AT", value: "170795" },
  { text: "FIAT - FIAT - ARGO 1.8 PRECISION", value: "170794" },
  { text: "FIAT - FIAT - ARGO 1.3 DRIVE GSE", value: "170793" },
  { text: "FIAT - FIAT - UNO CARGO 1.3 FIRE AA", value: "170629" },
];

/** Mismo estilo de escritura del catalogo, para el caso que disparo todo esto. */
const TRACKER = [
  { text: "CHEVROLET - CHEVROLET - TRACKER 1.2 TURBO AT6 L/24", value: "125001" },
  { text: "CHEVROLET - CHEVROLET - TRACKER 1.2 TURBO AT6", value: "120588" },
  { text: "CHEVROLET - CHEVROLET - TRACKER 1.2 TURBO AT6 PREMIER", value: "120590" },
  { text: "CHEVROLET - CHEVROLET - TRACKER 1.2 TURBO MT6 LT", value: "120585" },
  { text: "CHEVROLET - CHEVROLET - TRACKER 1.8 LTZ AT", value: "110220" },
];

function ganador(candidatos: Array<{ text: string; value: string }>, vehiculo: VehiculoInput) {
  return rankearCandidatos(candidatos, vehiculo)[0]!;
}

describe("normalizarDescripcion", () => {
  it("traduce como escribe la marca a como escribe ABSA", () => {
    expect(normalizarDescripcion("1.2T AT Premier")).toBe("1.2 TURBO AT PREMIER");
    expect(normalizarDescripcion("2.0 TDI A/T")).toBe("2.0 TDI AT");
    expect(normalizarDescripcion("1,6 16V")).toBe("1.6 16V");
  });

  it("descarta el año de linea, que no es parte de la version", () => {
    expect(normalizarDescripcion("ARGO 1.8 PRECISION L/21")).toBe("ARGO 1.8 PRECISION");
  });

  it("saca acentos sin partir la palabra en dos", () => {
    expect(normalizarDescripcion("ALLURÉ PLUS")).toBe("ALLURE PLUS");
  });
});

describe("rankearCandidatos", () => {
  it("elige la version exacta y no la primera de la lista (el caso Tracker)", () => {
    // ABSA devuelve 120588 ("TRACKER 1.2 TURBO AT6") primera por ser el
    // InfoAuto mas nuevo; la del cliente es la PREMIER.
    const elegida = ganador(TRACKER, { marca: "CHEVROLET", modelo: "TRACKER 1.2T AT PREMIER", anio: 2021 });
    expect(elegida.value).toBe("120590");
    expect(elegida.text).toContain("PREMIER");
    expect(elegida.similitud).toBe(100);
  });

  it("da lo mismo escribir la version en --modelo o en --version", () => {
    const pegado = ganador(TRACKER, { marca: "CHEVROLET", modelo: "TRACKER 1.2T AT PREMIER", anio: 2021 });
    const aparte = ganador(TRACKER, { marca: "CHEVROLET", modelo: "TRACKER", version: "1.2 turbo premier at6", anio: 2021 });
    expect(aparte.value).toBe(pegado.value);
  });

  it("prefiere la version justa antes que una que agrega equipamiento", () => {
    const conPlus = [...TRACKER, { text: "CHEVROLET - CHEVROLET - TRACKER 1.2 TURBO AT6 PREMIER PLUS", value: "120591" }];
    const elegida = ganador(conPlus, { marca: "CHEVROLET", modelo: "TRACKER", version: "1.2T AT PREMIER", anio: 2021 });
    expect(elegida.value).toBe("120590");
  });

  it("la cilindrada manda: no cotiza una 1.8 cuando se pidio una 1.3", () => {
    const elegida = ganador(ARGO, { marca: "FIAT", modelo: "ARGO", version: "1.3 PRECISION PREMIUM AT", anio: 2022 });
    expect(elegida.value).toBe("170807");
    expect(elegida.text).toContain("1.3 PRECISION PREMIUM AT");
  });

  it("distingue automatica de manual", () => {
    const automatica = ganador(ARGO, { marca: "FIAT", modelo: "ARGO", version: "1.8 PRECISION AT", anio: 2022 });
    const manual = ganador(ARGO, { marca: "FIAT", modelo: "ARGO", version: "1.8 PRECISION", anio: 2022 });
    expect(automatica.text).toContain("1.8 PRECISION AT");
    expect(manual.text.replace(/L\/\d+/, "").trim()).toMatch(/1\.8 PRECISION$/);
  });

  it("entiende los sinonimos de caja automatica (AUT, AT6, AUTOMATICA)", () => {
    const elegida = ganador(ARGO, {
      marca: "FIAT",
      modelo: "ARGO 1.8 PRECISION TECHNOLOGY AUTOMATICA",
      anio: 2021,
    });
    expect(elegida.value).toBe("170821");
    expect(elegida.text).toContain("TECHNOLOGY AUT");
  });

  it("aguanta las descripciones truncadas de ABSA (CONECTIVI. = CONECTIVIDAD)", () => {
    const ranking = rankearCandidatos(ARGO, {
      marca: "FIAT",
      modelo: "ARGO",
      version: "1.3 DRIVE GSE PK CONECTIVIDAD",
      anio: 2021,
    });
    expect(ranking.slice(0, 2).map((c) => c.value).sort()).toEqual(["170809", "170838"]);
  });

  it("manda al fondo los otros modelos que ABSA cuela por matchear por substring", () => {
    const ranking = rankearCandidatos(ARGO, { marca: "FIAT", modelo: "ARGO", version: "1.8 PRECISION", anio: 2022 });
    const posicionDucato = ranking.findIndex((c) => c.text.includes("DUCATO"));
    expect(posicionDucato).toBeGreaterThan(ranking.length - 3);
  });

  it("desempata por año de linea: la misma version aparece una vez por linea", () => {
    // Descripciones reales del catalogo: la version del cliente esta tres
    // veces, cambiando solo el L/xx. Para un auto 2021, la linea 2025 no puede
    // ser (y probarla cuesta una request de GetAniosVehiculo al pedo).
    const lineas = [
      { text: "CHEVROLET - CHEVROLET - TRACKER 1.2 TURBO PREMIER AT6 L/25", value: "120653" },
      { text: "CHEVROLET - CHEVROLET - TRACKER 1.2 TURBO PREMIER AT6 L/22", value: "120620" },
      { text: "CHEVROLET - CHEVROLET - TRACKER 1.2 TURBO PREMIER AT6", value: "120586" },
    ];
    const de2021 = rankearCandidatos(lineas, { marca: "CHEVROLET", modelo: "TRACKER", version: "1.2T AT PREMIER", anio: 2021 });
    expect(de2021.map((c) => c.value)).toEqual(["120586", "120620", "120653"]);

    const de2023 = rankearCandidatos(lineas, { marca: "CHEVROLET", modelo: "TRACKER", version: "1.2T AT PREMIER", anio: 2023 });
    expect(de2023[0]!.value).toBe("120620");
  });

  it("explica por que un candidato perdio", () => {
    const ranking = rankearCandidatos(TRACKER, { marca: "CHEVROLET", modelo: "TRACKER", version: "1.2T AT PREMIER", anio: 2021 });
    const sinPremier = ranking.find((c) => c.value === "120588")!;
    expect(sinPremier.faltantes).toContain("PREMIER");
    expect(sinPremier.coincidencias).toEqual(expect.arrayContaining(["1.2", "TURBO", "AT"]));
  });

  it("sin version pedida no inventa un orden: los deja como los mando ABSA", () => {
    const vehiculo: VehiculoInput = { marca: "CHEVROLET", modelo: "TRACKER", anio: 2021 };
    expect(hayVersionEnLaBusqueda(vehiculo)).toBe(false);
    const ranking = rankearCandidatos(TRACKER, vehiculo);
    expect(ranking.map((c) => c.value)).toEqual(TRACKER.map((c) => c.value));
    expect(ranking.every((c) => c.similitud === 0)).toBe(true);
  });

  it("detecta que hay version pedida aunque venga pegada al modelo", () => {
    expect(hayVersionEnLaBusqueda({ marca: "CHEVROLET", modelo: "TRACKER 1.2T", anio: 2021 })).toBe(true);
    expect(hayVersionEnLaBusqueda({ marca: "CHEVROLET", modelo: "TRACKER", version: "PREMIER", anio: 2021 })).toBe(true);
    // Un modelo de varias palabras no es una version.
    expect(hayVersionEnLaBusqueda({ marca: "VOLKSWAGEN", modelo: "GOL TREND", anio: 2021 })).toBe(false);
  });
});

describe("consultasDeBusqueda", () => {
  it("busca amplio por marca/modelo y despues refina con la version", () => {
    expect(consultasDeBusqueda({ marca: "CHEVROLET", modelo: "TRACKER 1.2T AT PREMIER", anio: 2021 })).toEqual([
      "CHEVROLET TRACKER",
      "CHEVROLET TRACKER 1.2 TURBO AT PREMIER",
    ]);
  });

  it("no corta modelos de varias palabras", () => {
    expect(consultasDeBusqueda({ marca: "VOLKSWAGEN", modelo: "GOL TREND", anio: 2021 })).toEqual(["VOLKSWAGEN GOL TREND"]);
  });

  it("sin version hace una sola consulta (no gasta requests de mas contra ABSA)", () => {
    expect(consultasDeBusqueda({ marca: "FIAT", modelo: "ARGO", anio: 2022 })).toEqual(["FIAT ARGO"]);
  });
});
