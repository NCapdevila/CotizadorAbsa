import fs from "node:fs";
import { z } from "zod";
import { config } from "../config.js";
import { logger } from "../logger.js";

/**
 * Config comercial del broker en ABSA net: rebajas, clausulas de ajuste,
 * tipo de poliza por aseguradora (ver docs/absa-endpoints.md seccion 3).
 * Esto es configuracion de CUENTA del broker, no datos de la cotizacion
 * individual -- por eso vive en un archivo de config separado
 * (config/absa-comercial.json, gitignored) y no en CotizacionInput.
 */
const aseguradoraSchema = z.object({
  id: z.number().int(),
  nombre: z.string(),
});

const templateSchema = z.object({
  idOrganizador: z.number().int(),
  idUsuario: z.number().int(),
  idProductor: z.number().int(),
  idConfiguracion: z.number().int(),
  comision: z.number(),
  idTipoPago: z.number().int(),
  aseguradoras: z.array(aseguradoraSchema).min(1),
  camposPorAseguradora: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
});

export type AbsaComercialTemplate = z.infer<typeof templateSchema>;

let cached: AbsaComercialTemplate | null = null;

/**
 * Carga y valida config/absa-comercial.json (o la ruta que indique
 * ABSA_COMERCIAL_TEMPLATE_PATH). Falla rapido y con mensaje claro si no
 * existe -- ver el README (seccion "Archivos de config") para el formato.
 */
export function loadComercialTemplate(): AbsaComercialTemplate {
  if (cached) return cached;

  const path = config.ABSA_COMERCIAL_TEMPLATE_PATH;
  if (!fs.existsSync(path)) {
    throw new Error(
      `No se encontro el archivo de config comercial en "${path}". ` +
        "Se genera con `npm run discovery:comercial` a partir de un HAR de una cotizacion " +
        "real, o se copia de otra maquina (ver el README, seccion \"Archivos de config\").",
    );
  }

  const raw = JSON.parse(fs.readFileSync(path, "utf8"));
  const parsed = templateSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Config comercial invalida en "${path}": ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`,
    );
  }

  cached = { ...parsed.data, aseguradoras: aplicarExclusiones(parsed.data.aseguradoras) };
  return cached;
}

/**
 * Saca de la lista las aseguradoras de `ABSA_ASEGURADORAS_EXCLUIDAS`.
 *
 * Sirve para dejar de cotizar una compañia sin tocar nada en ABSA net (la
 * configuracion del portal queda como esta) y sin editar
 * config/absa-comercial.json, que se regenera con `npm run discovery:comercial`.
 *
 * Cada token matchea por id exacto ("21") o por nombre: alcanza con que el
 * nombre del catalogo lo contenga, para no tener que escribir
 * "GALICIA (Ex SURA)" entero. Los campos comerciales de la aseguradora
 * excluida se dejan en `camposPorAseguradora`: son inofensivos si esa
 * compañia no esta en la lista, y sacarlos requeriria adivinar que campo es
 * de quien.
 */
function aplicarExclusiones(aseguradoras: AbsaComercialTemplate["aseguradoras"]): AbsaComercialTemplate["aseguradoras"] {
  const tokens = config.ABSA_ASEGURADORAS_EXCLUIDAS.split(",")
    .map((t) => t.trim().toUpperCase())
    .filter(Boolean);
  if (tokens.length === 0) return aseguradoras;

  const excluida = (a: { id: number; nombre: string }) =>
    tokens.some((token) => token === String(a.id) || a.nombre.toUpperCase().includes(token));

  const quedan = aseguradoras.filter((a) => !excluida(a));
  const sacadas = aseguradoras.filter(excluida);

  // Un token que no matchea nada casi siempre es un typo, y el sintoma seria
  // "sigue cotizando la que quise sacar" — mejor decirlo.
  const sinMatch = tokens.filter((token) => !aseguradoras.some((a) => token === String(a.id) || a.nombre.toUpperCase().includes(token)));
  if (sinMatch.length > 0) {
    logger.warn({ sinMatch }, "ABSA_ASEGURADORAS_EXCLUIDAS tiene valores que no matchean ninguna aseguradora de la plantilla");
  }

  if (quedan.length === 0) {
    throw new Error(
      `ABSA_ASEGURADORAS_EXCLUIDAS="${config.ABSA_ASEGURADORAS_EXCLUIDAS}" excluye TODAS las aseguradoras de la plantilla: ` +
        "no queda ninguna para cotizar.",
    );
  }
  if (sacadas.length > 0) {
    logger.info(
      { excluidas: sacadas.map((a) => a.nombre), cotizan: quedan.length },
      "Aseguradoras excluidas por configuracion local (no se toca la config de ABSA net)",
    );
  }
  return quedan;
}
