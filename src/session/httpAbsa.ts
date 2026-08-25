/**
 * El cliente HTTP que usa TODO lo que le pega a ABSA net.
 *
 * Existe por dos motivos, los dos aprendidos en produccion el 2026-08-24:
 *
 * 1. **ABSA filtra por lista blanca de IPs.** Desde una IP no habilitada corta
 *    con 403 antes de ver las credenciales. Si el servidor no esta habilitado,
 *    `ABSA_PROXY_URL` permite sacar el trafico por una IP que si lo este (ej.
 *    un tunel SSH contra la oficina) sin tocar el resto del codigo.
 * 2. **Los headers de navegador** (ver ./headers.ts) tienen que ir en todas
 *    las requests, no solo en el login.
 *
 * Centralizar el cliente evita el problema obvio: con `got` importado en cada
 * archivo, agregar un proxy significaba tocar catorce llamadas y olvidarse de
 * una — y una sola request saliendo por la IP equivocada rompe el flujo igual.
 *
 * Con `ABSA_PROXY_URL` vacio (el default) esto es exactamente `got` sin
 * modificar: no hay agente, no hay cambio de comportamiento. Sacar la variable
 * es el rollback completo.
 */
import got, { type Got } from "got";
import { SocksProxyAgent } from "socks-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";
import { config } from "../config.js";
import { logger } from "../logger.js";

/** Oculta usuario:contraseña si el proxy los lleva en la URL (esto se loguea). */
function sinCredenciales(url: string): string {
  return url.replace(/\/\/[^@/]*@/, "//***@");
}

/**
 * Agente para el proxy configurado, o `undefined` si no hay proxy.
 * Acepta `socks5://host:puerto` (lo que da un tunel SSH con `-R`/`-D`) y
 * `http://host:puerto` / `https://...` para proxies HTTP clasicos.
 */
export function crearAgenteProxy(proxyUrl: string) {
  const url = proxyUrl.trim();
  if (!url) return undefined;

  const agente = url.startsWith("socks") ? new SocksProxyAgent(url) : new HttpsProxyAgent(url);
  return { http: agente, https: agente };
}

const agent = crearAgenteProxy(config.ABSA_PROXY_URL);

if (agent) {
  logger.info(
    { proxy: sinCredenciales(config.ABSA_PROXY_URL) },
    "Trafico a ABSA net saliendo por proxy (ABSA_PROXY_URL)",
  );
}

/** `got` con el proxy aplicado, si lo hay. Usar SIEMPRE este en vez de `got` pelado. */
export const httpAbsa: Got = agent ? got.extend({ agent }) : got;
