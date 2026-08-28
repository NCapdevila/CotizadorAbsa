/**
 * Tipos para la integracion HubSpot -> ABSA net (Fase 6, ver
 * docs/hubspot-integration.md). El payload del webhook es el contrato que
 * hay que configurar del lado del Workflow de HubSpot (accion "Enviar un
 * webhook", body custom) — ver ese doc para el JSON exacto a pegar ahi.
 */

/**
 * Lo que esperamos que mande el Workflow de HubSpot en el body del webhook.
 * Son nombres de propiedad internos de HubSpot (snake_case, los que definis
 * vos en Settings > Properties) — el Workflow los interpola en el body
 * custom del webhook action. Todos opcionales a nivel tipo porque HubSpot no
 * garantiza que una propiedad este completa; la validacion real (que exista
 * lo minimo para cotizar) la hace el mapper.
 */
export interface HubspotLeadWebhookPayload {
  /**
   * hs_object_id del Deal que el formulario YA creo en HubSpot (junto con el
   * Contact) — este backend NUNCA crea Deals, solo actualiza propiedades y
   * le adjunta el PDF de la cotizacion a este Deal existente.
   */
  dealId: string;

  /** hs_object_id del Contact — opcional, solo para logging/trazabilidad (la asociacion Deal<->Contact ya la hizo el formulario). */
  contactId?: string;

  email?: string;
  firstname?: string;
  lastname?: string;
  dni?: string;
  /** Requerido por ABSA. dd/mm/yyyy o yyyy-mm-dd, ver mapper. */
  fecha_nacimiento?: string;
  /** Requerido por ABSA. "M"/"F" o "Masculino"/"Femenino". */
  sexo?: string;
  /** Requerido por ABSA. ID (1,2,3,4,6,7) o etiqueta ("Casado", "Soltero", ...). */
  estado_civil?: string | number;
  telefono?: string;
  /**
   * NO la mandes: la provincia sale del codigo postal
   * (`/Localidad/GetLocalidad`), igual que en el portal, y **el CP gana
   * siempre**. Lo que venga aca se descarta cuando el CP resolvio una, sea un
   * nombre ("Cordoba", "BA") o un ID que no coincide — mandar una provincia
   * que contradice a la localidad hace que ABSA cotice la zona equivocada.
   * Solo se usa, y solo si es un ID numerico, cuando el CP no resolvio nada.
   */
  provincia?: string;
  localidad?: string;
  codigo_postal?: string;

  marca_vehiculo?: string;
  modelo_vehiculo?: string;
  anio_vehiculo?: string | number;
  version_vehiculo?: string;
  uso_vehiculo?: string;
  patente?: string;
  cero_km?: string | boolean;

  cobertura_tipo?: string;
  suma_asegurada?: string | number;

  /**
   * Productor / concesionaria que origino el lead, tal cual lo manda la lista
   * desplegable (cerrada) del formulario. Se mapea a un `id_Productor` de ABSA
   * en config/absa-productores.json — define el acuerdo comercial con el que se
   * cotiza. Vacio = el productor de config/absa-comercial.json.
   */
  productor?: string;

  /** Escape hatch: cualquier otra propiedad que se mande y el mapper todavia no use explicitamente. */
  [extra: string]: unknown;
}

/** Job tal como vive en la cola persistida (ver src/queue/jobQueue.ts). */
export type QueueJobStatus = "pending" | "processing" | "done" | "failed";

export interface QueueJob {
  id: string;
  status: QueueJobStatus;
  payload: HubspotLeadWebhookPayload;
  attempts: number;
  createdAt: string; // ISO
  updatedAt: string; // ISO
  lastError?: string;
}
