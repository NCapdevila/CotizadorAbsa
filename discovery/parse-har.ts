/**
 * Fase 0.4 — Parseo de HAR.
 *
 * Lee un .har capturado con capture-har.ts y extrae, con heuristicas:
 *   - Candidatos a request de login (URL/body sugiere auth) y que cookies
 *     o tokens aparecen en la respuesta.
 *   - Candidatos a endpoint(s) de cotizacion (URL/body sugiere cotizar).
 *   - Headers / tokens adicionales requeridos por request (CSRF, nonce).
 *
 * Genera dos salidas:
 *   1. discovery/output/<nombre>.summary.json — extracto REDACTADO
 *      (nombres de campos y "shape" de los valores, no los valores reales)
 *      para revisión rápida.
 *   2. docs/absa-endpoints.generated.md — template pre-rellenado a partir del
 *      summary, para que un humano lo revise y vuelque lo util en el doc
 *      curado (docs/absa-endpoints.md), que este script NO toca.
 *
 * Esto es un punto de partida heurístico, no un parser definitivo: ABSA net
 * puede no calzar con estos patrones (por ejemplo si el login es SSO). Revisar
 * siempre el HAR a mano si el resultado automático no tiene sentido.
 *
 * Uso:
 *   npm run discovery:parse -- <nombre-del-archivo.har>
 *   (si no se pasa nombre, usa el .har mas reciente en discovery/output/)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, "output");
/**
 * OJO: este script GENERA un template de placeholders. `docs/absa-endpoints.md`
 * es documentacion curada a mano (secciones 0-7, incluido el catalogo de
 * vehiculos de la seccion 3.1) y sostiene buena parte de src/ -- si lo
 * pisaramos con el template, perderiamos todo lo aprendido en Fase 0. Por eso
 * la salida va a un archivo aparte y NUNCA se sobrescribe el doc curado.
 */
const DOCS_PATH = path.join(__dirname, "..", "docs", "absa-endpoints.generated.md");

const SENSITIVE_HEADER_NAMES = new Set([
  "cookie",
  "set-cookie",
  "authorization",
  "x-csrf-token",
  "x-xsrf-token",
  "x-auth-token",
]);
const SENSITIVE_KEY_PATTERN = /pass|pwd|token|secret|auth|dni|cuit|cbu|tarjeta|card/i;
const AUTH_URL_PATTERN = /login|signin|sign-in|auth|account\/logon|session/i;
const QUOTE_URL_PATTERN = /cotiza|quote|presupuest|premio/i;

interface HarEntry {
  request: {
    method: string;
    url: string;
    headers: { name: string; value: string }[];
    postData?: { mimeType?: string; text?: string };
  };
  response: {
    status: number;
    headers: { name: string; value: string }[];
    content?: { mimeType?: string; text?: string };
  };
}

interface Har {
  log: { entries: HarEntry[] };
}

function redactHeaders(headers: { name: string; value: string }[]) {
  return headers.map((h) => ({
    name: h.name,
    value: SENSITIVE_HEADER_NAMES.has(h.name.toLowerCase()) ? "<REDACTED>" : h.value,
  }));
}

/** Convierte un valor JSON en su "shape": tipo de cada campo, sin valores reales. */
function shapeOf(value: unknown, keyHint = ""): unknown {
  if (SENSITIVE_KEY_PATTERN.test(keyHint)) return "<REDACTED:" + typeof value + ">";
  if (Array.isArray(value)) {
    return value.length > 0 ? [shapeOf(value[0], keyHint)] : [];
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = shapeOf(v, k);
    }
    return out;
  }
  if (typeof value === "string") return `string(len=${value.length})`;
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (value === null) return "null";
  return typeof value;
}

function tryParseJson(text: string | undefined): unknown | null {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function summarizeEntry(entry: HarEntry) {
  const reqBodyJson = tryParseJson(entry.request.postData?.text);
  const resBodyJson = tryParseJson(entry.response.content?.text);
  const setCookies = entry.response.headers.filter((h) => h.name.toLowerCase() === "set-cookie");

  return {
    method: entry.request.method,
    url: entry.request.url,
    requestHeaders: redactHeaders(entry.request.headers),
    requestBodyMimeType: entry.request.postData?.mimeType ?? null,
    requestBodyShape: reqBodyJson
      ? shapeOf(reqBodyJson)
      : entry.request.postData?.text
        ? "<non-JSON body, ver HAR crudo>"
        : null,
    responseStatus: entry.response.status,
    setsCookies: setCookies.map((c) => c.value.split("=")[0]), // solo el nombre de la cookie
    responseBodyShape: resBodyJson ? shapeOf(resBodyJson) : null,
  };
}

function findLatestHar(): string {
  const files = fs
    .readdirSync(OUTPUT_DIR)
    .filter((f) => f.endsWith(".har"))
    .map((f) => ({ f, mtime: fs.statSync(path.join(OUTPUT_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (files.length === 0) {
    throw new Error(`No hay archivos .har en ${OUTPUT_DIR}. Corre primero npm run discovery:capture.`);
  }
  return files[0]!.f;
}

function main() {
  const argFile = process.argv[2];
  const harFile = argFile ?? findLatestHar();
  const harPath = path.isAbsolute(harFile) ? harFile : path.join(OUTPUT_DIR, harFile);

  if (!fs.existsSync(harPath)) {
    throw new Error(`No existe: ${harPath}`);
  }

  const har: Har = JSON.parse(fs.readFileSync(harPath, "utf8"));
  const entries = har.log.entries;

  const authCandidates = entries.filter(
    (e) => AUTH_URL_PATTERN.test(e.request.url) && (e.request.method === "POST" || e.request.method === "GET"),
  );
  const quoteCandidates = entries.filter((e) => QUOTE_URL_PATTERN.test(e.request.url));
  const cookieSetters = entries.filter((e) =>
    e.response.headers.some((h) => h.name.toLowerCase() === "set-cookie"),
  );

  const summary = {
    harFile: path.basename(harPath),
    totalEntries: entries.length,
    authCandidates: authCandidates.map(summarizeEntry),
    quoteCandidates: quoteCandidates.map(summarizeEntry),
    entriesThatSetCookies: cookieSetters.map(summarizeEntry),
  };

  const summaryPath = harPath.replace(/\.har$/, ".summary.json");
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  console.log(`Summary (redactado) escrito en: ${summaryPath}`);

  writeDocsTemplate(summary);
  console.log(`Template de docs generado/actualizado en: ${DOCS_PATH}`);
  console.log("");
  console.log("Revisalo a mano: las heuristicas de URL pueden traer falsos positivos/negativos.");
  console.log("Si login o cotizacion no aparecen, abri el .har con Chrome DevTools (Network > Import HAR) y buscá manualmente.");
}

interface DiscoverySummary {
  harFile: string;
  totalEntries: number;
  authCandidates: unknown[];
  quoteCandidates: unknown[];
  entriesThatSetCookies: unknown[];
}

function writeDocsTemplate(summary: DiscoverySummary) {
  const md = `# ABSA net — endpoints descubiertos (Fase 0)

> Generado automaticamente por \`discovery/parse-har.ts\` a partir de \`${summary.harFile}\`.
> Los valores reales fueron REDACTADOS. Este archivo es un punto de partida:
> revisar, corregir y completar a mano antes de usarlo como base de la Fase 1/2.
>
> Fecha de generacion: ${new Date().toISOString()}
> Total de requests en el HAR: ${summary.totalEntries}

## 1. Login

**TODO humano:** confirmar cual de los candidatos abajo es el login real, y si
es form POST tradicional, SPA con JSON, o si hay SSO/2FA/captcha de por medio.

\`\`\`json
${JSON.stringify(summary.authCandidates, null, 2)}
\`\`\`

## 2. Identificacion de sesion

**TODO humano:** de los requests que setean cookies, indicar cual es la cookie
de sesion real (nombre) y si ademas hace falta un header/token adicional.

\`\`\`json
${JSON.stringify(summary.entriesThatSetCookies, null, 2)}
\`\`\`

## 3. Endpoint(s) de cotizacion

**TODO humano:** confirmar URL, metodo, y estructura real del payload/response
(los "shapes" de abajo muestran nombres de campo y tipos, no valores).

\`\`\`json
${JSON.stringify(summary.quoteCandidates, null, 2)}
\`\`\`

## 4. Tokens adicionales por request (CSRF / nonce)

**TODO humano:** completar si aparecio algun header tipo \`X-CSRF-Token\`,
campo hidden en el HTML, o nonce que haya que reenviar en cada request.

## 5. Duracion de sesion / expiracion

**TODO humano:** completar una vez que se observe un 401/403 o redirect a
login por sesion vencida. Anotar el patron exacto (status code, header,
body, o redirect) que indica "sesion vencida" para que el Session Manager
lo pueda detectar.

## 6. Protecciones anti-bot

**TODO humano:** anotar si aparecio captcha, WAF, fingerprinting, o bloqueo
por rate/IP durante el login o la cotizacion.
`;
  fs.mkdirSync(path.dirname(DOCS_PATH), { recursive: true });
  fs.writeFileSync(DOCS_PATH, md);
}

main();
