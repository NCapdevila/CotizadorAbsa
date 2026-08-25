import type { CotizacionOpcion, CotizacionResult } from "./types.js";

/**
 * El resultado de una cotizacion, listo para imprimir en la terminal.
 *
 * Vive aparte del CLI para poder probar el formato sin cotizar: como es lo
 * unico que el operador ve de una corrida de 3 minutos, que se lea bien no es
 * cosmetico.
 *
 * Agrupado por aseguradora y no como una lista plana ordenada por premio: la
 * lista plana engaña, porque la opcion mas barata suele ser un "robo e incendio
 * en garage" al lado de un todo riesgo, y el primer renglon parecia la mejor
 * oferta cuando en realidad es la que menos cubre. Por compañia, cada bloque
 * compara coberturas comparables, y el orden entre bloques (por la mas barata
 * de cada una) sigue respondiendo "quien esta mas barato".
 */
export function formatearResultado(result: CotizacionResult): string {
  const fmt = new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 });
  const fallos = (result.rawAbsaResponse as { fallos?: string[] })?.fallos ?? [];
  const lineas: string[] = [];

  const grupos = agruparPorAseguradora(result.opciones);
  lineas.push(
    `Cotizacion ${result.numeroCotizacion ?? "(sin numero)"}  ·  ` +
      `${grupos.length} ${grupos.length === 1 ? "aseguradora" : "aseguradoras"}  ·  ` +
      `${result.opciones.length} ${result.opciones.length === 1 ? "cobertura" : "coberturas"}`,
  );

  for (const [aseguradora, opciones] of grupos) {
    lineas.push("", `   ${aseguradora}`);
    for (const o of opciones) {
      lineas.push(`   ${fmt.format(o.premio).padStart(14)}   ${o.cobertura || o.plan}`);
    }
  }

  if (fallos.length > 0) {
    // Sin esto, una aseguradora que no cotizo se lee como "no tiene precio",
    // cuando lo que paso es que fallo la request o la rechazo ella.
    lineas.push("", `   Sin cotizacion (${fallos.length}):`);
    for (const [motivo, aseguradoras] of agruparPorMotivo(fallos)) {
      lineas.push(`      ${aseguradoras.join(", ")}${motivo ? `: ${motivo}` : ""}`);
    }
  }

  return lineas.join("\n");
}

/**
 * Los fallos vienen como "ASEGURADORA: motivo" y el motivo se repite: en una
 * corrida real, cuatro companias devolvieron "Error al Cotizar" y la linea era
 * el mismo texto cuatro veces. Se agrupan por motivo para que se lea de un
 * vistazo cuales no cotizaron y por que.
 */
function agruparPorMotivo(fallos: string[]): Array<[string, string[]]> {
  const porMotivo = new Map<string, string[]>();
  for (const fallo of fallos) {
    const corte = fallo.indexOf(": ");
    const aseguradora = corte > 0 ? fallo.slice(0, corte) : fallo;
    const motivo = corte > 0 ? fallo.slice(corte + 2).trim() : "";
    if (!porMotivo.has(motivo)) porMotivo.set(motivo, []);
    porMotivo.get(motivo)!.push(aseguradora);
  }
  return [...porMotivo.entries()];
}

/**
 * `plan` viene como "ASEGURADORA - COBERTURA" (ver parseCotizacionPropuestaHtml).
 * Los grupos salen ordenados por su opcion mas barata, y adentro por premio.
 */
function agruparPorAseguradora(opciones: CotizacionOpcion[]): Array<[string, CotizacionOpcion[]]> {
  const porAseguradora = new Map<string, CotizacionOpcion[]>();
  for (const o of opciones) {
    const corte = o.plan.indexOf(" - ");
    const aseguradora = corte > 0 ? o.plan.slice(0, corte).trim() : o.plan.trim();
    if (!porAseguradora.has(aseguradora)) porAseguradora.set(aseguradora, []);
    porAseguradora.get(aseguradora)!.push(o);
  }

  return [...porAseguradora.entries()]
    .map(([aseguradora, lista]) => [aseguradora, [...lista].sort((a, b) => a.premio - b.premio)] as [string, CotizacionOpcion[]])
    .sort((a, b) => a[1][0]!.premio - b[1][0]!.premio);
}
