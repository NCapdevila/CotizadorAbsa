/** Sesion vencida (401/403 o el patron equivalente detectado en Fase 0). Se maneja con re-login + 1 reintento. */
export class SessionExpiredError extends Error {
  constructor(message = "Sesion de ABSA net vencida o invalida") {
    super(message);
    this.name = "SessionExpiredError";
  }
}

/** Error de negocio (datos invalidos, producto no cotizable, etc). No tiene sentido reintentar sin cambiar el input. */
export class BusinessValidationError extends Error {
  constructor(
    message: string,
    public readonly detalles?: unknown,
  ) {
    super(message);
    this.name = "BusinessValidationError";
  }
}

/**
 * ABSA net devolvio algo que no matchea lo esperado (status raro, shape de
 * respuesta distinto al documentado en Fase 0). Probablemente cambiaron el
 * frontend/API interna. Se loguea fuerte y NO se reintenta en loop — un
 * reintento no va a arreglar un contrato roto.
 */
export class UpstreamChangedError extends Error {
  constructor(
    message: string,
    public readonly rawResponse?: unknown,
  ) {
    super(message);
    this.name = "UpstreamChangedError";
  }
}

/** Error transitorio (timeout, 5xx, network blip). Candidato a retry con backoff. */
export class TransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransientError";
  }
}

/**
 * No se pudo resolver `CotizacionInput.absa` (idEntity + IDs de catalogo de
 * vehiculo) a partir de datos "humanos" (marca/modelo/anio en texto libre).
 * Gap conocido de Fase 0 (ver docs/absa-endpoints.md seccion 7 y
 * src/quote/vehicleCatalog.ts) — no reintentar, requiere resolver el
 * catalogo de vehiculos de ABSA net primero.
 */
export class VehicleCatalogUnresolvedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VehicleCatalogUnresolvedError";
  }
}
