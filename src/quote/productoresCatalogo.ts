import fs from "node:fs";
import path from "node:path";
import * as cheerio from "cheerio";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { CandidatoProductor } from "./productorMatch.js";

/**
 * El catalogo completo de productores: parseo del combo del cotizador y cache
 * en disco.
 *
 * Vive aparte del cliente HTTP porque el parseo es puro (se testea con un
 * recorte de HTML, sin sesion) y porque el cache tiene una razon de negocio,
 * no de performance: conseguir el combo puede costar **crear una cotizacion
 * vacia** en la cuenta del broker (ver `catalogoDeProductores`). Guardarlo un
 * dia hace que eso pase una vez y no una por corrida.
 */

/** 24h: la lista de productores del broker cambia cuando entra o sale una concesionaria. */
const TTL_MS = 24 * 60 * 60 * 1000;

interface CatalogoEnDisco {
  obtenidoEn: string;
  items: CandidatoProductor[];
}

/** Junto a la sesion: mismo directorio, mismo trato (gitignored, es info de la cuenta). */
function rutaCache(): string {
  return path.join(path.dirname(config.ABSA_SESSION_STORE_PATH), "productores-catalogo.json");
}

/**
 * Saca los productores del `<select id="idProductor">` de la pagina del
 * cotizador.
 *
 * Devuelve lista vacia (no error) si el combo no esta: hay cuentas donde el
 * select2 lo llena por busqueda incremental en vez de traerlo renderizado, y
 * ahi el llamador tiene que usar el otro camino. Una sesion vencida cae en el
 * mismo caso — la pagina de login tampoco tiene el combo.
 */
export function parseComboProductores(html: string): CandidatoProductor[] {
  const $ = cheerio.load(html);
  const combo = $("select#idProductor, select[name='Comercial.id_Productor']").first();
  if (combo.length === 0) return [];

  return combo
    .find("option")
    .map((_, option) => ({ value: $(option).attr("value") ?? "", text: $(option).text().trim() }))
    .get()
    .filter((item) => /^\d+$/.test(item.value) && item.text.length > 0);
}

export function leerCatalogoCacheado(): CandidatoProductor[] | null {
  const ruta = rutaCache();
  if (!fs.existsSync(ruta)) return null;

  try {
    const guardado = JSON.parse(fs.readFileSync(ruta, "utf8")) as CatalogoEnDisco;
    const edad = Date.now() - new Date(guardado.obtenidoEn).getTime();
    if (!Number.isFinite(edad) || edad > TTL_MS || !Array.isArray(guardado.items) || guardado.items.length === 0) {
      return null;
    }
    logger.debug({ ruta, productores: guardado.items.length }, "Catalogo de productores leido del cache");
    return guardado.items;
  } catch (err) {
    // Un cache corrupto no puede romper el mapeo: se ignora y se vuelve a pedir.
    logger.warn({ err, ruta }, "No se pudo leer el cache del catalogo de productores, se pide de nuevo");
    return null;
  }
}

export function guardarCatalogoCacheado(items: CandidatoProductor[]): void {
  const ruta = rutaCache();
  try {
    fs.mkdirSync(path.dirname(ruta), { recursive: true });
    const contenido: CatalogoEnDisco = { obtenidoEn: new Date().toISOString(), items };
    fs.writeFileSync(ruta, `${JSON.stringify(contenido, null, 2)}\n`, { mode: 0o600 });
    logger.info({ ruta, productores: items.length }, "Catalogo de productores cacheado");
  } catch (err) {
    // Sin cache el flujo sigue funcionando, solo que la proxima corrida vuelve
    // a pedir la pagina (y quizas a crear una cotizacion vacia).
    logger.warn({ err, ruta }, "No se pudo cachear el catalogo de productores");
  }
}
