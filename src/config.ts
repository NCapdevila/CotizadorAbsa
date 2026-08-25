import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  ABSA_USER: z.string().min(1, "ABSA_USER es requerido"),
  ABSA_PASSWORD: z.string().min(1, "ABSA_PASSWORD es requerido"),
  ABSA_BASE_URL: z.string().url().default("https://www.absanet.net"),
  ABSA_SESSION_STORE_PATH: z.string().default(".session/absa-session.json"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error", "silent"])
    .default("info"),
  ABSA_MIN_REQUEST_INTERVAL_MS: z.coerce.number().int().nonnegative().default(1500),
  ABSA_MAX_RETRIES: z.coerce.number().int().nonnegative().default(1),
  ABSA_COMERCIAL_TEMPLATE_PATH: z.string().default("config/absa-comercial.json"),
  /**
   * Mapeo entre la lista cerrada de productores del formulario y los IDs de
   * ABSA (formato en el README, seccion "Archivos de config"). Opcional: sin
   * este archivo todo cotiza con el productor de la plantilla comercial.
   */
  ABSA_PRODUCTORES_PATH: z.string().default("config/absa-productores.json"),
  /**
   * Cuanto se cachea la config comercial que ABSA devuelve por productor
   * (rebajas, aseguradoras habilitadas, comision). Son tres requests por
   * productor y cambia muy de vez en cuando — el default de 6h evita pagarlas
   * en cada lead sin quedarse pegado a una config vieja por dias.
   */
  ABSA_CONFIG_COMERCIAL_TTL_MS: z.coerce.number().int().nonnegative().default(6 * 60 * 60 * 1000),
  /**
   * Aseguradoras a NO cotizar, separadas por coma (por nombre o por id, ej.
   * "SANCOR" o "21"). Se filtran de la plantilla comercial al cargarla.
   *
   * Va como env var y no editando config/absa-comercial.json a mano porque ese
   * archivo se regenera con `npm run discovery:comercial` — una exclusion
   * escrita ahi se pierde en la proxima extraccion.
   */
  ABSA_ASEGURADORAS_EXCLUIDAS: z.string().default(""),
  /**
   * Proxy por el que sale TODO el trafico hacia ABSA net. Vacio = conexion
   * directa (el default).
   *
   * ABSA filtra por lista blanca de IPs: si el servidor no esta habilitado,
   * esto permite salir por una que si lo este (ej. `socks5://127.0.0.1:1080`
   * apuntando a un tunel SSH contra la oficina). Ver docs/deploy.md.
   */
  ABSA_PROXY_URL: z.string().default(""),

  // --- Integracion HubSpot (Fase 6, ver docs/hubspot-integration.md) ---
  /** Token de la Private App de HubSpot (scopes: crm.objects.deals.*, crm.objects.contacts.read, crm.schemas.deals.read). Vacio = integracion HubSpot deshabilitada. */
  HUBSPOT_ACCESS_TOKEN: z.string().default(""),
  /** Valor compartido que el Workflow de HubSpot manda en un header custom (ver docs/hubspot-integration.md) para que el webhook pueda verificar que la request vino de HubSpot y no de un tercero. */
  HUBSPOT_WEBHOOK_SECRET: z.string().default(""),
  HUBSPOT_API_BASE_URL: z.string().url().default("https://api.hubapi.com"),
  /** Mapeo de nombres internos de propiedades custom de Deal (formato en el README, seccion "Archivos de config"). */
  HUBSPOT_PROPERTIES_PATH: z.string().default("config/hubspot-properties.json"),
  /**
   * Si se adjunta al Deal el PDF de la cotizacion (la impresion de ABSA).
   *
   * Default OFF: la cotizacion automatica es orientativa (el estado civil se
   * asume, la version se elige por parecido), y un PDF con formato de
   * cotizacion formal en el Deal se lee como definitivo. Se prende cuando los
   * datos del formulario alcancen para que la impresion sea fiel.
   *
   * `z.enum` y no `z.coerce.boolean()` a proposito: con coerce, el string
   * "false" es truthy y la variable no apagaria nada.
   */
  HUBSPOT_ADJUNTAR_PDF: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /** Donde persiste la cola de leads pendientes de cotizar (contiene PII de leads — gitignored). */
  QUEUE_STORE_PATH: z.string().default(".queue/leads.json"),
  /** Cada cuanto el worker revisa la cola por jobs pendientes. */
  QUEUE_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(15000),
  /** Reintentos por job antes de marcarlo como fallido definitivo (aparte de los reintentos internos de sesion/negocio de QuoteClient). */
  QUEUE_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),
});

/**
 * Config centralizada, validada una sola vez al importar este modulo.
 * Si falta una env var requerida, el proceso falla rapido y con un mensaje
 * claro en vez de fallar mas tarde con un error críptico de red.
 */
function loadConfig() {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(
      `Configuracion invalida. Revisa tu .env (lista de variables en el README):\n${issues}`,
    );
  }
  return parsed.data;
}

export const config = loadConfig();

export type Config = typeof config;
