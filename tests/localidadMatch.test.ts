import { describe, expect, it } from "vitest";
import { nombreDeLocalidad, normalizarLocalidad, rankearLocalidades } from "../src/quote/localidadMatch.js";

/**
 * Localidades como las escribe ABSA en el combo. El caso del CP 1849 es el que
 * motivo todo esto: comparten codigo postal y la que corresponde es Claypole,
 * pero alfabeticamente primero viene otra.
 */
const CP_1849 = [
  { value: "2701", text: "(1849) BARRIO PARQUE (Buenos Aires)" },
  { value: "2702", text: "(1849) CLAYPOLE (Buenos Aires)" },
  { value: "2703", text: "(1849) DON ORIONE (Buenos Aires)" },
  { value: "2704", text: "(1849) SAN FRANCISCO SOLANO (Buenos Aires)" },
];

describe("nombreDeLocalidad", () => {
  it("saca el codigo postal del principio y la provincia del final", () => {
    expect(nombreDeLocalidad("(1849) CLAYPOLE (Buenos Aires)")).toBe("CLAYPOLE");
  });

  it("deja los parentesis que son parte del nombre", () => {
    expect(nombreDeLocalidad("(5000) ARGUELLO (NORTE) (Cordoba)")).toBe("ARGUELLO (NORTE)");
  });
});

describe("normalizarLocalidad", () => {
  it("ignora acentos, mayusculas y puntuacion", () => {
    expect(normalizarLocalidad("Bañado de Ovanta")).toBe(normalizarLocalidad("BANADO DE OVANTA"));
    expect(normalizarLocalidad("Gral. Rodríguez")).toBe("GRAL RODRIGUEZ");
  });
});

describe("rankearLocalidades", () => {
  it("elige la que mando el formulario, no la primera alfabeticamente", () => {
    const ranking = rankearLocalidades(CP_1849, "Claypole");
    expect(ranking[0]?.value).toBe("2702");
    expect(ranking[0]?.similitud).toBe(100);
  });

  it("no le importan mayusculas ni acentos", () => {
    expect(rankearLocalidades(CP_1849, "claypole")[0]?.value).toBe("2702");
    expect(rankearLocalidades(CP_1849, "SAN FRANCISCO SOLANO")[0]?.value).toBe("2704");
  });

  it("con nombre de varias palabras, gana la que las tiene todas", () => {
    const ranking = rankearLocalidades(CP_1849, "Don Orione");
    expect(ranking[0]?.value).toBe("2703");
  });

  it("entre dos que matchean todo gana la mas ajustada, no la mas larga", () => {
    const items = [
      { value: "1", text: "(1602) FLORIDA OESTE (Buenos Aires)" },
      { value: "2", text: "(1602) FLORIDA (Buenos Aires)" },
    ];
    expect(rankearLocalidades(items, "Florida")[0]?.value).toBe("2");
    expect(rankearLocalidades(items, "Florida Oeste")[0]?.value).toBe("1");
  });

  it("aguanta que ABSA trunque o abrevie el nombre", () => {
    const items = [
      { value: "1", text: "(1875) WILDE (Buenos Aires)" },
      { value: "2", text: "(1875) BRIO PARQUE (Buenos Aires)" },
    ];
    expect(rankearLocalidades(items, "Barrio Parque")[0]?.value).toBe("2");
  });

  it("si lo pedido no se parece a nada, la similitud es 0 (el llamador cae a la primera)", () => {
    expect(rankearLocalidades(CP_1849, "Rosario")[0]?.similitud).toBe(0);
  });

  it("sin localidad pedida respeta el orden de ABSA y no inventa un parecido", () => {
    const ranking = rankearLocalidades(CP_1849, undefined);
    expect(ranking.map((c) => c.value)).toEqual(["2701", "2702", "2703", "2704"]);
    expect(ranking.every((c) => c.similitud === 0)).toBe(true);
  });
});
