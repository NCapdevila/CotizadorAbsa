import pino from "pino";
import { config } from "./config.js";

/**
 * Serializador de errores.
 *
 * Motivo: `got` adjunta a cada error un objeto `options` completo que incluye
 * el **cookie jar entero y el header `cookie` ya armado**. Un solo
 * `logger.warn({ err }, ...)` sobre un timeout volcaba a stdout la cookie de
 * sesion viva de ABSA (`.AspNet.ApplicationCookie`), que alcanza para entrar a
 * la cuenta sin usuario ni password. Las reglas de `redact` de abajo no lo
 * cubrian: los paths reales estan varios niveles adentro
 * (`err.options.cookieJar.cookies[]`, `err.options.headers.cookie`) y los
 * comodines de pino matchean un solo nivel.
 *
 * Por eso este serializador es allowlist, no denylist: se queda solo con lo que
 * sirve para diagnosticar y descarta todo lo demas. Si `got` agrega mañana otro
 * campo con material sensible, no se filtra por default.
 *
 * Exportado para poder testearlo directo (ver tests/logger.test.ts).
 */
export function serializeError(err: unknown): unknown {
  if (!(err instanceof Error)) return err;
  const e = err as Error & Record<string, any>;

  const out: Record<string, unknown> = {
    type: e.name,
    message: e.message,
    stack: e.stack,
  };
  if (e["code"]) out["code"] = e["code"];

  // De got solo interesa a que endpoint le pegabamos y como respondio.
  const url = e["options"]?.url ?? e["request"]?.options?.url;
  if (url) out["url"] = String(url);
  const method = e["options"]?.method;
  if (method) out["method"] = method;
  const statusCode = e["response"]?.statusCode;
  if (statusCode) out["statusCode"] = statusCode;

  // Errores de dominio (BusinessValidationError, UpstreamChangedError) traen
  // `detalles`/`rawResponse` con la respuesta de ABSA: util para diagnosticar,
  // pero puede ser un HTML enorme, asi que se recorta.
  for (const key of ["detalles", "rawResponse"]) {
    const value = e[key];
    if (value === undefined) continue;
    const asText = typeof value === "string" ? value : JSON.stringify(value);
    out[key] = asText && asText.length > 800 ? `${asText.slice(0, 800)}... <recortado>` : value;
  }

  return out;
}

/**
 * Logger estructurado. La primera linea de defensa es `serializeError` (arriba);
 * `redact` queda como segunda barrera para objetos que se loguean a mano.
 */
export const logger = pino({
  level: config.LOG_LEVEL,
  serializers: { err: serializeError, error: serializeError },
  redact: {
    paths: [
      "password",
      "*.password",
      "*.ABSA_PASSWORD",
      "cookie",
      "cookies",
      "*.cookie",
      "*.cookies",
      "cookieJar",
      "*.cookieJar",
      "headers.cookie",
      "headers.Cookie",
      "headers['set-cookie']",
      "headers.authorization",
      "headers.Authorization",
      "sessionArtifact",
      "*.sessionArtifact",
      "cookieJarJson",
      "*.cookieJarJson",
      "*.token",
      "*.sessionToken",
      "__RequestVerificationToken",
      "*.__RequestVerificationToken",
    ],
    censor: "<REDACTED>",
  },
  formatters: {
    level(label) {
      return { level: label };
    },
  },
});

export type Logger = typeof logger;
