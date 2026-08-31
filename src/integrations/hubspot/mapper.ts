import type { CotizacionInput, CotizacionResult, EstadoCivil } from "../../quote/types.js";
import type { HubspotLeadWebhookPayload } from "./types.js";
import { loadHubspotProperties } from "./propertiesConfig.js";
import { BusinessValidationError } from "../../quote/errors.js";
import { config } from "../../config.js";
import { logger } from "../../logger.js";

/** dd/mm/yyyy o yyyy-mm-dd -> yyyy-mm-dd (lo que espera CotizacionInput.asegurado.fechaNacimiento). */
function normalizeFecha(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const match = value.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (match?.[1] && match[2] && match[3]) {
    const [, d, m, y] = match;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  return value; // se deja tal cual; si es invalido, lo va a rechazar el schema de zod mas adelante
}

/** HubSpot puede mandar "M"/"Masculino"/"masculino" segun como este armado el form. */
function normalizeSexo(value: unknown): "M" | "F" | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const v = value.trim().toUpperCase();
  if (v.startsWith("M")) return "M";
  if (v.startsWith("F")) return "F";
  return undefined;
}

/**
 * Sexo que se asume cuando el lead no lo trae.
 *
 * Medido el 2026-08-28 sobre 30 leads reales del barrido: los 30 tenian fecha
 * de nacimiento y NINGUNO tenia sexo. O sea que exigirlo no protegia nada —
 * frenaba el 100% de los leads recuperados con un "datos incompletos" que
 * nadie iba a completar a mano.
 *
 * OJO, igual que con el estado civil: el sexo ENTRA EN LA PRIMA, y bastante en
 * conductores jovenes. Una cotizacion generada con este default es orientativa
 * y al emitir hay que confirmar el dato real. Queda el warning en el log para
 * poder distinguir cuales se cotizaron asumiendo.
 */
const SEXO_POR_DEFECTO = "M" as const;

/** Catalogo real de ABSA; el 5 no existe. Acepta el ID o la etiqueta. */
const ESTADO_CIVIL_ABSA: Record<string, EstadoCivil> = {
  "1": 1, soltero: 1, soltera: 1,
  "2": 2, casado: 2, casada: 2,
  "3": 3, divorciado: 3, divorciada: 3,
  "4": 4, viudo: 4, viuda: 4,
  "6": 6, "no corresponde": 6,
  "7": 7, concubino: 7, concubina: 7,
};

/**
 * Estado civil que se asume cuando el lead no lo trae. El formulario no lo
 * pregunta (decision del negocio: es una friccion que no vale la pena en un
 * form de captacion) y ABSA lo exige, asi que se manda Casado siempre.
 *
 * OJO: el estado civil influye en la prima, asi que una cotizacion generada
 * con este default es orientativa — al emitir hay que confirmar el dato real.
 */
const ESTADO_CIVIL_POR_DEFECTO: EstadoCivil = 2; // Casado

function normalizeEstadoCivil(value: unknown): EstadoCivil {
  if (value === undefined || value === null || value === "") return ESTADO_CIVIL_POR_DEFECTO;
  return ESTADO_CIVIL_ABSA[String(value).trim().toLowerCase()] ?? ESTADO_CIVIL_POR_DEFECTO;
}

function toNumber(value: string | number | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Traduce el payload del webhook de HubSpot (nombres de propiedad de
 * HubSpot, todo string/opcional) al `CotizacionInput` normalizado que
 * entiende QuoteClient. Deliberadamente NO completa `input.absa` — eso lo
 * resuelve el worker por separado via AbsaEntityResolver (ver
 * src/quote/vehicleCatalog.ts), porque es un paso que puede fallar de forma
 * distinta (catalogo no resuelto) a un dato de HubSpot faltante.
 *
 * Tira BusinessValidationError si falta algo minimo indispensable para
 * siquiera intentar cotizar (nombre/apellido/documento/marca/modelo/anio).
 */
/**
 * El sexo del lead, o el default. Se avisa por log para poder saber despues
 * cuales cotizaciones salieron asumiendo, y se distingue "no vino" de "vino
 * algo que no se entiende" — lo segundo puede ser un formulario mandando un
 * valor nuevo que habria que mapear.
 */
function sexoDelLead(payload: HubspotLeadWebhookPayload): "M" | "F" {
  const normalizado = normalizeSexo(payload.sexo);
  if (normalizado) return normalizado;

  if (payload.sexo) {
    logger.warn(
      { dealId: payload.dealId, sexo: payload.sexo, seAsume: SEXO_POR_DEFECTO },
      "El sexo del lead no se entiende: se asume el default (entra en la prima, la cotizacion es orientativa)",
    );
  } else {
    logger.info(
      { dealId: payload.dealId, seAsume: SEXO_POR_DEFECTO },
      "El lead no trae sexo: se asume el default (entra en la prima, la cotizacion es orientativa)",
    );
  }
  return SEXO_POR_DEFECTO;
}

export function hubspotPayloadToCotizacionInput(payload: HubspotLeadWebhookPayload): CotizacionInput {
  const faltantes: string[] = [];
  // OJO: `firstname`, `lastname` y `dni` NO estan en esta lista a proposito.
  //
  // El nombre y el apellido NUNCA LLEGAN A ABSA: el payload de cotizacion
  // manda `Cliente.Nombre` vacio y no tiene `Cliente.Apellido` (ver
  // toAbsaCotizarPayload). Solo se usan para el texto con el que la cotizacion
  // queda guardada en el listado y para el PDF propio. El documento tampoco lo
  // exige ABSA.
  //
  // Exigirlos frenaba leads por datos que la cotizacion no usa: medido entre
  // el 29 y el 31 de agosto de 2026, de 32 leads en "datos incompletos", 24
  // eran por `lastname` — y de 14 revisados, ninguno tenia apellido cargado en
  // el Contact ni lo iba a tener. Sin apellido la cotizacion sale igual; lo
  // unico que pierde es precision en el nombre con que se la encuentra
  // despues (descripcionCotizacion ya saltea lo que no vino).
  if (!payload.marca_vehiculo) faltantes.push("marca_vehiculo");
  if (!payload.modelo_vehiculo) faltantes.push("modelo_vehiculo");
  if (!payload.anio_vehiculo) faltantes.push("anio_vehiculo");
  // ABSA rechaza la cotizacion sin fecha de nacimiento (400 con "Debe
  // seleccionar..."). Se exige aca para que el Deal quede marcado como
  // "datos incompletos" -- accionable por una persona -- en vez de fallar mas
  // tarde como un error tecnico contra ABSA.
  if (!payload.fecha_nacimiento) faltantes.push("fecha_nacimiento");
  // NI `sexo` NI `estado_civil` se exigen: el formulario no los completa y se
  // asumen (ver SEXO_POR_DEFECTO y ESTADO_CIVIL_POR_DEFECTO). Si el lead los
  // trae, se respetan.

  if (faltantes.length > 0) {
    throw new BusinessValidationError(
      `El lead de HubSpot no trae los campos minimos para cotizar: ${faltantes.join(", ")}`,
      { contactId: payload.contactId, faltantes },
    );
  }

  const anio = toNumber(payload.anio_vehiculo);
  if (!anio) {
    throw new BusinessValidationError("anio_vehiculo no es un numero valido", {
      contactId: payload.contactId,
      anio_vehiculo: payload.anio_vehiculo,
    });
  }

  const input: CotizacionInput = {
    ramo: "automotor",
    asegurado: {
      nombre: payload.firstname ?? "",
      apellido: payload.lastname ?? "",
      documentoTipo: "DNI",
      documentoNumero: payload.dni ? String(payload.dni) : undefined,
      fechaNacimiento: normalizeFecha(payload.fecha_nacimiento),
      sexo: sexoDelLead(payload),
      estadoCivil: normalizeEstadoCivil(payload.estado_civil),
      email: payload.email,
      telefono: payload.telefono,
      provincia: payload.provincia,
      localidad: payload.localidad,
      codigoPostal: payload.codigo_postal,
    },
    objetoAsegurado: {
      tipo: "vehiculo",
      vehiculo: {
        marca: String(payload.marca_vehiculo),
        modelo: String(payload.modelo_vehiculo),
        anio,
        version: payload.version_vehiculo,
        usoTipo: payload.uso_vehiculo,
        patente: payload.patente,
        ceroKm: payload.cero_km === true || payload.cero_km === "true",
      },
    },
    cobertura: {
      tipo: payload.cobertura_tipo ?? "terceros completo",
      sumaAsegurada: toNumber(payload.suma_asegurada),
    },
    // Lista cerrada del formulario. No se valida aca: la traduccion a un
    // productor de ABSA la hace resolverProductor() contra el mapeo, y su
    // error ya dice cual falto agregar. Vacio = productor de la plantilla.
    productor: payload.productor?.trim() || undefined,
  };

  return input;
}

export interface DealPropertiesUpdate {
  properties: Record<string, string | number>;
}

/** CotizacionResult exitoso -> propiedades del Deal (usa el mapeo de config/hubspot-properties.json). */
export function cotizacionResultToDealProperties(result: CotizacionResult): DealPropertiesUpdate {
  const props = loadHubspotProperties().properties;
  const mejor = [...result.opciones].sort((a, b) => a.premio - b.premio)[0];

  return {
    properties: soloLasMapeadas([
      [props.estado, "ok"],
      [props.numeroCotizacion, result.numeroCotizacion ?? ""],
      [props.mejorPremio, mejor?.premio ?? ""],
      [props.mejorAseguradora, mejor?.plan ?? ""],
      [props.cantidadOpciones, result.opciones.length],
      [props.opcionesJson, JSON.stringify(result.opciones)],
      [props.cotizadoEn, result.obtenidoEn],
      [props.cotizacionUrl, urlDeCotizacionEnAbsa(result.numeroCotizacion)],
    ]),
  };
}

/**
 * Arma el objeto de propiedades salteando las que no estan en
 * config/hubspot-properties.json.
 *
 * Mandar una propiedad que no existe en el portal hace que HubSpot rechace el
 * PATCH **completo** con un 400: se perderian tambien las que si existen. Por
 * eso el mapeo es la fuente de verdad de que se escribe.
 */
function soloLasMapeadas(pares: Array<[string | undefined, string | number]>): Record<string, string | number> {
  const properties: Record<string, string | number> = {};
  for (const [nombre, valor] of pares) {
    if (nombre) properties[nombre] = valor;
  }
  return properties;
}

/**
 * Link a la cotizacion dentro de ABSA net, para abrirla desde el Deal:
 * `/AutoCotizador/Cotizar/{nroCotizacion}?accion=4&esRecotizacionAnalisis=False`.
 *
 * OJO, dos cosas:
 * - El ID del path es el NUMERO DE COTIZACION (ej. 41321815), no el
 *   `id_Entity` de la cotizacion en curso (ej. 24104663) que usa `accion=1`.
 *   Son dos numeros distintos y se parecen poco.
 * - Solo abre con una sesion de ABSA net activa: sirve para el productor, no
 *   para mandarle a un cliente.
 */
export function urlDeCotizacionEnAbsa(numeroCotizacion: string | undefined): string {
  if (!numeroCotizacion) return "";
  const url = new URL(`/AutoCotizador/Cotizar/${encodeURIComponent(numeroCotizacion)}`, config.ABSA_BASE_URL);
  url.searchParams.set("accion", "4");
  url.searchParams.set("esRecotizacionAnalisis", "False");
  return url.toString();
}

/**
 * Estado "ya lo tomamos, esta cotizando" que se escribe al encolar el lead.
 * Sin esto, el Deal queda con las propiedades de ABSA vacias durante los 3-4
 * minutos que tarda la cotizacion y no hay forma de distinguir "todavia no
 * llego" de "fallo silenciosamente".
 */
export function enProcesoDealProperties(): DealPropertiesUpdate {
  const props = loadHubspotProperties().properties;
  return { properties: soloLasMapeadas([[props.estado, "en_proceso"]]) };
}

/** Error cotizando (de cualquier tipo) -> propiedades del Deal, para que quede trazado en HubSpot y no se pierda el lead. */
export function errorToDealProperties(estado: string, mensaje: string): DealPropertiesUpdate {
  const props = loadHubspotProperties().properties;
  return {
    properties: soloLasMapeadas([
      [props.estado, estado],
      [props.errorMensaje, mensaje.slice(0, 5000)], // limite razonable, HubSpot trunca textarea largo igual
      [props.cotizadoEn, new Date().toISOString()],
    ]),
  };
}

/** Texto de la Nota que acompaña el PDF adjunto al Deal. */
export function buildNoteBody(payload: HubspotLeadWebhookPayload, estado: string): string {
  const nombre = [payload.firstname, payload.lastname].filter(Boolean).join(" ") || "(sin nombre)";
  return `Cotización ABSA net para ${nombre} — estado: ${estado}. Ver PDF adjunto.`;
}
