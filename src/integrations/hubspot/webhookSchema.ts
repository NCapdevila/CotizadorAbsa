import { z } from "zod";

/**
 * Validacion del body del webhook. Solo `dealId` es estrictamente requerido
 * a este nivel (es el Deal existente donde hay que escribir el resultado) —
 * la falta de datos de negocio (marca/modelo/dni/etc) se detecta mas
 * adelante en hubspotPayloadToCotizacionInput y se reporta como
 * BusinessValidationError (queda registrado en el Deal en vez de rechazar
 * el webhook con un 400).
 */
export const hubspotLeadWebhookSchema = z
  .object({
    dealId: z.string().min(1, "dealId es requerido"),
    contactId: z.string().optional(),
  })
  .passthrough();
