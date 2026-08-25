import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import {
  hubspotPayloadToCotizacionInput,
  cotizacionResultToDealProperties,
  errorToDealProperties,
  buildNoteBody,
} from "../src/integrations/hubspot/mapper.js";
import { loadHubspotProperties, resetHubspotPropertiesCache } from "../src/integrations/hubspot/propertiesConfig.js";
import { BusinessValidationError } from "../src/quote/errors.js";
import type { HubspotLeadWebhookPayload } from "../src/integrations/hubspot/types.js";
import type { CotizacionResult } from "../src/quote/types.js";

const VALID_PAYLOAD: HubspotLeadWebhookPayload = {
  dealId: "777",
  contactId: "555",
  email: "juan@example.com",
  firstname: "Juan",
  lastname: "Perez",
  dni: "30123456",
  fecha_nacimiento: "15/01/1990",
  sexo: "Masculino",
  estado_civil: "Casado",
  provincia: "1",
  localidad: "Cordoba",
  marca_vehiculo: "Ford",
  modelo_vehiculo: "Fiesta",
  anio_vehiculo: "2020",
  uso_vehiculo: "particular",
  cobertura_tipo: "terceros completo",
  suma_asegurada: "22400000",
};

const SAMPLE_RESULT: CotizacionResult = {
  ok: true,
  numeroCotizacion: "41318289",
  opciones: [{ plan: "ZURICH", premio: 110211, moneda: "ARS", cobertura: "terceros completo" }],
  rawAbsaResponse: {},
  obtenidoEn: "2026-08-20T12:00:00.000Z",
};

describe("hubspotPayloadToCotizacionInput", () => {
  beforeEach(() => resetHubspotPropertiesCache());

  it("mapea un payload completo a CotizacionInput", () => {
    const input = hubspotPayloadToCotizacionInput(VALID_PAYLOAD);

    expect(input.ramo).toBe("automotor");
    expect(input.asegurado).toMatchObject({
      nombre: "Juan",
      apellido: "Perez",
      documentoTipo: "DNI",
      documentoNumero: "30123456",
      fechaNacimiento: "1990-01-15",
      localidad: "Cordoba",
    });
    expect(input.objetoAsegurado.vehiculo).toMatchObject({
      marca: "Ford",
      modelo: "Fiesta",
      anio: 2020,
      usoTipo: "particular",
    });
    expect(input.cobertura).toMatchObject({ tipo: "terceros completo", sumaAsegurada: 22400000 });
    expect(input.absa).toBeUndefined(); // lo resuelve el worker por separado, no el mapper
  });

  it("acepta fecha ya en formato ISO sin tocarla", () => {
    const input = hubspotPayloadToCotizacionInput({ ...VALID_PAYLOAD, fecha_nacimiento: "1990-01-15" });
    expect(input.asegurado.fechaNacimiento).toBe("1990-01-15");
  });

  it("normaliza sexo y estado civil desde las etiquetas que manda HubSpot", () => {
    const input = hubspotPayloadToCotizacionInput(VALID_PAYLOAD);
    expect(input.asegurado.sexo).toBe("M");
    expect(input.asegurado.estadoCivil).toBe(2); // "Casado" -> 2

    // y tambien acepta el ID crudo o el texto en minusculas
    expect(hubspotPayloadToCotizacionInput({ ...VALID_PAYLOAD, sexo: "F", estado_civil: "7" }).asegurado).toMatchObject({
      sexo: "F",
      estadoCivil: 7,
    });
    expect(hubspotPayloadToCotizacionInput({ ...VALID_PAYLOAD, estado_civil: "soltero" }).asegurado.estadoCivil).toBe(1);
  });

  it("marca como dato faltante lo que ABSA exige y el lead no trae", () => {
    const { sexo, ...sinSexo } = VALID_PAYLOAD;
    expect(() => hubspotPayloadToCotizacionInput(sinSexo)).toThrow(/sexo/);

    const { fecha_nacimiento, ...sinFecha } = VALID_PAYLOAD;
    expect(() => hubspotPayloadToCotizacionInput(sinFecha)).toThrow(/fecha_nacimiento/);
  });

  it("sin estado civil asume Casado en vez de frenar el lead", () => {
    // El formulario no lo pregunta y ABSA lo exige; se manda 2 (Casado)
    // siempre. Cambia la prima, asi que la cotizacion queda orientativa.
    const { estado_civil, ...sinEstado } = VALID_PAYLOAD;
    expect(hubspotPayloadToCotizacionInput(sinEstado).asegurado.estadoCivil).toBe(2);
    // Un valor que no esta en el catalogo de ABSA cae al mismo default en vez
    // de mandar undefined y hacer que ABSA rechace la cotizacion con un 400.
    expect(hubspotPayloadToCotizacionInput({ ...VALID_PAYLOAD, estado_civil: "cualquier cosa" }).asegurado.estadoCivil).toBe(2);
  });

  it("cotiza un lead sin DNI: ABSA no lo exige, no es un lead incompleto", () => {
    const { dni, ...sinDni } = VALID_PAYLOAD;
    const input = hubspotPayloadToCotizacionInput(sinDni);
    expect(input.asegurado.documentoNumero).toBeUndefined();
  });

  it("lanza BusinessValidationError si falta un campo minimo (ej. marca_vehiculo)", () => {
    const { marca_vehiculo, ...withoutMarca } = VALID_PAYLOAD;
    expect(() => hubspotPayloadToCotizacionInput(withoutMarca)).toThrow(BusinessValidationError);
  });

  it("pasa el productor del formulario tal cual (la traduccion a un id de ABSA es de otro modulo)", () => {
    const input = hubspotPayloadToCotizacionInput({ ...VALID_PAYLOAD, productor: " Xango " });
    expect(input.productor).toBe("Xango");
  });

  it("sin productor no inventa ninguno: se cotiza con el de la plantilla comercial", () => {
    expect(hubspotPayloadToCotizacionInput({ ...VALID_PAYLOAD, productor: "  " }).productor).toBeUndefined();
    expect(hubspotPayloadToCotizacionInput(VALID_PAYLOAD).productor).toBeUndefined();
  });

  it("lanza BusinessValidationError si anio_vehiculo no es numerico", () => {
    expect(() => hubspotPayloadToCotizacionInput({ ...VALID_PAYLOAD, anio_vehiculo: "no-es-un-anio" })).toThrow(
      BusinessValidationError,
    );
  });
});

describe("cotizacionResultToDealProperties / errorToDealProperties / buildNoteBody", () => {
  beforeEach(() => resetHubspotPropertiesCache());

  it("mapea un resultado exitoso a propiedades de Deal, eligiendo la opcion mas barata", () => {
    const result: CotizacionResult = {
      ok: true,
      numeroCotizacion: "41318289",
      opciones: [
        { plan: "ZURICH", premio: 110211, moneda: "ARS", cobertura: "terceros completo" },
        { plan: "SANCOR", premio: 91541.2, moneda: "ARS", cobertura: "terceros completo" },
      ],
      rawAbsaResponse: {},
      obtenidoEn: "2026-08-20T12:00:00.000Z",
    };

    const { properties } = cotizacionResultToDealProperties(result);

    expect(properties.absa_estado).toBe("ok");
    expect(properties.absa_numero_cotizacion).toBe("41318289");
    expect(properties.absa_mejor_premio).toBe(91541.2);
    expect(properties.absa_mejor_aseguradora).toBe("SANCOR");
    expect(properties.absa_cantidad_opciones).toBe(2);
    expect(JSON.parse(String(properties.absa_opciones_json))).toHaveLength(2);
  });

  it("mapea un error a propiedades de Deal con el estado dado", () => {
    const { properties } = errorToDealProperties("error_catalogo_no_resuelto", "no se encontro el vehiculo");
    expect(properties.absa_estado).toBe("error_catalogo_no_resuelto");
    expect(properties.absa_error_mensaje).toBe("no se encontro el vehiculo");
  });

  it("arma el texto de la nota con el nombre del lead y el estado", () => {
    expect(buildNoteBody(VALID_PAYLOAD, "ok")).toContain("Juan Perez");
    expect(buildNoteBody(VALID_PAYLOAD, "ok")).toContain("estado: ok");
  });
});

/**
 * Caso real del portal: solo existen cuatro propiedades. Mandar una que no
 * existe hace que HubSpot rechace el PATCH entero con 400, asi que lo que no
 * esta mapeado NO se manda.
 *
 * `config` se congela al importarse y el mapper lo lee de ahi, asi que para
 * probar otro archivo de propiedades hay que reimportar los modulos con el env
 * ya cambiado (mismo patron que tests/absaTemplate.test.ts).
 */
async function conPropiedades(ruta: string) {
  vi.resetModules();
  process.env.HUBSPOT_PROPERTIES_PATH = ruta;
  return import("../src/integrations/hubspot/mapper.js");
}

describe("mapeo parcial de propiedades", () => {
  const rutaOriginal = process.env.HUBSPOT_PROPERTIES_PATH;

  afterEach(() => {
    process.env.HUBSPOT_PROPERTIES_PATH = rutaOriginal;
    vi.resetModules();
    resetHubspotPropertiesCache();
  });

  it("escribe solo las propiedades mapeadas", async () => {
    const mapper = await conPropiedades("tests/fixtures/hubspot-properties.parcial.test.json");
    const props = mapper.cotizacionResultToDealProperties(SAMPLE_RESULT).properties;

    expect(Object.keys(props).sort()).toEqual(["absa_estado", "absa_numero_cotizacion", "cotizacion_absa"]);
    expect(props.absa_estado).toBe("ok");
    expect(props.cotizacion_absa).toContain("/AutoCotizador/Cotizar/");
    // Las que no existen en el portal no viajan, ni siquiera vacias.
    expect(props).not.toHaveProperty("absa_mejor_premio");
    expect(props).not.toHaveProperty("absa_opciones_json");
  });

  it("el error usa el nombre real de la propiedad (plural) y saltea el resto", async () => {
    const mapper = await conPropiedades("tests/fixtures/hubspot-properties.parcial.test.json");
    const props = mapper.errorToDealProperties("error_absa", "se cayo ABSA").properties;

    expect(props.absa_error_mensajes).toBe("se cayo ABSA");
    expect(props).not.toHaveProperty("absa_cotizado_en");
  });

  it("una clave con typo falla al cargar, en vez de dejar de escribir esa propiedad en silencio", async () => {
    const rutaTypo = "tests/fixtures/hubspot-properties.typo.test.json";
    fs.writeFileSync(rutaTypo, JSON.stringify({ properties: { estdo: "absa_estado" } }));
    try {
      const mapper = await conPropiedades(rutaTypo);
      expect(() => mapper.enProcesoDealProperties()).toThrow(/invalido/i);
    } finally {
      fs.rmSync(rutaTypo, { force: true });
    }
  });
});
