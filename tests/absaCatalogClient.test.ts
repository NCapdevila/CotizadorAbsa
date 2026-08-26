import { afterEach, beforeEach, describe, expect, it } from "vitest";
import nock from "nock";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CookieJar } from "tough-cookie";
import { SessionManager } from "../src/session/sessionManager.js";
import { SessionStore } from "../src/session/sessionStore.js";
import type { AuthStrategy, SessionArtifact } from "../src/session/types.js";
import { AbsaHttpVehicleCatalogResolver } from "../src/quote/absaCatalogClient.js";
import { SessionExpiredError, VehicleCatalogUnresolvedError } from "../src/quote/errors.js";
import { config } from "../src/config.js";
import type { VehiculoInput } from "../src/quote/types.js";

class InstantAuthStrategy implements AuthStrategy {
  readonly name = "instant-stub";
  async login(): Promise<SessionArtifact> {
    return {
      cookieJarJson: new CookieJar().toJSON(),
      sessionToken: null,
      extraHeaders: {},
      createdAt: Date.now(),
      estimatedExpiresAt: null,
    };
  }
}

const VEHICULO: VehiculoInput = { marca: "FIAT", modelo: "ARGO", anio: 2022 };

/**
 * `/Localidad/GetLocalidad`: de donde sale la provincia. El portal la pide
 * siempre despues de resolver la localidad (es lo que llena el hidden
 * `DomicilioRiesgo.id_Provincia`), asi que todo test que resuelva un CP la
 * necesita mockeada.
 */
function mockGetLocalidad(idLocalidad = 313, idProvincia = 1) {
  return nock(config.ABSA_BASE_URL)
    .get("/Localidad/GetLocalidad")
    .query({ idLocalidad: String(idLocalidad) })
    .reply(200, {
      data: { id_Pais: 80, id_Provincia: idProvincia, id_Localidad: idLocalidad, provincia: "Capital Federal" },
      success: true,
    });
}

function combo(items: Array<{ text: string; value: string }>) {
  return { data: { items }, success: true, isValid: true, message: null };
}

/**
 * Confirmado en la captura real de Fase 0: el id_Entity lo asigna ABSA, no el
 * cliente. `GET /Cotizador/NuevaCotizacion` responde 302 con
 * `Location: /AutoCotizador/Cotizar/{id}?accion=1`.
 */
function mockNuevaCotizacion(idEntity = 20168012) {
  return nock(config.ABSA_BASE_URL)
    // .query({ idRiesgo: "9" }) es deliberado, no cosmetico: sin ese parametro
    // ABSA responde 200 en vez de 302 y no hay id_Entity. Si el cliente deja de
    // mandarlo, esta mock no matchea y el test falla.
    .get("/Cotizador/NuevaCotizacion")
    .query({ idRiesgo: "9" })
    .reply(302, "", { location: `/AutoCotizador/Cotizar/${idEntity}?accion=1` });
}

function buildResolver(storePath: string): AbsaHttpVehicleCatalogResolver {
  const manager = new SessionManager({
    credentials: { user: "u", password: "p" },
    authStrategy: new InstantAuthStrategy(),
    store: new SessionStore(storePath),
  });
  return new AbsaHttpVehicleCatalogResolver(manager);
}

describe("AbsaHttpVehicleCatalogResolver.resolve", () => {
  let storePath: string;

  beforeEach(() => {
    storePath = path.join(os.tmpdir(), `absa-catalog-test-${Date.now()}-${Math.random()}.json`);
    nock.cleanAll();
  });

  afterEach(() => {
    nock.cleanAll();
    if (fs.existsSync(storePath)) fs.unlinkSync(storePath);
  });

  it("resuelve marca/modelo/anio a los IDs internos reales de ABSA, probando candidatos hasta encontrar uno con el anio pedido", async () => {
    nock(config.ABSA_BASE_URL)
      .get("/Combo/GetVehiculos")
      .query({ q: "FIAT ARGO", sumaAseguradaMinima: "0" })
      .reply(
        200,
        combo([
          { text: "FIAT - ARGO 1.3 DRIVE CVT L/26", value: "170908" },
          { text: "FIAT - ARGO 1.8 PRECISION L/21", value: "170840" },
        ]),
      );
    // primer candidato (170908) no tiene 2022 disponible
    nock(config.ABSA_BASE_URL)
      .get("/Combo/GetAniosVehiculo")
      .query({ infoAuto: "170908", esInfoAuto: "true", sumaAseguradaMinima: "0" })
      .reply(200, combo([{ text: "2026", value: "2026" }]));
    // segundo candidato (170840) si tiene 2022
    nock(config.ABSA_BASE_URL)
      .get("/Combo/GetAniosVehiculo")
      .query({ infoAuto: "170840", esInfoAuto: "true", sumaAseguradaMinima: "0" })
      .reply(200, combo([{ text: "2022", value: "2022" }, { text: "2021", value: "2021" }]));
    nock(config.ABSA_BASE_URL)
      .get("/Data/GetVehiculoInfoAuto")
      .query({ infoAuto: "170840" })
      .reply(200, {
        data: {
          vehiculo: {
            id_Vehiculo: 14076,
            id_MarcaVehiculo: 17,
            id_ModeloVehiculo: 51,
            id_OrigenVehiculo: 1,
            id_TipoCombustible: 1,
            infoAuto: 170840,
            marca: "FIAT",
            modelo: "ARGO",
            descripcion: "FIAT - ARGO 1.8 PRECISION L/21",
          },
        },
        success: true,
      });
    nock(config.ABSA_BASE_URL)
      .get("/Localidad/GetLocalidadesApi")
      .query({ query: "1425" })
      .reply(200, combo([{ text: "(1425) CAPITAL FEDERAL", value: "313" }]));
    mockGetLocalidad(313);
    nock(config.ABSA_BASE_URL)
      .get("/Data/GetVehiculoSumaAsegurada")
      .query({ infoAuto: "170840", anio: "2022" })
      .reply(200, { data: { sumaAsegurada: 22400000 }, success: true });

    mockNuevaCotizacion(20168012);

    const resolver = buildResolver(storePath);
    const ids = await resolver.resolve(VEHICULO, "1425");

    expect(ids.idVehiculo).toBe(14076);
    expect(ids.idMarcaVehiculo).toBe(17);
    expect(ids.idModeloVehiculo).toBe(51);
    expect(ids.idOrigenVehiculo).toBe(1);
    expect(ids.infoAuto).toBe(170840);
    expect(ids.idLocalidad).toBe(313);
    // La provincia no se pide: sale de la localidad, como en el portal.
    expect(ids.idProvincia).toBe(1);
    expect(ids.sumaAseguradaSugerida).toBe(22400000);
    expect(ids.descripcion).toBe("FIAT - ARGO 1.8 PRECISION L/21");
    // El id_Entity sale del redirect de ABSA, NO de un random local.
    expect(ids.idEntity).toBe(20168012);
  });

  it("lanza VehicleCatalogUnresolvedError si GetVehiculos no devuelve candidatos", async () => {
    nock(config.ABSA_BASE_URL).get("/Combo/GetVehiculos").query(true).reply(200, combo([]));

    const resolver = buildResolver(storePath);
    await expect(resolver.resolve(VEHICULO, "1425")).rejects.toBeInstanceOf(VehicleCatalogUnresolvedError);
  });

  it("lanza VehicleCatalogUnresolvedError si ningun candidato tiene el anio pedido", async () => {
    nock(config.ABSA_BASE_URL)
      .get("/Combo/GetVehiculos")
      .query(true)
      .reply(200, combo([{ text: "FIAT - ARGO X", value: "1" }]));
    nock(config.ABSA_BASE_URL)
      .get("/Combo/GetAniosVehiculo")
      .query(true)
      .reply(200, combo([{ text: "2019", value: "2019" }]));

    const resolver = buildResolver(storePath);
    await expect(resolver.resolve(VEHICULO, "1425")).rejects.toBeInstanceOf(VehicleCatalogUnresolvedError);
  });

  it("lanza VehicleCatalogUnresolvedError si falta codigo postal/localidad para resolver el domicilio", async () => {
    nock(config.ABSA_BASE_URL)
      .get("/Combo/GetVehiculos")
      .query(true)
      .reply(200, combo([{ text: "FIAT - ARGO X", value: "170840" }]));
    nock(config.ABSA_BASE_URL)
      .get("/Combo/GetAniosVehiculo")
      .query(true)
      .reply(200, combo([{ text: "2022", value: "2022" }]));

    const resolver = buildResolver(storePath);
    await expect(resolver.resolve(VEHICULO, undefined)).rejects.toBeInstanceOf(VehicleCatalogUnresolvedError);
  });

  it("falla claro si /Cotizador/NuevaCotizacion redirige al login (sesion vencida)", async () => {
    nock(config.ABSA_BASE_URL)
      .get("/Combo/GetVehiculos")
      .query(true)
      .reply(200, combo([{ text: "FIAT - ARGO X", value: "170840" }]));
    nock(config.ABSA_BASE_URL).get("/Combo/GetAniosVehiculo").query(true).reply(200, combo([{ text: "2022", value: "2022" }]));
    nock(config.ABSA_BASE_URL)
      .get("/Data/GetVehiculoInfoAuto")
      .query(true)
      .reply(200, { data: { vehiculo: { id_Vehiculo: 1, id_MarcaVehiculo: 2, id_ModeloVehiculo: 3, id_OrigenVehiculo: 1 } } });
    nock(config.ABSA_BASE_URL)
      .get("/Localidad/GetLocalidadesApi")
      .query(true)
      .reply(200, combo([{ text: "(1425) CAPITAL FEDERAL", value: "313" }]));
    mockGetLocalidad(313);
    nock(config.ABSA_BASE_URL).get("/Data/GetVehiculoSumaAsegurada").query(true).reply(200, { data: { sumaAsegurada: 1 } });
    // sesion vencida: ABSA manda al login en vez del cotizador
    nock(config.ABSA_BASE_URL).get("/Cotizador/NuevaCotizacion").query(true).reply(302, "", { location: "/?returnUrl=%2F" });

    const resolver = buildResolver(storePath);
    await expect(resolver.resolve(VEHICULO, "1425")).rejects.toThrow(/sesion vencida|no tiene la forma/i);
  });

  it("falla claro si responde 200 y tampoco trae el id_Entity en el cuerpo", async () => {
    nock(config.ABSA_BASE_URL)
      .get("/Combo/GetVehiculos")
      .query(true)
      .reply(200, combo([{ text: "FIAT - ARGO X", value: "170840" }]));
    nock(config.ABSA_BASE_URL).get("/Combo/GetAniosVehiculo").query(true).reply(200, combo([{ text: "2022", value: "2022" }]));
    nock(config.ABSA_BASE_URL)
      .get("/Data/GetVehiculoInfoAuto")
      .query(true)
      .reply(200, { data: { vehiculo: { id_Vehiculo: 1, id_MarcaVehiculo: 2, id_ModeloVehiculo: 3, id_OrigenVehiculo: 1 } } });
    nock(config.ABSA_BASE_URL)
      .get("/Localidad/GetLocalidadesApi")
      .query(true)
      .reply(200, combo([{ text: "(1425) CAPITAL FEDERAL", value: "313" }]));
    mockGetLocalidad(313);
    nock(config.ABSA_BASE_URL).get("/Data/GetVehiculoSumaAsegurada").query(true).reply(200, { data: { sumaAsegurada: 1 } });
    nock(config.ABSA_BASE_URL).get("/Cotizador/NuevaCotizacion").query(true).reply(200, "<html>cotizador sin id</html>");

    const resolver = buildResolver(storePath);
    await expect(resolver.resolve(VEHICULO, "1425")).rejects.toThrow(/sin header Location y sin un id_Entity/i);
  });

  it("si ABSA devuelve 200 con la pagina renderizada, saca el id_Entity del hidden del form", async () => {
    nock(config.ABSA_BASE_URL)
      .get("/Combo/GetVehiculos")
      .query(true)
      .reply(200, combo([{ text: "FIAT - ARGO X", value: "170840" }]));
    nock(config.ABSA_BASE_URL).get("/Combo/GetAniosVehiculo").query(true).reply(200, combo([{ text: "2022", value: "2022" }]));
    nock(config.ABSA_BASE_URL)
      .get("/Data/GetVehiculoInfoAuto")
      .query(true)
      .reply(200, { data: { vehiculo: { id_Vehiculo: 1, id_MarcaVehiculo: 2, id_ModeloVehiculo: 3, id_OrigenVehiculo: 1 } } });
    nock(config.ABSA_BASE_URL)
      .get("/Localidad/GetLocalidadesApi")
      .query(true)
      .reply(200, combo([{ text: "(1425) CAPITAL FEDERAL", value: "313" }]));
    mockGetLocalidad(313);
    nock(config.ABSA_BASE_URL).get("/Data/GetVehiculoSumaAsegurada").query(true).reply(200, { data: { sumaAsegurada: 1 } });
    nock(config.ABSA_BASE_URL)
      .get("/Cotizador/NuevaCotizacion")
      .query(true)
      .reply(200, '<form><input id="idEntity" name="id_Entity" type="hidden" value="20174384" /></form>');

    const resolver = buildResolver(storePath);
    const ids = await resolver.resolve(VEHICULO, "1425");
    expect(ids.idEntity).toBe(20174384);
  });

  it("si ABSA sirve la pagina de login con 200 (sesion vencida), relogea y reintenta solo", async () => {
    // Confirmado en produccion: ABSA no da 401, devuelve el HTML del login con
    // status 200 incluso en endpoints que normalmente son JSON.
    // El "\r\n" adelante es el de la respuesta real: por eso la deteccion usa
    // trimStart() y no un startsWith() pelado.
    const LOGIN_HTML = '\r\n<!DOCTYPE html><html><body><form id="loginForm"></form></body></html>';
    nock(config.ABSA_BASE_URL)
      .get("/Combo/GetVehiculos")
      .query(true)
      .reply(200, LOGIN_HTML, { "content-type": "text/html; charset=utf-8" });

    // Tras el relogin, el mismo pedido ya responde JSON y el flujo sigue normal.
    nock(config.ABSA_BASE_URL)
      .get("/Combo/GetVehiculos")
      .query(true)
      .reply(200, combo([{ text: "FIAT - ARGO 1.8", value: "170840" }]));
    nock(config.ABSA_BASE_URL).get("/Combo/GetAniosVehiculo").query(true).reply(200, combo([{ text: "2022", value: "2022" }]));
    nock(config.ABSA_BASE_URL)
      .get("/Data/GetVehiculoInfoAuto")
      .query(true)
      .reply(200, { data: { vehiculo: { id_Vehiculo: 14076, id_MarcaVehiculo: 17, id_ModeloVehiculo: 51, id_OrigenVehiculo: 1 } } });
    nock(config.ABSA_BASE_URL)
      .get("/Localidad/GetLocalidadesApi")
      .query(true)
      .reply(200, combo([{ text: "(1425) CAPITAL FEDERAL", value: "313" }]));
    mockGetLocalidad(313);
    nock(config.ABSA_BASE_URL).get("/Data/GetVehiculoSumaAsegurada").query(true).reply(200, { data: { sumaAsegurada: 1 } });
    mockNuevaCotizacion(20174384);

    const resolver = buildResolver(storePath);
    const ids = await resolver.resolve(VEHICULO, "1425");
    expect(ids.idVehiculo).toBe(14076);
    expect(ids.idEntity).toBe(20174384);
  });

  it("si la sesion sigue vencida despues de relogear, propaga SessionExpiredError (no lo disfraza de vehiculo inexistente)", async () => {
    const LOGIN_HTML = "<!DOCTYPE html><html><body>login</body></html>";
    nock(config.ABSA_BASE_URL)
      .get("/Combo/GetVehiculos")
      .query(true)
      .twice()
      .reply(200, LOGIN_HTML, { "content-type": "text/html; charset=utf-8" });

    const resolver = buildResolver(storePath);
    // Distinguirlo importa: el worker trata "vehiculo inexistente" como
    // terminal y "sesion vencida" como reintentable.
    await expect(resolver.resolve(VEHICULO, "1425")).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it("envuelve cualquier error tecnico inesperado como VehicleCatalogUnresolvedError", async () => {
    nock(config.ABSA_BASE_URL).get("/Combo/GetVehiculos").query(true).reply(500, "error interno");

    const resolver = buildResolver(storePath);
    await expect(resolver.resolve(VEHICULO, "1425")).rejects.toBeInstanceOf(VehicleCatalogUnresolvedError);
  });
});

/**
 * El combo de ABSA viene ordenado por InfoAuto descendente (version mas nueva
 * primero), no por relevancia: quedarse con el primero era quedarse con la
 * version mas nueva del modelo, no con la del cliente.
 */
describe("AbsaHttpVehicleCatalogResolver: eleccion de localidad", () => {
  let storePath: string;

  beforeEach(() => {
    storePath = path.join(os.tmpdir(), `absa-localidad-test-${Date.now()}-${Math.random()}.json`);
    nock.cleanAll();
  });

  afterEach(() => {
    fs.rmSync(storePath, { force: true });
    nock.cleanAll();
  });

  /** Los mocks del vehiculo, que en estos tests no son lo que se prueba. */
  function mockVehiculo() {
    nock(config.ABSA_BASE_URL)
      .get("/Combo/GetVehiculos")
      .query(true)
      .times(2)
      .reply(200, combo([{ text: "FIAT - ARGO 1.8 PRECISION", value: "170840" }]));
    nock(config.ABSA_BASE_URL)
      .get("/Combo/GetAniosVehiculo")
      .query(true)
      .reply(200, combo([{ text: "2022", value: "2022" }]));
    nock(config.ABSA_BASE_URL)
      .get("/Data/GetVehiculoInfoAuto")
      .query(true)
      .reply(200, {
        data: {
          vehiculo: {
            id_Vehiculo: 14076,
            id_MarcaVehiculo: 17,
            id_ModeloVehiculo: 51,
            id_OrigenVehiculo: 1,
            descripcion: "FIAT - ARGO 1.8 PRECISION",
          },
        },
        success: true,
      });
    nock(config.ABSA_BASE_URL).get("/Data/GetVehiculoSumaAsegurada").query(true).reply(200, { data: {}, success: true });
    mockNuevaCotizacion(20168012);
  }

  /** El CP 1849 tiene varias localidades y la primera NO es Claypole. */
  function mockCp1849() {
    nock(config.ABSA_BASE_URL)
      .get("/Localidad/GetLocalidadesApi")
      .query({ query: "1849" })
      .reply(
        200,
        combo([
          { text: "(1849) BARRIO PARQUE (Buenos Aires)", value: "2701" },
          { text: "(1849) CLAYPOLE (Buenos Aires)", value: "2702" },
          { text: "(1849) DON ORIONE (Buenos Aires)", value: "2703" },
        ]),
      );
  }

  it("con el nombre del formulario elige esa localidad, no la primera del combo", async () => {
    mockVehiculo();
    mockCp1849();
    mockGetLocalidad(2702, 2);

    const ids = await buildResolver(storePath).resolve(VEHICULO, "1849", "Claypole");
    expect(ids.idLocalidad).toBe(2702);
    expect(ids.idProvincia).toBe(2);
  });

  it("sin nombre se toma la primera, como antes", async () => {
    mockVehiculo();
    mockCp1849();
    mockGetLocalidad(2701, 2);

    const ids = await buildResolver(storePath).resolve(VEHICULO, "1849");
    expect(ids.idLocalidad).toBe(2701);
  });

  it("un nombre que no se parece a ninguna no rompe: cae a la primera", async () => {
    mockVehiculo();
    mockCp1849();
    mockGetLocalidad(2701, 2);

    const ids = await buildResolver(storePath).resolve(VEHICULO, "1849", "Rosario");
    expect(ids.idLocalidad).toBe(2701);
  });
});

describe("AbsaHttpVehicleCatalogResolver: eleccion de version", () => {
  let storePath: string;

  const TRACKER: VehiculoInput = { marca: "CHEVROLET", modelo: "TRACKER", anio: 2021, version: "1.2T AT PREMIER" };

  beforeEach(() => {
    storePath = path.join(os.tmpdir(), `absa-catalog-test-${Date.now()}-${Math.random()}.json`);
    nock.cleanAll();
  });

  afterEach(() => {
    nock.cleanAll();
    if (fs.existsSync(storePath)) fs.unlinkSync(storePath);
  });

  function mockResto(infoAuto: string, descripcion: string) {
    nock(config.ABSA_BASE_URL)
      .get("/Combo/GetAniosVehiculo")
      .query({ infoAuto, esInfoAuto: "true", sumaAseguradaMinima: "0" })
      .reply(200, combo([{ text: "2021", value: "2021" }]));
    nock(config.ABSA_BASE_URL)
      .get("/Data/GetVehiculoInfoAuto")
      .query({ infoAuto })
      .reply(200, {
        data: {
          vehiculo: {
            id_Vehiculo: 13579,
            id_MarcaVehiculo: 9,
            id_ModeloVehiculo: 220,
            id_OrigenVehiculo: 1,
            descripcion,
          },
        },
      });
    nock(config.ABSA_BASE_URL)
      .get("/Localidad/GetLocalidadesApi")
      .query({ query: "1425" })
      .reply(200, combo([{ text: "(1425) CAPITAL FEDERAL", value: "313" }]));
    mockGetLocalidad(313);
    nock(config.ABSA_BASE_URL).get("/Data/GetVehiculoSumaAsegurada").query(true).reply(200, { data: { sumaAsegurada: 22000000 } });
    mockNuevaCotizacion(24104663);
  }

  it("elige la version mas parecida a la pedida, no la primera del combo", async () => {
    nock(config.ABSA_BASE_URL)
      .get("/Combo/GetVehiculos")
      .query({ q: "CHEVROLET TRACKER", sumaAseguradaMinima: "0" })
      .reply(
        200,
        combo([
          { text: "CHEVROLET - CHEVROLET - TRACKER 1.2 TURBO AT6", value: "120588" },
          { text: "CHEVROLET - CHEVROLET - TRACKER 1.2 TURBO AT6 PREMIER", value: "120590" },
          { text: "CHEVROLET - CHEVROLET - TRACKER 1.8 LTZ AT", value: "110220" },
        ]),
      );
    nock(config.ABSA_BASE_URL)
      .get("/Combo/GetVehiculos")
      .query({ q: "CHEVROLET TRACKER 1.2 TURBO AT PREMIER", sumaAseguradaMinima: "0" })
      .reply(200, combo([{ text: "CHEVROLET - CHEVROLET - TRACKER 1.2 TURBO AT6 PREMIER", value: "120590" }]));
    mockResto("120590", "CHEVROLET - TRACKER 1.2 TURBO AT6 PREMIER");

    const ids = await buildResolver(storePath).resolve(TRACKER, "1425");

    expect(ids.infoAuto).toBe(120590);
    expect(ids.descripcion).toBe("CHEVROLET - TRACKER 1.2 TURBO AT6 PREMIER");
    expect(ids.similitudVersion).toBe(100);
    // Las otras quedan a mano para revisar o para repetir clavando el InfoAuto.
    expect(ids.alternativas?.map((a) => a.infoAuto)).toEqual([120588, 110220]);
  });

  it("suma los resultados de la busqueda refinada: ABSA corta el combo y la version buena puede no estar en la amplia", async () => {
    nock(config.ABSA_BASE_URL)
      .get("/Combo/GetVehiculos")
      .query({ q: "CHEVROLET TRACKER", sumaAseguradaMinima: "0" })
      .reply(200, combo([{ text: "CHEVROLET - CHEVROLET - TRACKER 1.8 LTZ AT", value: "110220" }]));
    nock(config.ABSA_BASE_URL)
      .get("/Combo/GetVehiculos")
      .query({ q: "CHEVROLET TRACKER 1.2 TURBO AT PREMIER", sumaAseguradaMinima: "0" })
      .reply(200, combo([{ text: "CHEVROLET - CHEVROLET - TRACKER 1.2 TURBO AT6 PREMIER", value: "120590" }]));
    mockResto("120590", "CHEVROLET - TRACKER 1.2 TURBO AT6 PREMIER");

    const ids = await buildResolver(storePath).resolve(TRACKER, "1425");
    expect(ids.infoAuto).toBe(120590);
  });

  it("si el mas parecido no tiene el anio pedido, sigue con el siguiente mas parecido", async () => {
    nock(config.ABSA_BASE_URL)
      .get("/Combo/GetVehiculos")
      .query({ q: "CHEVROLET TRACKER", sumaAseguradaMinima: "0" })
      .reply(
        200,
        combo([
          { text: "CHEVROLET - CHEVROLET - TRACKER 1.2 TURBO AT6 PREMIER L/24", value: "125001" },
          { text: "CHEVROLET - CHEVROLET - TRACKER 1.2 TURBO AT6 PREMIER", value: "120590" },
        ]),
      );
    nock(config.ABSA_BASE_URL).get("/Combo/GetVehiculos").query({ q: "CHEVROLET TRACKER 1.2 TURBO AT PREMIER", sumaAseguradaMinima: "0" }).reply(200, combo([]));
    // El L/24 es 2024 en adelante: no cotiza para 2021.
    nock(config.ABSA_BASE_URL)
      .get("/Combo/GetAniosVehiculo")
      .query({ infoAuto: "125001", esInfoAuto: "true", sumaAseguradaMinima: "0" })
      .reply(200, combo([{ text: "2024", value: "2024" }]));
    mockResto("120590", "CHEVROLET - TRACKER 1.2 TURBO AT6 PREMIER");

    const ids = await buildResolver(storePath).resolve(TRACKER, "1425");
    expect(ids.infoAuto).toBe(120590);
  });

  it("con codigoCatalogo (InfoAuto clavado) no busca nada en el catalogo", async () => {
    // No hay mock de /Combo/GetVehiculos a proposito: si el resolver buscara,
    // nock cortaria la request y el test fallaria.
    mockResto("120590", "CHEVROLET - TRACKER 1.2 TURBO AT6 PREMIER");

    const ids = await buildResolver(storePath).resolve({ ...TRACKER, codigoCatalogo: "120590" }, "1425");

    expect(ids.infoAuto).toBe(120590);
    expect(ids.descripcion).toBe("CHEVROLET - TRACKER 1.2 TURBO AT6 PREMIER");
    // Un InfoAuto clavado no se "parece" a nada: lo eligio una persona.
    expect(ids.similitudVersion).toBeUndefined();
  });

  it("rechaza un codigoCatalogo que no sea un InfoAuto numerico", async () => {
    await expect(
      buildResolver(storePath).resolve({ ...TRACKER, codigoCatalogo: "TRACKER PREMIER" }, "1425"),
    ).rejects.toBeInstanceOf(VehicleCatalogUnresolvedError);
  });

  it("sin version pedida no reporta similitud (no hay con que elegir) y respeta el orden de ABSA", async () => {
    nock(config.ABSA_BASE_URL)
      .get("/Combo/GetVehiculos")
      .query({ q: "CHEVROLET TRACKER", sumaAseguradaMinima: "0" })
      .reply(
        200,
        combo([
          { text: "CHEVROLET - CHEVROLET - TRACKER 1.2 TURBO AT6", value: "120588" },
          { text: "CHEVROLET - CHEVROLET - TRACKER 1.2 TURBO AT6 PREMIER", value: "120590" },
        ]),
      );
    mockResto("120588", "CHEVROLET - TRACKER 1.2 TURBO AT6");

    const ids = await buildResolver(storePath).resolve({ marca: "CHEVROLET", modelo: "TRACKER", anio: 2021 }, "1425");

    expect(ids.infoAuto).toBe(120588);
    expect(ids.similitudVersion).toBeUndefined();
  });

  it("cuando ninguno tiene el anio, el error dice cuales eran los mas parecidos", async () => {
    nock(config.ABSA_BASE_URL)
      .get("/Combo/GetVehiculos")
      .query(true)
      .twice()
      .reply(200, combo([{ text: "CHEVROLET - CHEVROLET - TRACKER 1.2 TURBO AT6 PREMIER", value: "120590" }]));
    nock(config.ABSA_BASE_URL).get("/Combo/GetAniosVehiculo").query(true).reply(200, combo([{ text: "2024", value: "2024" }]));

    await expect(buildResolver(storePath).resolve(TRACKER, "1425")).rejects.toThrow(/TRACKER 1\.2 TURBO AT6 PREMIER.*100%/);
  });
});
