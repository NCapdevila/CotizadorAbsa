import type { HubspotLeadWebhookPayload } from "./types.js";

/**
 * Traduccion CRM -> payload del webhook, para el barrido (ver ./leadSweeper.ts).
 *
 * El lead vive repartido en dos objetos: el **Deal** tiene el vehiculo y el
 * **Contact** tiene a la persona y el domicilio del riesgo. El Workflow de
 * HubSpot ya hace esta misma union cuando arma el body del webhook; el barrido
 * la reconstruye desde la API para poder cotizar un lead cuyo webhook nunca
 * salio.
 *
 * Los nombres del lado del Contact son los ESTANDAR de HubSpot, no los del
 * webhook: `zip` y no `codigo_postal`, `gender` y no `sexo`,
 * `date_of_birth` y no `fecha_nacimiento`. Verificado el 2026-08-28 contra el
 * Contact 218176476590, cuyo Deal cotizo bien:
 *
 *   zip="1684"  city="El Palomar"  state="Buenos Aires"  gender="F"
 *   date_of_birth="1988-12-06"  dni="33558067"  productor_agencia="Ardama (REFERIDO)"
 */

/** Lo que hay que pedirle al Deal. */
export const PROPIEDADES_DE_DEAL = [
  "marca_vehiculo",
  "modelo_vehiculo",
  "version_vehiculo",
  "anio_vehiculo",
  "patente_vehiculo",
  "createdate",
  "dealname",
] as const;

/**
 * Lo que hay que pedirle al Contact. Se piden EXPLICITAMENTE: sin la lista,
 * HubSpot devuelve las propiedades default y rechaza la llamada entera si
 * alguna esta marcada como sensible en el portal.
 */
export const PROPIEDADES_DE_CONTACT = [
  "firstname",
  "lastname",
  "email",
  "phone",
  "dni",
  "date_of_birth",
  "gender",
  "zip",
  "city",
  "state",
  "productor_agencia",
] as const;

/** `null` y `""` son lo mismo aca: HubSpot devuelve las dos cosas para "vacio". */
function limpio(valor: string | null | undefined): string | undefined {
  const texto = valor?.trim();
  return texto ? texto : undefined;
}

/**
 * Arma el mismo `HubspotLeadWebhookPayload` que mandaria el Workflow, para que
 * el barrido y el webhook desemboquen en EXACTAMENTE el mismo camino de
 * cotizacion (`hubspotPayloadToCotizacionInput` -> `LeadWorker`). Si los dos
 * armaran el input distinto, un lead cotizaria diferente segun por donde entro,
 * que es la clase de diferencia que despues no se encuentra nunca.
 */
export function dealYContactoAPayload(
  dealId: string,
  deal: Record<string, string | null>,
  contacto: Record<string, string | null>,
  contactId?: string,
): HubspotLeadWebhookPayload {
  return {
    dealId,
    contactId,

    // --- Persona y domicilio del riesgo: viven en el Contact ---
    firstname: limpio(contacto["firstname"]),
    lastname: limpio(contacto["lastname"]),
    email: limpio(contacto["email"]),
    telefono: limpio(contacto["phone"]),
    dni: limpio(contacto["dni"]),
    fecha_nacimiento: limpio(contacto["date_of_birth"]),
    sexo: limpio(contacto["gender"]),
    codigo_postal: limpio(contacto["zip"]),
    localidad: limpio(contacto["city"]),
    // Viaja el NOMBRE de la provincia ("Buenos Aires"), no un id. Se manda
    // igual porque el mapper la ignora a proposito y usa la que sale del
    // codigo postal (ver resolveIdProvincia en src/quote/mapper.ts).
    provincia: limpio(contacto["state"]),
    productor: limpio(contacto["productor_agencia"]),

    // --- Vehiculo: vive en el Deal ---
    marca_vehiculo: limpio(deal["marca_vehiculo"]),
    modelo_vehiculo: limpio(deal["modelo_vehiculo"]),
    version_vehiculo: limpio(deal["version_vehiculo"]),
    anio_vehiculo: limpio(deal["anio_vehiculo"]),
    patente: limpio(deal["patente_vehiculo"]),
  };
}
