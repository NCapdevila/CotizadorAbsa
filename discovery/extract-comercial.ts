/**
 * Fase 0.5 — Extraccion de la config comercial de cuenta desde un HAR real.
 *
 * `parse-har.ts` no sirve para esto: solo sabe hacer "shape" de bodies JSON, y
 * el POST de cotizacion de ABSA net es form-urlencoded (~140 campos), asi que
 * lo descarta como "<non-JSON body>".
 *
 * Este script toma el POST real a /AutoCotizador/Cotizar/{id} del HAR y separa
 * sus campos en dos grupos:
 *
 *   - Campos POR COTIZACION (cliente, vehiculo, domicilio, fechas, tokens):
 *     los arma `src/quote/mapper.ts` en cada llamada. Se DESCARTAN aca — ademas
 *     de ser inutiles como config, los `Cliente.*` / `DomicilioRiesgo.*` son
 *     PII de la persona que se uso para capturar.
 *   - Todo el resto = configuracion comercial de CUENTA del broker (rebajas,
 *     clausulas de ajuste, tipo de poliza por aseguradora). Eso es lo que va a
 *     config/absa-comercial.json.
 *
 * Ademas reporta candidatos a endpoint de "guardar cotizacion", que todavia no
 * esta implementado (ver docs/absa-endpoints.md).
 *
 * Uso:
 *   npm run discovery:comercial            # usa el .har mas reciente
 *   npm run discovery:comercial -- foo.har
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, "output");
const CONFIG_PATH = path.join(__dirname, "..", "config", "absa-comercial.json");

interface HarEntry {
  request: {
    method: string;
    url: string;
    postData?: { mimeType?: string; text?: string; params?: { name: string; value: string }[] };
  };
  response: { status: number; content?: { mimeType?: string; size?: number } };
}

/**
 * Campos que `toAbsaCotizarPayload` arma por cotizacion. No son config de
 * cuenta: o dependen del cliente/vehiculo, o son tokens/IDs de la operacion.
 */
const PER_QUOTE_EXACT = new Set([
  "__RequestVerificationToken",
  "id_Organizador", "id_Usuario", "id_Aseguradora", "id_Riesgo", "id_Operacion",
  "id_Entity", "NroCotizacion", "NroCotizacionAnalisis", "NroPolizaRenovada",
  "EsRecotizacion", "EsRecotizacionAnalisis", "EsRenovacion", "AccionCotizar",
  "Comercial.Comision", "ComisionPoliza", "Comercial.ConfigCotizacion.ComisionOrg",
  "Comercial.id_TipoPago", "Comercial.id_Productor", "Comercial.id_Configuracion",
  "Item.id_Vehiculo", "Item.id_MarcaVehiculo", "Item.id_ModeloVehiculo",
  "Item.id_OrigenVehiculo", "Item.VersionVehiculo", "Item.SumaAsegurada",
  "Item.InfoAuto", "Item.Anio", "Item.id_UsoVehiculo", "Item.id_FormaRastreo",
  "Poliza.FechaInicioVigencia", "CotizacionGuardada",
  // Confirmados en la captura real: campos espejo del cliente que el JS de
  // ABSA agrega al form. Vinieron vacios en esa captura, pero llevan el
  // documento de la persona cotizada -- nunca deben caer en la config.
  "HiddenDNICliente", "HiddenCUITCliente", "AnioRecotizacion",
]);
const PER_QUOTE_PREFIXES = ["Cliente.", "DomicilioRiesgo.", "Comercial.ConfigCotizacion.Aseguradoras["];

/**
 * Red de seguridad contra PII: si ABSA agrega en el futuro otro campo espejo
 * con datos de la persona (paso exactamente eso con HiddenDNICliente), que no
 * termine en un archivo de config de cuenta solo porque no estaba en la lista.
 * Ante la duda se descarta: perder un campo comercial es recuperable, filtrar
 * el documento de un cliente a un archivo de config no.
 */
const PII_PATTERN = /dni|cuit|cuil|documento|apellido|nombrecliente|fechanacimiento|telefono|celular|mail|email|patente/i;

function isPerQuote(key: string): boolean {
  if (PER_QUOTE_EXACT.has(key)) return true;
  if (PER_QUOTE_PREFIXES.some((p) => key.startsWith(p))) return true;
  // `Comercial.FechaNacimientoConductor*` es config de cuenta (perfil de
  // conductor del acuerdo), no la fecha del cliente cotizado: se conserva.
  if (PII_PATTERN.test(key) && !key.startsWith("Comercial.FechaNacimientoConductor")) return true;
  return false;
}

/** Devuelve los pares del body preservando repetidos (ej. `item.Checked` viene N veces). */
function bodyPairs(entry: HarEntry): Array<[string, string]> {
  const pd = entry.request.postData;
  if (!pd) return [];
  if (pd.params?.length) {
    return pd.params.map((p) => [p.name, safeDecode(p.value ?? "")] as [string, string]);
  }
  if (!pd.text) return [];
  return [...new URLSearchParams(pd.text).entries()];
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
}

/** Numero si el string es numerico puro, booleano si es true/false, string si no. */
function coerce(value: string): string | number | boolean {
  if (value === "") return "";
  if (/^(true|false)$/i.test(value)) return value.toLowerCase() === "true";
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

function findLatestHar(): string {
  if (!fs.existsSync(OUTPUT_DIR)) {
    throw new Error(`No existe ${OUTPUT_DIR}. Corre primero: npm run discovery:capture`);
  }
  const files = fs
    .readdirSync(OUTPUT_DIR)
    .filter((f) => f.endsWith(".har"))
    .map((f) => ({ f, mtime: fs.statSync(path.join(OUTPUT_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (files.length === 0) throw new Error(`No hay .har en ${OUTPUT_DIR}. Corre primero: npm run discovery:capture`);
  return files[0]!.f;
}

function main() {
  const argFile = process.argv[2];
  const harFile = argFile ?? findLatestHar();
  const harPath = path.isAbsolute(harFile) ? harFile : path.join(OUTPUT_DIR, harFile);
  if (!fs.existsSync(harPath)) throw new Error(`No existe: ${harPath}`);

  const har = JSON.parse(fs.readFileSync(harPath, "utf8")) as { log: { entries: HarEntry[] } };
  const entries = har.log.entries;
  console.log(`HAR: ${path.basename(harPath)} (${entries.length} requests)\n`);

  // El POST de cotizacion con MAS campos es el que trae la config completa
  // (una recotizacion parcial puede mandar menos).
  const cotizarPosts = entries
    .filter((e) => e.request.method === "POST" && /\/AutoCotizador\/Cotizar\//i.test(e.request.url))
    .map((e) => ({ entry: e, pairs: bodyPairs(e) }))
    .sort((a, b) => b.pairs.length - a.pairs.length);

  if (cotizarPosts.length === 0) {
    console.error("No se encontro ningun POST a /AutoCotizador/Cotizar/ en el HAR.");
    console.error("Revisa que la captura incluya una cotizacion de AUTOS completa (no solo el login).");
    process.exit(1);
  }

  const { entry, pairs } = cotizarPosts[0]!;
  console.log(`POST de cotizacion elegido: ${entry.request.url}`);
  console.log(`  campos en el body: ${pairs.length}  (de ${cotizarPosts.length} POST(s) de cotizacion en el HAR)\n`);

  const flat = new Map<string, string>();
  const repeated = new Map<string, number>();
  for (const [k, v] of pairs) {
    if (flat.has(k)) repeated.set(k, (repeated.get(k) ?? 1) + 1);
    else flat.set(k, v);
  }

  // Aseguradoras seleccionadas: array indexado en el body.
  const aseguradoras: Array<{ id: number; nombre: string }> = [];
  for (const [k, v] of flat) {
    const m = k.match(/^Comercial\.ConfigCotizacion\.Aseguradoras\[(\d+)\]\.id_Aseguradora$/);
    if (!m) continue;
    const nombre = flat.get(`Comercial.ConfigCotizacion.Aseguradoras[${m[1]}].Aseguradora`) ?? "";
    aseguradoras.push({ id: Number(v), nombre });
  }

  const camposPorAseguradora: Record<string, string | number | boolean> = {};
  for (const [k, v] of flat) {
    if (isPerQuote(k)) continue;
    camposPorAseguradora[k] = coerce(v);
  }

  const num = (key: string): number => Number(flat.get(key) ?? 0);
  const template = {
    _comment:
      `Generado por discovery/extract-comercial.ts desde ${path.basename(harPath)} el ${new Date().toISOString()}. ` +
      "Valores REALES del acuerdo comercial de esta cuenta de broker. Gitignored -- tratar como info de negocio.",
    idOrganizador: num("id_Organizador"),
    idUsuario: num("id_Usuario"),
    idProductor: num("Comercial.id_Productor"),
    idConfiguracion: num("Comercial.id_Configuracion"),
    comision: num("Comercial.Comision"),
    idTipoPago: num("Comercial.id_TipoPago"),
    aseguradoras,
    camposPorAseguradora,
  };

  if (fs.existsSync(CONFIG_PATH)) {
    const backup = `${CONFIG_PATH}.bak-${Date.now()}`;
    fs.copyFileSync(CONFIG_PATH, backup);
    console.log(`Ya existia config/absa-comercial.json -> backup en ${path.basename(backup)}`);
  }
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(template, null, 2), { mode: 0o600 });

  console.log("Escrito: config/absa-comercial.json");
  console.log(
    `  idOrganizador=${template.idOrganizador} idUsuario=${template.idUsuario} ` +
      `idProductor=${template.idProductor} idConfiguracion=${template.idConfiguracion}`,
  );
  console.log(`  comision=${template.comision} idTipoPago=${template.idTipoPago}`);
  console.log(`  aseguradoras: ${aseguradoras.length}`);
  for (const a of aseguradoras) console.log(`    - ${a.id} ${a.nombre}`);
  console.log(`  camposPorAseguradora: ${Object.keys(camposPorAseguradora).length}`);

  if (repeated.size > 0) {
    console.log("\nOJO -- campos repetidos en el body real (URLSearchParams.set() del mapper NO los reproduce):");
    for (const [k, n] of repeated) console.log(`    ${k} x${n}`);
  }

  const idEntity = flat.get("id_Entity");
  if (idEntity) console.log(`\nid_Entity observado en esta captura: ${idEntity}`);

  // --- Candidatos a "guardar cotizacion" (todavia no implementado) ---
  const SAVE_PATTERN = /guardar|grabar|save|confirmar|emitir/i;
  const saveCandidates = entries.filter(
    (e) =>
      e.request.method === "POST" &&
      SAVE_PATTERN.test(e.request.url) &&
      !/\/AutoCotizador\/Cotizar\//i.test(e.request.url),
  );
  console.log(`\n=== Candidatos a endpoint de GUARDAR cotizacion (${saveCandidates.length}) ===`);
  if (saveCandidates.length === 0) {
    console.log("Ninguno matcheo los patrones conocidos. Si guardaste la cotizacion durante la");
    console.log("captura, el endpoint tiene otro nombre -- abajo van TODOS los POST del HAR:");
    for (const e of entries.filter((x) => x.request.method === "POST")) {
      console.log(`  POST ${new URL(e.request.url).pathname}  -> ${e.response.status} ${e.response.content?.mimeType ?? ""}`);
    }
  } else {
    for (const e of saveCandidates) {
      const p = bodyPairs(e);
      console.log(`\n  POST ${e.request.url}`);
      console.log(`    status ${e.response.status} ${e.response.content?.mimeType ?? ""}`);
      console.log(`    campos del body (${p.length}):`);
      for (const [k, v] of p) {
        const shown = /pass|token|secret/i.test(k) ? "<REDACTED>" : v.slice(0, 60);
        console.log(`      ${k} = ${shown}`);
      }
    }
  }
  console.log("\nListo. Revisá config/absa-comercial.json antes de cotizar (nunca se commitea).");
}

main();
