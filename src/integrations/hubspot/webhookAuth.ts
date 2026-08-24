import crypto from "node:crypto";
import { config } from "../../config.js";

/**
 * Verificacion simple por secreto compartido (no HMAC): la accion "Enviar un
 * webhook" de un Workflow de HubSpot permite agregar un header custom con un
 * valor fijo, pero no firma el request (a diferencia de una suscripcion de
 * Webhooks API de una app). Guardamos ese mismo valor en
 * HUBSPOT_WEBHOOK_SECRET y lo comparamos en tiempo constante. Ver
 * docs/hubspot-integration.md para como configurar el header en el Workflow.
 *
 * Fail-closed: si HUBSPOT_WEBHOOK_SECRET no esta configurado, se rechaza
 * cualquier request (nunca se acepta un webhook "sin verificar").
 */
export function isValidWebhookSecret(headerValue: string | string[] | undefined): boolean {
  if (!config.HUBSPOT_WEBHOOK_SECRET) return false;
  if (typeof headerValue !== "string" || !headerValue) return false;

  const expected = Buffer.from(config.HUBSPOT_WEBHOOK_SECRET);
  const actual = Buffer.from(headerValue);
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}
