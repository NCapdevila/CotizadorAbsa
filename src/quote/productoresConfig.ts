import fs from "node:fs";
import { z } from "zod";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { normalizarProductor, rankearProductores } from "./productorMatch.js";

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

/** Solo para tests: fuerza a releer el archivo en la proxima llamada. */
export function resetProductoresConfigCache(): void {
  cached = undefined;
}
