import fs from "node:fs";
import * as cheerio from "cheerio";
import { z } from "zod";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { UpstreamChangedError } from "./errors.js";

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
export function aplicarExclusiones(aseguradoras: AbsaComercialTemplate["aseguradoras"]): AbsaComercialTemplate["aseguradoras"] {
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

/**
 * ============================================================================
 * Config comercial POR PRODUCTOR, leida en vivo de ABSA net.
 *
 * El archivo de arriba (config/absa-comercial.json) es la config de UN
 * productor: el que estaba seleccionado cuando se capturo el HAR. Cotizar para
 * otro productor con esos valores da precios del acuerdo comercial equivocado
 * (ver docs/absa-endpoints.md seccion 3.3).
 *
 * Lo que hace el portal al cambiar el productor (Scripts/Cotizador/Autos/productor.js):
 *
 *   1. GET /Combo/GetConfiguracionesWS   -> repuebla `Comercial.id_Configuracion`
 *   2. GET /Data/GetPaquetesComision     -> repuebla `Comercial.Comision`
 *   3. GET /AutoCotizador/ObtenerConfigCotizador -> reemplaza ENTERO el bloque
 *      #condicionesAseguradoras: la lista de aseguradoras y los ~45 campos
 *      Comercial.* / Poliza.* / Item.RebajasComerciales[*]
 *
 * Este modulo parsea el HTML del punto 3; las tres requests las hace
 * ./absaComercialClient.ts.
 * ============================================================================
 */

/** Una opcion de un `<select>` del bloque de condiciones (para validar overrides y mostrarlas al operador). */
export interface OpcionCampo {
  value: string;
  text: string;
}

export interface CondicionesAseguradoras {
  /** Aseguradoras habilitadas para ese productor, en el orden en que las manda ABSA. */
  aseguradoras: AbsaComercialTemplate["aseguradoras"];
  /** Todos los campos del bloque con el valor que el navegador mandaria sin tocar nada. */
  campos: Record<string, string>;
  /** Valores validos de cada campo que sea un `<select>`. Vacio para inputs libres. */
  opciones: Record<string, OpcionCampo[]>;
}

const CAMPO_ASEGURADORA = /^Comercial\.ConfigCotizacion\.Aseguradoras\[(\d+)\]\.(id_Aseguradora|Aseguradora)$/;

/**
 * Parsea el HTML de `ObtenerConfigCotizador` (`{ Estado, View }`) al mismo
 * shape que hoy tiene la plantilla de archivo.
 *
 * Reproduce lo que mandaria el navegador con ese HTML recien cargado:
 *
 * - `<select>`: la opcion con `selected`; si no hay ninguna, la primera (que es
 *   lo que submitea un form real).
 * - `<input type=checkbox>`: `value` si viene `checked`, si no "false" (ASP.NET
 *   MVC renderea un hidden con "false" al lado, que aca se ignora para no
 *   pisar al checkbox).
 * - Nombres repetidos: gana el primero. Pasa de verdad con
 *   `Comercial.PlanAsegFedPat`, que son DOS selects distintos con el mismo
 *   name; el navegador manda los dos valores, y la plantilla de archivo manda
 *   solo el primero desde siempre — Federacion cotiza igual en produccion.
 *
 * OJO con el HTML de ABSA: los campos traen el name real en `Name=` (mayuscula)
 * y ademas un `name=` (minuscula) con un id corto. Como HTML no distingue
 * mayusculas en los atributos, el parser se queda con el primero, que es el
 * que sirve. Si algun dia ABSA invierte ese orden, el sintoma seria un payload
 * con `id_Aseguradora` en vez de `Comercial.ConfigCotizacion.Aseguradoras[0].id_Aseguradora`.
 */
export function parseCondicionesAseguradoras(html: string): CondicionesAseguradoras {
  const $ = cheerio.load(html);
  const campos: Record<string, string> = {};
  const opciones: Record<string, OpcionCampo[]> = {};
  const aseguradorasPorIndice: Array<{ id?: number; nombre?: string }> = [];

  $("input, select, textarea").each((_, el) => {
    const $el = $(el);
    const name = $el.attr("name");
    if (!name) return;

    const tag = (el as { tagName?: string }).tagName?.toLowerCase();
    let valor: string | undefined;

    if (tag === "select") {
      const seleccionada = $el.find("option[selected]").first();
      const opcion = seleccionada.length > 0 ? seleccionada : $el.find("option").first();
      valor = opcion.attr("value") ?? "";
      if (!opciones[name]) {
        opciones[name] = $el
          .find("option")
          .map((__, o) => ({ value: $(o).attr("value") ?? "", text: $(o).text().trim() }))
          .get();
      }
    } else if (tag === "textarea") {
      valor = $el.text();
    } else {
      const tipo = ($el.attr("type") ?? "text").toLowerCase();
      if (tipo === "checkbox") {
        valor = $el.attr("checked") !== undefined ? ($el.attr("value") ?? "true") : "false";
      } else if (tipo === "radio") {
        if ($el.attr("checked") === undefined) return;
        valor = $el.attr("value") ?? "";
      } else {
        // El hidden que MVC pone al lado de cada checkbox comparte el name: no
        // tiene que pisar el valor real del checkbox.
        if (tipo === "hidden" && name in campos) return;
        valor = $el.attr("value") ?? "";
      }
    }

    const aseguradora = name.match(CAMPO_ASEGURADORA);
    if (aseguradora) {
      const i = Number(aseguradora[1]);
      aseguradorasPorIndice[i] ??= {};
      if (aseguradora[2] === "id_Aseguradora") aseguradorasPorIndice[i]!.id = Number(valor);
      else aseguradorasPorIndice[i]!.nombre = valor;
      return;
    }

    if (name in campos) return; // nombre repetido: gana el primero
    campos[name] = valor ?? "";
  });

  const aseguradoras = aseguradorasPorIndice
    .filter((a): a is { id: number; nombre: string } => Number.isFinite(a?.id) && a?.nombre !== undefined)
    .map((a) => ({ id: a.id, nombre: a.nombre }));

  if (aseguradoras.length === 0) {
    throw new UpstreamChangedError(
      "El bloque de condiciones de ABSA no trajo ninguna aseguradora " +
        "(se esperaban inputs Comercial.ConfigCotizacion.Aseguradoras[i].id_Aseguradora). " +
        "Puede ser un productor sin aseguradoras habilitadas, o un cambio en ABSA net.",
      html.slice(0, 500),
    );
  }

  return { aseguradoras, campos, opciones };
}

export interface ArmarTemplateOpciones {
  /** La plantilla de archivo: aporta lo que es de la CUENTA (organizador, usuario, tipo de pago). */
  base: AbsaComercialTemplate;
  idProductor: number;
  idConfiguracion: number;
  comision: number;
  condiciones: CondicionesAseguradoras;
  /** Lo que el negocio elige a mano dentro de lo que ABSA permite (rebajas, beneficios). */
  overrides?: Record<string, string | number | boolean>;
}

/**
 * Arma la plantilla comercial de un productor combinando las tres fuentes:
 * cuenta (archivo) + lo que ABSA devuelve para ESE productor + los overrides
 * del mapeo.
 *
 * Los overrides que no son una opcion valida del `<select>` correspondiente se
 * avisan por log pero se mandan igual: ABSA es la autoridad final y un select
 * puede depender de otro campo (ej. las franquicias de Federacion dependen del
 * vehiculo, y en este HTML llegan vacias).
 */
export function armarTemplateComercial(opts: ArmarTemplateOpciones): AbsaComercialTemplate {
  const { base, condiciones, overrides = {} } = opts;

  const camposPorAseguradora: Record<string, string | number | boolean> = { ...condiciones.campos };
  for (const [campo, valor] of Object.entries(overrides)) {
    const validas = condiciones.opciones[campo];
    if (validas && validas.length > 0 && !validas.some((o) => o.value === String(valor))) {
      logger.warn(
        { campo, valor, validas: validas.map((o) => o.value) },
        "Override del mapeo de productores que no es una opcion valida de ABSA para este productor: se manda igual",
      );
    }
    camposPorAseguradora[campo] = valor;
  }

  return {
    idOrganizador: base.idOrganizador,
    idUsuario: base.idUsuario,
    idTipoPago: base.idTipoPago,
    idProductor: opts.idProductor,
    idConfiguracion: opts.idConfiguracion,
    comision: opts.comision,
    aseguradoras: aplicarExclusiones(condiciones.aseguradoras),
    camposPorAseguradora,
  };
}
