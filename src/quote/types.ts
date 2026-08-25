/**
 * Interfaz normalizada, agnostica del formato interno de ABSA net.
 * El agente de Ninjo solo conoce estos tipos — nunca el payload real de
 * ABSA. El mapper (mapper.ts) es el unico lugar que traduce entre este
 * modelo y lo que espera ABSA net.
 *
 * NOTA: los campos exactos que ABSA net realmente pide/soporta se terminan
 * de ajustar despues de la Fase 0 (ver docs/absa-endpoints.md seccion 3).
 * Esta interfaz es un punto de partida razonable para un cotizador de
 * seguros de automotor (el caso mas comun); extenderla para otros ramos
 * (hogar, vida, etc) agregando variantes analogas a VehiculoInput.
 */

import type { AbsaEntityIds } from "./vehicleCatalog.js";

export type Ramo = "automotor" | "hogar" | "vida" | "comercio" | (string & {});

/**
 * Estado civil segun el catalogo real de ABSA net (confirmado en el HTML del
 * cotizador). Ojo que el 5 no existe.
 */
export type EstadoCivil = 1 | 2 | 3 | 4 | 6 | 7;

export interface AseguradoInput {
  nombre: string;
  apellido: string;
  /** Default DNI. Solo importa si se manda `documentoNumero`. */
  documentoTipo?: "DNI" | "CUIT" | "CUIL" | "PASAPORTE";
  /**
   * OPCIONAL: ABSA cotiza sin documento (la prima sale de vehiculo, año,
   * localidad, sexo, edad y estado civil). Conviene mandarlo igual cuando se
   * tiene, porque es lo que despues identifica al cliente si la cotizacion se
   * convierte en poliza.
   */
  documentoNumero?: string;
  /**
   * ISO 8601 (YYYY-MM-DD). **Requerido por ABSA net**: sin esto la cotizacion
   * se rechaza con "Debe ingresar una fecha de nacimiento".
   */
  fechaNacimiento?: string;
  /** **Requerido por ABSA net** ("Debe seleccionar un sexo."). */
  sexo?: "M" | "F";
  /** **Requerido por ABSA net** ("Debe seleccionar un estado civil."). 1=Soltero 2=Casado 3=Divorciado 4=Viudo 6=No corresponde 7=Concubino. */
  estadoCivil?: EstadoCivil;
  email?: string;
  telefono?: string;
  provincia?: string;
  localidad?: string;
  codigoPostal?: string;
}

export interface VehiculoInput {
  marca: string;
  modelo: string;
  anio: number;
  version?: string;
  usoTipo?: "particular" | "comercial" | "taxi" | "remis" | (string & {});
  /** Codigo de Infoauto/CESVI u otro catalogo que ABSA use para identificar el modelo. */
  codigoCatalogo?: string;
  patente?: string;
  ceroKm?: boolean;
}

export interface CoberturaInput {
  /** Ej: "terceros completo", "todo riesgo", etc. Valores validos dependen de lo que ofrezca ABSA para el ramo. */
  tipo: string;
  sumaAsegurada?: number;
  franquiciaDeseada?: number;
}

export interface CotizacionInput {
  ramo: Ramo;
  asegurado: AseguradoInput;
  objetoAsegurado: {
    tipo: "vehiculo" | "hogar" | "otro";
    vehiculo?: VehiculoInput;
  };
  cobertura: CoberturaInput;

  /**
   * Productor (concesionaria/vendedor) con cuyo acuerdo comercial se cotiza.
   *
   * Es el valor de la lista CERRADA del formulario, no texto libre: se traduce
   * al `Comercial.id_Productor` de ABSA con el mapeo de
   * config/absa-productores.json (ver ./productoresConfig.ts). Cambiarlo
   * cambia rebajas, comision y que aseguradoras cotizan.
   *
   * Sin esto se cotiza con el productor de config/absa-comercial.json, que es
   * como venia funcionando.
   */
  productor?: string;

  /**
   * ABSA net identifica el vehiculo por IDs de un catalogo interno
   * (Infoauto + catalogo propio de ABSA), no por marca/modelo en texto
   * libre. `AbsaEntityResolver` (ver ./vehicleCatalog.ts y
   * ./absaCatalogClient.ts) resuelve estos IDs automaticamente a partir de
   * `objetoAsegurado.vehiculo` — quien llama a `cotizar()` directamente
   * (sin pasar por el worker de HubSpot) puede seguir proveyendo este campo
   * a mano si ya sabe los IDs.
   */
  absa?: AbsaEntityIds;

  /** Escape hatch para datos que ABSA pida y todavia no esten modelados explicitamente. */
  extra?: Record<string, unknown>;
}

export interface CotizacionOpcion {
  plan: string;
  premio: number;
  moneda: string;
  cobertura: string;
  vigenciaDesde?: string;
  vigenciaHasta?: string;
}

export interface CotizacionResult {
  ok: true;
  numeroCotizacion?: string;
  opciones: CotizacionOpcion[];
  /**
   * IDs de las aseguradoras que efectivamente devolvieron propuesta. Hace
   * falta para exportar el PDF: hay que tildar sus coberturas antes, y no
   * tiene sentido intentarlo con las que fallaron.
   */
  aseguradorasCotizadas?: number[];
  /** Payload crudo de la respuesta de ABSA, para auditoria/debug. Revisar antes de reenviarlo tal cual al agente: puede traer campos internos o PII de mas. */
  rawAbsaResponse: unknown;
  obtenidoEn: string; // ISO timestamp
}
