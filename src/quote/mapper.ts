import * as cheerio from "cheerio";
import type { CotizacionInput, CotizacionOpcion, CotizacionResult } from "./types.js";
import { BusinessValidationError, UpstreamChangedError } from "./errors.js";
import type { AbsaComercialTemplate } from "./absaTemplate.js";
import { logger } from "../logger.js";

/**
 * ============================================================================
 * Mapper basado en la captura real de Fase 0 (ver docs/absa-endpoints.md).
 * ABSA net (AutoCotizador) es ASP.NET MVC clasico: los POSTs son
 * form-urlencoded y las respuestas son fragmentos HTML, no JSON. Quedan
 * gaps abiertos marcados TODO FASE 0 -- puntualmente, todavia no se capturo
 * el HTML real de las respuestas (el HAR se exporto sin "with content"), asi
 * que el parser de resultados (`parseCotizacionPropuestaHtml`) es best-effort
 * y necesita ajustarse con selectores reales en cuanto se tenga una muestra.
 * ============================================================================
 */

function formatFecha(iso: string | undefined): string {
  // ABSA espera dd/MM/yyyy. Input normalizado usa ISO (yyyy-MM-dd).
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  if (!y || !m || !d) return iso; // ya viene en otro formato, se manda tal cual
  return `${d}/${m}/${y}`;
}

const TIPO_DOCUMENTO_ABSA: Record<NonNullable<CotizacionInput["asegurado"]["documentoTipo"]>, number> = {
  // TODO FASE 0: confirmar el catalogo completo. 7 = DNI se confirmo con la captura real.
  DNI: 7,
  CUIT: 1,
  CUIL: 2,
  PASAPORTE: 8,
};

/**
 * Catalogo REAL de `Item.id_UsoVehiculo`, leido del <select> del cotizador:
 * solo existen estos tres valores.
 *
 * Antes esto tenia `taxi: 3` y `remis: 4`, inventados: no existen en el
 * catalogo de ABSA. Un uso desconocido cae a "particular" con un warning, que
 * es preferible a mandar un ID que el servidor no reconoce.
 */
const USO_VEHICULO_ABSA: Record<string, number> = {
  particular: 1,
  comercial: 2,
  "transporte gral. rutero": 5,
  transporte: 5,
  rutero: 5,
};

function resolveUsoVehiculo(usoTipo: string | undefined): number {
  if (!usoTipo) return 1;
  const id = USO_VEHICULO_ABSA[usoTipo.toLowerCase()];
  if (id === undefined) {
    logger.warn({ usoTipo }, "usoTipo desconocido para ABSA, se usa 'particular' (1) por default");
    return 1;
  }
  return id;
}

/**
 * ABSA exige sexo, estado civil y fecha de nacimiento, y los valida del lado
 * del servidor devolviendo un 400 con
 * `{"Errores":["Debe seleccionar un sexo.", ...]}`.
 *
 * `QuoteClient` llama a esto ANTES de la primera request: si faltan datos no
 * tiene sentido pedir el token, ni crear una entidad de cotizacion en la
 * cuenta del broker que va a quedar huerfana.
 */
export function assertDatosAseguradoCompletos(input: CotizacionInput): void {
  const faltantes: string[] = [];
  if (!input.asegurado.sexo) faltantes.push("asegurado.sexo (M|F)");
  if (input.asegurado.estadoCivil === undefined) {
    faltantes.push("asegurado.estadoCivil (1=Soltero 2=Casado 3=Divorciado 4=Viudo 6=No corresponde 7=Concubino)");
  }
  if (!input.asegurado.fechaNacimiento) faltantes.push("asegurado.fechaNacimiento (YYYY-MM-DD)");
  if (faltantes.length > 0) {
    throw new BusinessValidationError(
      `ABSA net requiere estos datos del asegurado y no vinieron en el input: ${faltantes.join(", ")}.`,
      { faltantes },
    );
  }
}

/**
 * `DomicilioRiesgo.id_Provincia`.
 *
 * ABSA espera un ID numerico y **no hay lista para elegir**: en el portal es un
 * hidden que se llena solo al elegir la localidad, asi que la fuente correcta
 * es la provincia que el resolver saco del codigo postal
 * (`/Localidad/GetLocalidad`).
 *
 * `asegurado.provincia` solo se respeta si es un ID numerico, como escotilla
 * para forzarla a mano. Un nombre ("Cordoba", "Buenos Aires") se ignora a
 * proposito: es lo que suele mandar un formulario, y mandarlo tal cual no da un
 * error claro, da una cotizacion con la provincia en blanco o rechazada.
 */
function resolveIdProvincia(input: CotizacionInput): string {
  const pedida = input.asegurado.provincia?.trim();
  if (pedida && /^\d+$/.test(pedida)) return pedida;

  if (pedida) {
    logger.warn(
      { provincia: pedida, idProvincia: input.absa?.idProvincia },
      "asegurado.provincia no es un ID numerico: se ignora y se usa la provincia que salio del codigo postal",
    );
  }
  return String(input.absa?.idProvincia ?? "");
}

/**
 * Nombre con el que la cotizacion queda guardada en el listado de ABSA
 * (`GuardarCotizacion.Descripcion`). Es texto libre y es lo unico que ve el
 * productor para encontrarla despues, asi que se arma con todo lo que sirva
 * para identificarla: vehiculo, patente, titular y documento.
 *
 *   "CHEVROLET TRACKER 2021 - AB123CD - Juan Perez - 30123456"
 *
 * Los datos opcionales se saltean solos (patente y documento no siempre
 * vienen: el formulario no los exige y ABSA cotiza sin ellos). `fallback`
 * (ej. el id del Deal) se usa solo si no quedo NADA que identifique al
 * titular, para que la cotizacion no quede con el nombre del auto pelado.
 */
export function descripcionCotizacion(input: CotizacionInput, fallback?: string): string {
  const vehiculo = input.objetoAsegurado.vehiculo;
  const titular = [input.asegurado.nombre, input.asegurado.apellido].filter(Boolean).join(" ").trim();

  const partes = [
    vehiculo ? `${vehiculo.marca} ${vehiculo.modelo} ${vehiculo.anio}`.replace(/\s+/g, " ").trim() : "Cotizacion",
    vehiculo?.patente?.trim().toUpperCase(),
    titular,
    input.asegurado.documentoNumero?.trim(),
  ].filter((parte): parte is string => Boolean(parte));

  if (partes.length === 1 && fallback) partes.push(fallback);
  return partes.join(" - ");
}

/**
 * Arma el payload del endpoint principal:
 *   POST /AutoCotizador/Cotizar/{idEntity}?Length={n}
 * Devuelve un URLSearchParams listo para mandar como body
 * "application/x-www-form-urlencoded".
 */
export function toAbsaCotizarPayload(
  input: CotizacionInput,
  template: AbsaComercialTemplate,
  csrfToken: string,
): URLSearchParams {
  if (input.objetoAsegurado.tipo !== "vehiculo" || !input.objetoAsegurado.vehiculo) {
    throw new BusinessValidationError(
      "Por ahora el mapper solo soporta objetoAsegurado.tipo === 'vehiculo' (AutoCotizador)",
    );
  }
  if (!input.absa) {
    throw new BusinessValidationError(
      "Falta input.absa (idEntity + IDs de catalogo de vehiculo). Ver CotizacionInput.absa " +
        "en src/quote/types.ts -- normalmente lo resuelve AbsaEntityResolver.",
    );
  }

  assertDatosAseguradoCompletos(input);

  const vehiculo = input.objetoAsegurado.vehiculo;
  const p = new URLSearchParams();

  p.set("__RequestVerificationToken", csrfToken);

  // Identificacion de la operacion
  p.set("id_Organizador", String(template.idOrganizador));
  p.set("id_Usuario", String(template.idUsuario));
  p.set("id_Aseguradora", "");
  p.set("id_Riesgo", "9"); // 9 = Auto (TODO FASE 0: confirmar catalogo para otros ramos)
  p.set("id_Operacion", "0");
  p.set("id_Entity", String(input.absa.idEntity));
  p.set("NroCotizacion", "0");
  p.set("NroCotizacionAnalisis", "");
  p.set("NroPolizaRenovada", "");
  p.set("EsRecotizacion", "False");
  p.set("EsRecotizacionAnalisis", "False");
  p.set("EsRenovacion", "False");
  p.set("AccionCotizar", "1");

  // Comercial (config de cuenta del broker)
  p.set("Comercial.Comision", String(template.comision));
  p.set("ComisionPoliza", "0");
  p.set("Comercial.ConfigCotizacion.ComisionOrg", "0");
  p.set("Comercial.id_TipoPago", String(template.idTipoPago));
  p.set("Comercial.id_Productor", String(template.idProductor));
  p.set("Comercial.id_Configuracion", String(template.idConfiguracion));

  // Cliente (asegurado)
  p.set("Cliente.id_Cliente", "");
  p.set("Cliente.Nombre", "");
  p.set("Cliente.id_TipoCliente", "1");
  p.set("Cliente.id_TipoIVA", "1");
  // El documento es opcional: ABSA cotiza sin el (el tipo de documento va
  // igual, con el default del formulario, porque el select nunca viaja vacio).
  p.set("Cliente.id_TipoDocumento", String(TIPO_DOCUMENTO_ABSA[input.asegurado.documentoTipo ?? "DNI"]));
  p.set("Cliente.Documento", input.asegurado.documentoNumero ?? "");
  p.set("Cliente.Sexo", input.asegurado.sexo ?? "");
  p.set("Cliente.id_EstadoCivil", input.asegurado.estadoCivil === undefined ? "" : String(input.asegurado.estadoCivil));
  p.set("Cliente.FechaNacimiento", formatFecha(input.asegurado.fechaNacimiento));

  // Domicilio de riesgo
  p.set("DomicilioRiesgo.id_Localidad", String(input.absa.idLocalidad));
  p.set("DomicilioRiesgo.CodigoPostal", input.asegurado.codigoPostal ?? "");
  p.set("DomicilioRiesgo.id_Provincia", resolveIdProvincia(input));
  p.set("DomicilioRiesgo.id_Domicilio", "");

  // Vehiculo
  p.set("Item.id_Vehiculo", String(input.absa.idVehiculo));
  p.set("Item.id_MarcaVehiculo", String(input.absa.idMarcaVehiculo));
  p.set("Item.id_ModeloVehiculo", String(input.absa.idModeloVehiculo));
  p.set("Item.id_OrigenVehiculo", String(input.absa.idOrigenVehiculo));
  // Va primero la descripcion del catalogo y no `vehiculo.version`: esta ultima
  // es texto libre del formulario/la cedula ("1.2T AT PREMIER") que se usa para
  // ELEGIR la version, mientras que ABSA espera aca su propia descripcion, la
  // que corresponde al Item.InfoAuto que se manda dos lineas mas abajo.
  p.set("Item.VersionVehiculo", input.absa.descripcion ?? vehiculo.version ?? `${vehiculo.marca} ${vehiculo.modelo}`);
  p.set("Item.SumaAsegurada", String(input.cobertura.sumaAsegurada ?? input.absa.sumaAseguradaSugerida ?? ""));
  p.set("Item.InfoAuto", String(input.absa.infoAuto));
  p.set("Item.Anio", String(vehiculo.anio));
  p.set("Item.id_UsoVehiculo", String(resolveUsoVehiculo(vehiculo.usoTipo)));
  p.set("Item.id_FormaRastreo", String(input.absa.idFormaRastreo ?? 1));

  // Poliza
  p.set("Poliza.FechaInicioVigencia", formatFecha(new Date().toISOString().slice(0, 10)));

  // Aseguradoras a cotizar + config comercial por aseguradora (plantilla de cuenta)
  template.aseguradoras.forEach((a, i) => {
    p.set(`Comercial.ConfigCotizacion.Aseguradoras[${i}].id_Aseguradora`, String(a.id));
    p.set(`Comercial.ConfigCotizacion.Aseguradoras[${i}].Aseguradora`, a.nombre);
  });
  for (const [key, value] of Object.entries(template.camposPorAseguradora)) {
    p.set(key, String(value));
  }

  p.set("CotizacionGuardada", "false");

  for (const [key, value] of Object.entries(input.extra ?? {})) {
    p.set(key, String(value));
  }

  return p;
}

/** Arma el payload del endpoint por-aseguradora: POST /CotizadorPropuesta/CotizarPropuesta/ */
export function toAbsaPropuestaPayload(idRiesgo: number, idAseguradora: number, nroCotizacion: string): URLSearchParams {
  return new URLSearchParams({
    idRiesgo: String(idRiesgo),
    idAseguradora: String(idAseguradora),
    ocultarComision: "False",
    nroCotizacion,
    accionCotizar: "1",
  });
}

/**
 * Confirmado con un HAR real (con contenido) de la Fase 0: para algunas
 * aseguradoras la respuesta NO es el HTML de la tabla, es un JSON chico
 * (~48 bytes) de la forma `{"error":true,"responseText":"Error al Cotizar"}`.
 * Esto resuelve la duda que habia quedado abierta en docs/absa-endpoints.md
 * seccion 4: NO es un estado "todavia procesando" que haya que pollear, es
 * un error de esa aseguradora puntual para este vehiculo/cobertura (rechazo
 * de negocio, no tecnico) -- se tiene que tratar como un fallo de ESA
 * aseguradora nada mas, no de toda la cotizacion.
 */
/**
 * El POST principal de cotizacion, cuando falla la validacion de negocio,
 * responde 400 con `{"success":false,"Errores":["Debe seleccionar un sexo.", ...]}`.
 * Extraer esos mensajes es la diferencia entre un error accionable y un
 * "status 400" que no dice nada.
 */
export function tryParseAbsaErrores(body: string): string[] | null {
  const trimmed = body.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed) as { Errores?: unknown };
    if (!Array.isArray(parsed.Errores) || parsed.Errores.length === 0) return null;
    return parsed.Errores.map((e) => String(e));
  } catch {
    return null;
  }
}

export function tryParseAbsaErrorJson(body: string): string | null {
  const trimmed = body.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed) as { error?: boolean; responseText?: string };
    if (parsed.error === true) return parsed.responseText ?? "Error al Cotizar (sin detalle)";
    return null;
  } catch {
    return null;
  }
}

/**
 * Confirmado con un HAR real (con contenido) de la Fase 0: la respuesta es
 * una tabla `table.table-propuesta` con una fila de encabezado (`<th
 * class="panel-heading">`, la primera celda es el logo y se ignora, el
 * resto son los planes disponibles con el nombre en
 * `a.labelDetalle`) y filas de detalle identificadas por la primera celda
 * (`<td>Premio</td>`, `<td>Prima</td>`, `<td>Comisión</td>`, etc), con un
 * valor por plan en el mismo orden que el encabezado. Se usa la fila
 * "Premio" (precio final) como el valor de cada opcion.
 */
export function parseCotizacionPropuestaHtml(html: string, aseguradoraNombre: string): CotizacionOpcion[] {
  const $ = cheerio.load(html);
  const table = $("table.table-propuesta").first();

  if (table.length === 0) {
    throw new UpstreamChangedError(
      `No se encontro table.table-propuesta en la respuesta de ABSA para ${aseguradoraNombre}. ` +
        "ABSA puede haber cambiado el template de esta pantalla (ver docs/absa-endpoints.md seccion 4).",
      html,
    );
  }

  const headerRow = table.find("tr").first();
  const planNames: string[] = [];
  headerRow.find("th.panel-heading").each((i, th) => {
    if (i === 0) return; // primera columna es el logo de la aseguradora, no un plan
    planNames.push($(th).find("a.labelDetalle").first().text().trim());
  });

  const premioRow = table
    .find("tr")
    .filter((_, tr) => $(tr).find("td").first().text().trim().toLowerCase() === "premio")
    .first();

  if (premioRow.length === 0 || planNames.length === 0) {
    throw new UpstreamChangedError(
      `No se pudo ubicar la fila "Premio" o los nombres de plan en la respuesta de ABSA para ${aseguradoraNombre}. ` +
        "ABSA puede haber cambiado el template de esta pantalla (ver docs/absa-endpoints.md seccion 4).",
      html,
    );
  }

  const premios: string[] = [];
  premioRow.find("td").each((i, td) => {
    if (i === 0) return; // primera celda es la etiqueta "Premio"
    premios.push($(td).text().trim());
  });

  const opciones: CotizacionOpcion[] = [];
  for (let i = 0; i < Math.min(planNames.length, premios.length); i++) {
    const premioText = premios[i];
    if (!premioText) continue;
    const premio = parseArgentineCurrency(premioText);
    if (!Number.isFinite(premio)) continue;
    const plan = planNames[i] || `plan ${i + 1}`;
    opciones.push({
      plan: `${aseguradoraNombre} - ${plan}`,
      premio,
      moneda: "ARS",
      cobertura: plan,
    });
  }

  if (opciones.length === 0) {
    throw new UpstreamChangedError(
      `No se pudo extraer ningun premio parseable de la respuesta de ABSA para ${aseguradoraNombre}.`,
      html,
    );
  }

  return opciones;
}

function parseArgentineCurrency(text: string): number {
  // "$ 110.211,00" -> 110211.00 (punto = separador de miles, coma = decimal)
  const cleaned = text.replace(/\$\s?/, "").replace(/\./g, "").replace(",", ".");
  return Number(cleaned);
}

/**
 * Mantiene compatibilidad con el diseno original (JSON) por si en el futuro
 * se encuentra un endpoint que SI devuelva JSON (por ejemplo, el caso de
 * 48 bytes application/json observado para algunas aseguradoras -- ver
 * docs/absa-endpoints.md seccion 4). No usado por el flujo HTML principal.
 */
export function fromAbsaJsonResponse(raw: unknown): CotizacionResult {
  if (typeof raw !== "object" || raw === null) {
    throw new UpstreamChangedError("Respuesta JSON de ABSA no es un objeto como se esperaba", raw);
  }
  const r = raw as Record<string, unknown>;
  const premio = r["premio"] ?? r["prima"];
  if (typeof premio !== "number") {
    throw new UpstreamChangedError("No se encontro un campo de premio/prima numerico en la respuesta JSON de ABSA", raw);
  }
  return {
    ok: true,
    numeroCotizacion: typeof r["numeroCotizacion"] === "string" ? (r["numeroCotizacion"] as string) : undefined,
    opciones: [
      {
        plan: typeof r["plan"] === "string" ? (r["plan"] as string) : "desconocido",
        premio,
        moneda: typeof r["moneda"] === "string" ? (r["moneda"] as string) : "ARS",
        cobertura: typeof r["cobertura"] === "string" ? (r["cobertura"] as string) : "",
      },
    ],
    rawAbsaResponse: raw,
    obtenidoEn: new Date().toISOString(),
  };
}
