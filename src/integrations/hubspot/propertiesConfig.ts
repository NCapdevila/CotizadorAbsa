import fs from "node:fs";
import { z } from "zod";
import { config } from "../../config.js";
import { logger } from "../../logger.js";

/**
 * Cada clave es OPCIONAL: la que no este en el JSON simplemente no se escribe
 * en HubSpot. Es a proposito — no todos los portales quieren las nueve
 * propiedades, y HubSpot rechaza el PATCH **entero** (con 400) si una sola de
 * las propiedades enviadas no existe. O sea que mapear de mas no degrada:
 * rompe todo, incluidas las que si existen.
 *
 * `.strict()` para que un typo en una clave (`estdo`) falle al cargar la
 * config y no se traduzca en "esa propiedad no se escribe nunca" sin que
 * nadie se entere.
 */
const propertiesSchema = z.object({
  properties: z
    .object({
      estado: z.string().optional(),
      numeroCotizacion: z.string().optional(),
      mejorPremio: z.string().optional(),
      mejorAseguradora: z.string().optional(),
      cantidadOpciones: z.string().optional(),
      opcionesJson: z.string().optional(),
      cotizadoEn: z.string().optional(),
      errorMensaje: z.string().optional(),
      /** URL de la cotizacion dentro de ABSA net, para abrirla y recotizar. */
      cotizacionUrl: z.string().optional(),
    })
    .strict(),
});

export type HubspotDealPropertiesConfig = z.infer<typeof propertiesSchema>;

let cached: HubspotDealPropertiesConfig | null = null;

/**
 * Carga (y cachea) el mapeo de nombres internos de propiedades custom de
 * Deal desde HUBSPOT_PROPERTIES_PATH. Separado de HubspotClient para poder
 * testearlo/mockearlo independiente, igual que absaTemplate.ts con la config
 * comercial de ABSA.
 */
export function loadHubspotProperties(): HubspotDealPropertiesConfig {
  if (cached) return cached;

  if (!fs.existsSync(config.HUBSPOT_PROPERTIES_PATH)) {
    throw new Error(
      `No se encontro ${config.HUBSPOT_PROPERTIES_PATH}. Copia ` +
        "ese archivo con el mapeo de propiedades custom de tu portal (o ajusta " +
        "HUBSPOT_PROPERTIES_PATH). El formato esta en el README, seccion \"Archivos de config\", " +
        "y los nombres internos en docs/hubspot-integration.md seccion 1.2.",
    );
  }

  const raw = JSON.parse(fs.readFileSync(config.HUBSPOT_PROPERTIES_PATH, "utf-8"));
  const parsed = propertiesSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `${config.HUBSPOT_PROPERTIES_PATH} invalido: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join(", ")}`,
    );
  }

  const mapeo = parsed.data;
  cached = mapeo;
  const sinMapear = Object.entries(TODAS_LAS_PROPIEDADES)
    .filter(([clave]) => !mapeo.properties[clave as keyof typeof mapeo.properties])
    .map(([, descripcion]) => descripcion);
  if (sinMapear.length > 0) {
    logger.info({ sinMapear }, "Propiedades de Deal no mapeadas: no se van a escribir en HubSpot");
  }
  return cached;
}

/** Solo para el log de arriba: que se pierde si una clave no esta mapeada. */
const TODAS_LAS_PROPIEDADES: Record<string, string> = {
  estado: "estado (ok / error_*)",
  numeroCotizacion: "numero de cotizacion",
  mejorPremio: "mejor premio",
  mejorAseguradora: "mejor aseguradora",
  cantidadOpciones: "cantidad de opciones",
  opcionesJson: "todas las opciones en JSON",
  cotizadoEn: "fecha de cotizacion",
  errorMensaje: "detalle del error",
  cotizacionUrl: "URL de la cotizacion en ABSA",
};

/** Solo para tests: fuerza a recargar del disco en el proximo `loadHubspotProperties()`. */
export function resetHubspotPropertiesCache(): void {
  cached = null;
}
