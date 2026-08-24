/**
 * Punto de entrada publico para usar este repo como libreria (Fase 3,
 * modo "funcion importable"). El agente de Ninjo importa `cotizar` y los
 * tipos de ./quote/types.ts — nunca necesita saber de cookies, sesiones,
 * ni del formato interno de ABSA net.
 *
 * Ver src/api/server.ts para la alternativa "endpoint HTTP".
 */
import { config } from "./config.js";
import { SessionManager } from "./session/sessionManager.js";
import { SessionStore } from "./session/sessionStore.js";
import { HttpFormAuthStrategy } from "./session/authStrategies.js";
import { QuoteClient } from "./quote/quoteClient.js";
import type { CotizacionInput, CotizacionResult } from "./quote/types.js";

export type { CotizacionInput, CotizacionResult, AseguradoInput, VehiculoInput, CoberturaInput, Ramo } from "./quote/types.js";
export { SessionExpiredError, BusinessValidationError, UpstreamChangedError, TransientError } from "./quote/errors.js";
export { SessionManager } from "./session/sessionManager.js";
export { QuoteClient } from "./quote/quoteClient.js";
export { SessionStore } from "./session/sessionStore.js";
export { HttpFormAuthStrategy, PlaywrightAuthStrategy } from "./session/authStrategies.js";

let defaultClient: QuoteClient | null = null;

function getDefaultClient(): QuoteClient {
  if (defaultClient) return defaultClient;

  const sessionManager = new SessionManager({
    credentials: { user: config.ABSA_USER, password: config.ABSA_PASSWORD },
    authStrategy: new HttpFormAuthStrategy(),
    store: new SessionStore(config.ABSA_SESSION_STORE_PATH),
  });
  defaultClient = new QuoteClient(sessionManager);
  return defaultClient;
}

/**
 * Cotiza en ABSA net usando las credenciales de ABSA_USER/ABSA_PASSWORD
 * (env vars). Maneja login, renovacion de sesion y reintentos
 * internamente — devuelve directo el resultado normalizado.
 */
export async function cotizar(input: CotizacionInput): Promise<CotizacionResult> {
  return getDefaultClient().cotizar(input);
}
