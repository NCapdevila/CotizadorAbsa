import type { VehiculoInput } from "./types.js";
import { VehicleCatalogUnresolvedError } from "./errors.js";

/** Los IDs internos de ABSA que hacen falta para armar `CotizacionInput.absa` (ver docs/absa-endpoints.md seccion 3 y 7). */
export interface AbsaEntityIds {
  idEntity: number;
  idVehiculo: number;
  idMarcaVehiculo: number;
  idModeloVehiculo: number;
  idOrigenVehiculo: number;
  infoAuto: number;
  idLocalidad: number;
  idFormaRastreo?: number;
  /** Sugerida por ABSA net (Data/GetVehiculoSumaAsegurada) para cuando el input no trae una. */
  sumaAseguradaSugerida?: number;
  /** Descripcion textual del vehiculo resuelto, tal cual la escribe ABSA (se manda como Item.VersionVehiculo). */
  descripcion?: string;
  /**
   * Cuanto se parece (0..100) la version elegida del catalogo a la que se
   * pidio. 100 = matchean cilindrada, transmision, turbo y todas las palabras.
   * Sirve para revisar a mano las cotizaciones con match flojo.
   */
  similitudVersion?: number;
  /**
   * Las otras versiones que quedaron cerca en el catalogo. Es lo que hace
   * falta para rehacer la cotizacion clavando la version correcta:
   * `vehiculo.codigoCatalogo = String(infoAuto)`.
   */
  alternativas?: Array<{ infoAuto: number; descripcion: string; similitud: number }>;
}

/**
 * Resuelve marca/modelo/año (texto libre) + localidad/codigo postal a los
 * IDs internos que ABSA net necesita. Interfaz separada a proposito para
 * que el resto del pipeline (webhook, cola, worker, escritura a HubSpot) se
 * pueda testear con un resolver stub sin depender de una sesion real de
 * ABSA. La implementacion real (`AbsaHttpVehicleCatalogResolver`, en
 * ./absaCatalogClient.ts) reproduce las llamadas AJAX reales del catalogo
 * de ABSA net, confirmadas con un HAR real en Fase 0 — ver
 * docs/absa-endpoints.md seccion 3.1 para el detalle y las limitaciones
 * conocidas (ambiguedad de version/motorizacion, id_Entity asumido).
 */
export interface AbsaEntityResolver {
  resolve(vehiculo: VehiculoInput, localidadOCodigoPostal?: string): Promise<AbsaEntityIds>;
}

/**
 * Resolver "apagado": siempre falla con un error especifico y explicito (no
 * generico) para que el worker lo pueda distinguir de un error real de
 * ABSA net y dejar el lead marcado como "pendiente de resolucion manual" en
 * vez de reintentarlo en loop o confundirlo con un fallo de la integracion.
 * Util para tests o para desactivar la resolucion automatica a proposito;
 * el default real que usa el worker es `AbsaHttpVehicleCatalogResolver`.
 */
export class NotImplementedAbsaEntityResolver implements AbsaEntityResolver {
  async resolve(vehiculo: VehiculoInput): Promise<AbsaEntityIds> {
    throw new VehicleCatalogUnresolvedError(
      `No se pudo resolver "${vehiculo.marca} ${vehiculo.modelo} ${vehiculo.anio}" a IDs internos de ABSA: ` +
        "el catalogo de vehiculos de ABSA net todavia no fue descubierto (Fase 0 pendiente, ver " +
        "docs/absa-endpoints.md seccion 7). Hace falta una captura en vivo del wizard de cotizacion " +
        "escribiendo marca/modelo en el autocomplete para ver que endpoint(s) llama.",
    );
  }
}

/**
 * Resolver "manual": para mientras tanto, permite resolver contra una tabla
 * estatica precargada (ej. los vehiculos mas comunes de la cartera del
 * broker, cargados a mano una vez consultando ABSA net directamente) en vez
 * de depender del autocomplete. Sirve como puente hasta que se descubra el
 * endpoint real.
 */
export class StaticTableAbsaEntityResolver implements AbsaEntityResolver {
  constructor(
    private readonly table: Map<string, AbsaEntityIds>,
    private readonly nextIdEntity: () => number,
  ) {}

  private key(vehiculo: VehiculoInput): string {
    return `${vehiculo.marca}|${vehiculo.modelo}|${vehiculo.anio}`.toLowerCase();
  }

  async resolve(vehiculo: VehiculoInput): Promise<AbsaEntityIds> {
    const found = this.table.get(this.key(vehiculo));
    if (!found) {
      throw new VehicleCatalogUnresolvedError(
        `"${vehiculo.marca} ${vehiculo.modelo} ${vehiculo.anio}" no esta en la tabla estatica de vehiculos conocidos.`,
      );
    }
    return { ...found, idEntity: this.nextIdEntity() };
  }
}
