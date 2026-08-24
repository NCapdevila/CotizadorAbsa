/**
 * Fase 4 — Smoke test / health-check.
 *
 * Corre una cotizacion de referencia contra ABSA net real y reporta
 * exito/fallo de forma inequivoca (exit code + log). Pensado para
 * correrse periodicamente desde afuera (cron, un scheduled job, etc) —
 * este script no se agenda solo.
 *
 * Uso:
 *   npm run smoke-test
 *
 * El caso de referencia (REFERENCE_INPUT abajo) es un placeholder: una vez
 * completada la Fase 0, reemplazarlo por un caso real y estable (ej. un
 * vehiculo/perfil que se sepa que ABSA siempre puede cotizar) para que las
 * fallas reflejen problemas de la integracion y no datos invalidos.
 */
import { cotizar } from "./index.js";
import { logger } from "./logger.js";
import type { CotizacionInput } from "./quote/types.js";

const REFERENCE_INPUT: CotizacionInput = {
  ramo: "automotor",
  asegurado: {
    nombre: "Smoke",
    apellido: "Test",
    documentoTipo: "DNI",
    documentoNumero: "00000000",
    provincia: "Buenos Aires",
  },
  objetoAsegurado: {
    tipo: "vehiculo",
    vehiculo: {
      marca: "PLACEHOLDER",
      modelo: "PLACEHOLDER",
      anio: new Date().getFullYear(),
      usoTipo: "particular",
    },
  },
  cobertura: {
    tipo: "terceros completo",
  },
  // TODO FASE 0: completar con IDs reales de una cotizacion de referencia
  // estable (ver docs/absa-endpoints.md seccion 7 -- el catalogo de
  // vehiculos y la creacion de id_Entity todavia no estan descubiertos).
  absa: {
    idEntity: 0,
    idVehiculo: 0,
    idMarcaVehiculo: 0,
    idModeloVehiculo: 0,
    idOrigenVehiculo: 1,
    infoAuto: 0,
    idLocalidad: 0,
  },
};

async function main() {
  const start = Date.now();
  try {
    const result = await cotizar(REFERENCE_INPUT);
    const ms = Date.now() - start;
    logger.info({ ms, numeroCotizacion: result.numeroCotizacion }, "SMOKE TEST OK: cotizacion de referencia exitosa");
    process.exit(0);
  } catch (err) {
    const ms = Date.now() - start;
    logger.error({ err, ms }, "SMOKE TEST FALLO: revisar si ABSA net cambio algo o la sesion no se pudo obtener");
    process.exit(1);
  }
}

main();
