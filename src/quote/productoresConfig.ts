import fs from "node:fs";
import { z } from "zod";
import { config } from "../config.js";
import { logger } from "../logger.js";
import {
  consultasDeProductor,
  normalizarProductor,
  rankearProductores,
  type CandidatoProductor,
} from "./productorMatch.js";

/**
 * Mapeo entre la lista CERRADA de productores del formulario y los IDs reales
 * de ABSA net (config/absa-productores.json).
 *
 * Por que un mapeo a mano y no matcheo por texto en caliente: el productor
 * define el ACUERDO COMERCIAL con el que se cotiza (rebajas, comisiones,
 * aseguradoras habilitadas). Errarle al productor no da un error: da precios
 * de otro acuerdo, que es una falla silenciosa. Con la lista del formulario
 * cerrada, mapear una vez cada opcion a su id de ABSA es exacto por
 * construccion. El parecido (./productorMatch.ts) queda para armar el mapeo
 * (`npm run productores`) y para sugerir en el mensaje de error.
 *
 * El archivo es OPCIONAL: sin el, todo cotiza con el productor de
 * config/absa-comercial.json, que es como venia funcionando hasta ahora.
 */
const entradaSchema = z.object({
  /** `Comercial.id_Productor` en ABSA. Sale de `npm run productores -- --buscar <nombre>`. */
  idProductor: z.number().int().positive(),
  /** Razon social tal cual la escribe ABSA. Solo para logs y para revisar el mapeo a ojo. */
  nombre: z.string().optional(),
  /**
   * `Comercial.id_Configuracion` (la "tarifa" del productor). Opcional: si el
   * productor tiene una sola, ABSA la elige solo y no hace falta escribirla.
   */
  idConfiguracion: z.number().int().positive().optional(),
  /** Nombre de la configuracion (ej. "STD ARDAMA"), para cuando el productor tiene mas de una. */
  configuracion: z.string().optional(),
  /** Otras formas en las que el formulario puede mandar lo mismo ("Ardama 2020", "ARDAMA S.A."). */
  alias: z.array(z.string()).default([]),
  /** Comision a aplicar. Sin esto se usa la que ABSA proponga por default para ese productor. */
  comision: z.number().optional(),
  /**
   * Valores que se pisan sobre lo que ABSA trae por default para este
   * productor (ej. `{"Comercial.RebajaZurich": 30}`).
   *
   * Hace falta porque `ObtenerConfigCotizador` devuelve los defaults del
   * formulario, no lo que el productor elige a mano en la pantalla: las
   * rebajas vienen en 0 y el humano las sube al maximo que le permite el
   * acuerdo. Sin overrides, cotizar por acá daria primas mas caras que
   * cotizando a mano. Los valores validos son las opciones que devuelve el
   * propio ABSA — se validan al resolver la config (ver ./absaComercialClient.ts).
   */
  campos: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});

export type ProductorMapeado = z.infer<typeof entradaSchema> & { clave: string };

const productoresSchema = z.object({
  /**
   * Clave que se usa cuando el lead no trae productor (formularios viejos, el
   * CLI sin `--productor`). Sin esto, un lead sin productor cotiza con el de
   * config/absa-comercial.json.
   */
  defecto: z.string().optional(),
  productores: z.record(z.string(), entradaSchema),
});

export type ProductoresConfig = z.infer<typeof productoresSchema>;

let cached: ProductoresConfig | null | undefined;

/**
 * Carga y valida config/absa-productores.json. Devuelve `null` si el archivo
 * no existe: es opcional a proposito (sin mapeo, se cotiza siempre con el
 * productor de la plantilla comercial, que es el comportamiento historico).
 */
export function loadProductoresConfig(): ProductoresConfig | null {
  if (cached !== undefined) return cached;

  const path = config.ABSA_PRODUCTORES_PATH;
  if (!fs.existsSync(path)) {
    cached = null;
    return cached;
  }

  const raw = JSON.parse(fs.readFileSync(path, "utf8"));
  const parsed = productoresSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Mapeo de productores invalido en "${path}": ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join(", ")}`,
    );
  }

  const { defecto, productores } = parsed.data;
  if (defecto && !productores[defecto]) {
    throw new Error(
      `"${path}": defecto="${defecto}" no existe en "productores" (claves: ${Object.keys(productores).join(", ")}).`,
    );
  }

  cached = parsed.data;
  logger.info(
    { path, productores: Object.keys(productores).length, defecto: defecto ?? "(ninguno)" },
    "Mapeo de productores del formulario cargado",
  );
  return cached;
}

/** Clave de busqueda: lo que mande el formulario tiene que caer en la misma forma que la clave del mapeo. */
function clave(valor: string): string {
  return normalizarProductor(valor);
}

/**
 * Match EXACTO contra el mapeo (clave, alias o razon social), sin caer al
 * productor por defecto ni avisar nada. Es lo que necesita `npm run productores
 * -- --mapear` para saber que entradas ya estaban: con el fallback de
 * `resolverProductor`, todos los nombres del formulario darian "ya mapeado".
 */
export function buscarProductorMapeado(valor: string): ProductorMapeado | undefined {
  const mapeo = loadProductoresConfig();
  if (!mapeo) return undefined;

  const buscado = clave(valor);
  for (const [nombre, entrada] of Object.entries(mapeo.productores)) {
    const candidatos = [nombre, ...entrada.alias, entrada.nombre].filter((v): v is string => Boolean(v));
    if (candidatos.some((c) => clave(c) === buscado)) return { ...entrada, clave: nombre };
  }
  return undefined;
}

/**
 * El valor que mando el formulario -> productor de ABSA.
 *
 * El match tiene que ser EXACTO (contra la clave, los alias o la razon social,
 * sin distinguir mayusculas ni acentos). No hay matcheo por parecido: elegir
 * "el mas parecido" cuando la lista del formulario y la de ABSA no coinciden
 * es como se termina cotizando con el acuerdo comercial del de al lado.
 *
 * Sin valor, o con un valor que no esta mapeado, **se cotiza con el productor
 * `defecto`** (hoy ARDAMA) en vez de fallar. Es una decision de negocio: entre
 * no cotizar un lead y cotizarlo con la cuenta general, se prefiere lo segundo
 * — el lead se atiende igual y la cotizacion queda guardada en ABSA para que
 * la levante un vendedor. Queda el warning en el log para poder completar el
 * mapeo despues (`npm run productores -- --buscar <nombre>`).
 */
export function resolverProductor(valor: string | undefined): ProductorMapeado | undefined {
  const mapeo = loadProductoresConfig();
  const pedido = valor?.trim();
  const porDefecto = () =>
    mapeo?.defecto ? { ...mapeo.productores[mapeo.defecto]!, clave: mapeo.defecto } : undefined;

  if (!pedido) return porDefecto();

  const exacto = buscarProductorMapeado(pedido);
  if (exacto) return exacto;

  const defecto = porDefecto();
  // Los mas parecidos DEL MAPEO (no del catalogo de ABSA, que necesitaria una
  // sesion): es lo que hace falta para decidir que entrada agregar.
  const sugerencias = rankearProductores(
    Object.entries(mapeo?.productores ?? {}).map(([nombre, entrada]) => ({
      value: String(entrada.idProductor),
      text: entrada.nombre ? `${nombre} (${entrada.nombre})` : nombre,
    })),
    pedido,
  )
    .filter((c) => c.similitud > 0)
    .slice(0, 3)
    .map((c) => `${c.text} [${c.similitud}%]`);

  logger.warn(
    { productor: pedido, sugerencias, seCotizaCon: defecto?.clave ?? "la plantilla comercial" },
    "El productor del lead no esta mapeado: se cotiza con el productor por defecto",
  );
  return defecto;
}

/**
 * Busca en el catalogo REAL de ABSA (`/Combo/GetProductoresIncremental`).
 * Se inyecta para poder testear la regla de decision sin una sesion viva.
 */
export type BuscadorDeProductores = (query: string) => Promise<CandidatoProductor[]>;

/** Lo ya resuelto contra ABSA en este proceso: un productor del formulario se repite en cada lead. */
const resueltosEnAbsa = new Map<string, ProductorMapeado | null>();

/**
 * El valor del formulario -> productor de ABSA, con el catalogo en vivo como
 * segunda oportunidad.
 *
 * Orden: mapeo exacto (instantaneo y exacto por construccion) -> busqueda en
 * ABSA -> productor por defecto. La busqueda existe porque el mapeo se arma a
 * mano y siempre va atrasado: cuando entra una concesionaria nueva al
 * formulario, sus leads cotizaban con ARDAMA hasta que alguien se acordara de
 * agregarla (caso real: "NFR MOTORS", que existe en ABSA con id 11795).
 *
 * **Solo se acepta un match INEQUIVOCO**: exactamente un candidato al 100%.
 * No es una formalidad, es lo unico que hace segura esta busqueda — errarle al
 * productor no da un error, da precios de otro acuerdo comercial sin ningun
 * sintoma. Los numeros reales de ABSA muestran por que el umbral es ese:
 *
 *   "NFR MOTORS" -> 1 al 100%   -> NFR MOTORS (11795)           se acepta
 *   "Car West"   -> 2 al 100%   -> CAR WEST C / CAR, WEST M     ambiguo, NO
 *   "Motors"     -> 36 al 100%                                  ambiguo, NO
 *
 * Ante cualquier duda se cae al productor por defecto, que es el
 * comportamiento de antes. Un match en vivo NO trae los overrides del mapeo
 * (`campos`): cotiza con lo que ABSA propone por default para ese productor,
 * que es correcto pero mas caro que con las rebajas negociadas a mano. Por eso
 * el log pide igual que se agregue la entrada al mapeo.
 */
export async function resolverProductorConCatalogo(
  valor: string | undefined,
  buscar: BuscadorDeProductores,
): Promise<ProductorMapeado | undefined> {
  const pedido = valor?.trim();
  if (!pedido) return resolverProductor(valor);

  const exacto = buscarProductorMapeado(pedido);
  if (exacto) return exacto;

  const clave = normalizarProductor(pedido);
  if (!resueltosEnAbsa.has(clave)) {
    resueltosEnAbsa.set(clave, await buscarEnAbsa(pedido, buscar));
  }
  const enAbsa = resueltosEnAbsa.get(clave);
  if (enAbsa) return enAbsa;

  // Ni mapeado ni inequivoco en ABSA: el camino de siempre (default + warning).
  return resolverProductor(valor);
}

async function buscarEnAbsa(pedido: string, buscar: BuscadorDeProductores): Promise<ProductorMapeado | null> {
  let candidatos: CandidatoProductor[];
  try {
    const vistos = new Map<string, CandidatoProductor>();
    for (const query of consultasDeProductor(pedido)) {
      for (const item of await buscar(query)) {
        if (!vistos.has(item.value)) vistos.set(item.value, item);
      }
    }
    candidatos = [...vistos.values()];
  } catch (err) {
    // Que falle la busqueda no puede frenar la cotizacion: se sigue por el
    // camino de siempre (productor por defecto).
    logger.warn({ err, productor: pedido }, "No se pudo buscar el productor en el catalogo de ABSA, se sigue con el mapeo");
    return null;
  }

  const exactos = rankearProductores(candidatos, pedido).filter((c) => c.similitud === 100);
  if (exactos.length !== 1) {
    if (exactos.length > 1) {
      logger.warn(
        { productor: pedido, empatados: exactos.slice(0, 4).map((c) => `${c.text} (${c.value})`) },
        "El productor del lead matchea varios de ABSA por igual: no se elige ninguno (elegir mal = cotizar con otro acuerdo comercial)",
      );
    }
    return null;
  }

  const elegido = exactos[0]!;
  const idProductor = Number(elegido.value);
  if (!Number.isInteger(idProductor) || idProductor <= 0) return null;

  logger.warn(
    { productor: pedido, idProductor, nombre: elegido.text },
    "Productor no mapeado pero encontrado en ABSA sin ambiguedad: se cotiza con el suyo. Agregarlo a config/absa-productores.json para poder ponerle rebajas propias",
  );
  return { clave: pedido, idProductor, nombre: elegido.text, alias: [] };
}

/** Solo para tests: fuerza a releer el archivo en la proxima llamada. */
export function resetProductoresConfigCache(): void {
  cached = undefined;
  resueltosEnAbsa.clear();
}
