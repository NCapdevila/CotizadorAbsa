import { afterEach, beforeEach, describe, expect, it } from "vitest";
import nock from "nock";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CookieJar } from "tough-cookie";
import { SessionManager } from "../src/session/sessionManager.js";
import { SessionStore } from "../src/session/sessionStore.js";
import type { AuthStrategy, SessionArtifact } from "../src/session/types.js";
import { AbsaComercialConfigClient } from "../src/quote/absaComercialClient.js";
import { QuoteClient } from "../src/quote/quoteClient.js";
import { config } from "../src/config.js";
import type { CotizacionInput } from "../src/quote/types.js";
import type { ProductorMapeado } from "../src/quote/productoresConfig.js";
import { loadComercialTemplate } from "../src/quote/absaTemplate.js";

class InstantAuthStrategy implements AuthStrategy {
  readonly name = "instant-stub";
  loginCalls = 0;

  async login(): Promise<SessionArtifact> {
    this.loginCalls++;
    return {
      cookieJarJson: new CookieJar().toJSON(),
      sessionToken: null,
      extraHeaders: {},
      createdAt: Date.now(),
      estimatedExpiresAt: null,
    };
  }
}

/** `idProductor` que NO es el de tests/fixtures/absa-comercial.test.json: obliga a pedirle la config a ABSA. */
const OTRO_PRODUCTOR = 9767;

const VIEW_HTML = `
<div id="condicionesAseguradoras">
<input Name="Comercial.ConfigCotizacion.Aseguradoras[0].id_Aseguradora" id="id_Aseguradora0" name="id_Aseguradora" type="hidden" value="2" />
<input Name="Comercial.ConfigCotizacion.Aseguradoras[0].Aseguradora" id="Aseguradora0" name="Aseguradora" type="hidden" value="ZURICH" />
<input Name="Comercial.ConfigCotizacion.Aseguradoras[1].id_Aseguradora" id="id_Aseguradora1" name="id_Aseguradora" type="hidden" value="68" />
<input Name="Comercial.ConfigCotizacion.Aseguradoras[1].Aseguradora" id="Aseguradora1" name="Aseguradora" type="hidden" value="FEDERACION" />
<select name="Comercial.RebajaZurich" id="RebajaZurich">
  <option value="0" selected="selected">0</option>
  <option value="25">25</option>
</select>
</div>
`;

function combo(items: Array<{ text: string; value: string }>) {
  return { data: { items }, success: true, isValid: true, message: null };
}

function mockConfiguraciones(idProductor = OTRO_PRODUCTOR, items = [{ text: "STD XANGO", value: "4444" }]) {
  return nock(config.ABSA_BASE_URL)
    .get("/Combo/GetConfiguracionesWS")
    .query({ idOrganizador: "1", idProductor: String(idProductor), idRiesgo: "9" })
    .reply(200, combo(items));
}

function mockComision(idProductor = OTRO_PRODUCTOR, comisionPrincipal = 15) {
  return nock(config.ABSA_BASE_URL)
    .get("/Data/GetPaquetesComision")
    .query({ idOrganizador: "1", idProductor: String(idProductor), idRiesgo: "9", idAseguradora: "", comision: "0" })
    .reply(200, { data: { comisiones: [10, 15, 20], comisionPrincipal, comisionOrg: 3 }, success: true });
}

function mockCondiciones(
  idProductor = OTRO_PRODUCTOR,
  body: Record<string, unknown> = { Estado: 1, View: VIEW_HTML },
) {
  return nock(config.ABSA_BASE_URL)
    .get("/AutoCotizador/ObtenerConfigCotizador")
    .query({ idProductor: String(idProductor) })
    .reply(200, body);
}

const ENTRADA: ProductorMapeado = { clave: "xango", idProductor: OTRO_PRODUCTOR, alias: [] };

describe("AbsaComercialConfigClient.resolverTemplate", () => {
  let storePath: string;
  let cliente: AbsaComercialConfigClient;

  beforeEach(() => {
    storePath = path.join(os.tmpdir(), `absa-comercial-test-${Date.now()}-${Math.random()}.json`);
    cliente = new AbsaComercialConfigClient(
      new SessionManager({
        credentials: { user: "u", password: "p" },
        authStrategy: new InstantAuthStrategy(),
        store: new SessionStore(storePath),
      }),
    );
    nock.cleanAll();
  });

  afterEach(() => {
    fs.rmSync(storePath, { force: true });
    nock.cleanAll();
  });

  it("arma la plantilla del productor con las tres requests que hace el portal", async () => {
    mockConfiguraciones();
    mockComision();
    mockCondiciones();

    const template = await cliente.resolverTemplate(ENTRADA, loadComercialTemplate());

    expect(template.idProductor).toBe(OTRO_PRODUCTOR);
    expect(template.idConfiguracion).toBe(4444);
    expect(template.comision).toBe(15);
    expect(template.aseguradoras.map((a) => a.nombre)).toEqual(["ZURICH", "FEDERACION"]);
    expect(nock.isDone()).toBe(true);
  });

  it("usa las condiciones comerciales de la plantilla, que son las mismas para todos los productores", async () => {
    mockConfiguraciones();
    mockComision();
    mockCondiciones();

    const base = loadComercialTemplate();
    expect(base.camposPorAseguradora["Comercial.RebajaZurich"]).toBe(30);

    // El default que ABSA devuelve para este productor es 0 (ver VIEW_HTML):
    // si se cotizara con eso, la prima saldria mas cara que cotizando a mano.
    const template = await cliente.resolverTemplate(ENTRADA, base);
    expect(template.camposPorAseguradora["Comercial.RebajaZurich"]).toBe(30);
  });

  it("de ABSA toma lo que SI cambia por productor: configuracion, comision y aseguradoras", async () => {
    mockConfiguraciones();
    mockComision();
    mockCondiciones();

    const template = await cliente.resolverTemplate(ENTRADA, loadComercialTemplate());
    expect(template.idConfiguracion).toBe(4444);
    expect(template.comision).toBe(15);
    expect(template.aseguradoras.map((a) => a.nombre)).toEqual(["ZURICH", "FEDERACION"]);
  });

  it("un override de la entrada gana sobre la plantilla, y la comisionOrg sale del productor", async () => {
    mockConfiguraciones();
    mockComision();
    mockCondiciones();

    const template = await cliente.resolverTemplate(
      { ...ENTRADA, campos: { "Comercial.RebajaZurich": 25 } },
      loadComercialTemplate(),
    );

    expect(template.camposPorAseguradora["Comercial.RebajaZurich"]).toBe(25);
    // El mapper escribe ComisionOrg en 0 y despues aplica camposPorAseguradora
    // encima: si esto no viaja, se cotiza con la comision de organizador de otro.
    expect(template.camposPorAseguradora["Comercial.ConfigCotizacion.ComisionOrg"]).toBe(3);
  });

  it("cachea por productor: el segundo lead del mismo no vuelve a pedirle la config a ABSA", async () => {
    mockConfiguraciones();
    mockComision();
    mockCondiciones();

    await cliente.resolverTemplate(ENTRADA, loadComercialTemplate());
    expect(nock.isDone()).toBe(true);

    // Sin interceptores cargados: si intentara pegar de nuevo, nock lo cortaria.
    const template = await cliente.resolverTemplate(ENTRADA, loadComercialTemplate());
    expect(template.idConfiguracion).toBe(4444);
  });

  it("un productor que la cuenta no tiene habilitado es error de negocio, con el motivo de ABSA", async () => {
    mockConfiguraciones();
    mockComision();
    mockCondiciones(OTRO_PRODUCTOR, { Estado: 0, Mensaje: "El productor no pertenece al organizador." });

    await expect(cliente.resolverTemplate(ENTRADA, loadComercialTemplate())).rejects.toThrow(/no pertenece al organizador/i);
  });

  it("un 200 con el cuerpo vacio es sesion vencida (asi contesta ABSA): relogea y reintenta", async () => {
    // Confirmado contra produccion el 2026-08-25: con la sesion vieja, todos
    // los endpoints JSON contestan 200 sin un byte. Sin detectarlo, el sintoma
    // era "Unexpected end of JSON input", que no se parece a una sesion vencida.
    nock(config.ABSA_BASE_URL).get("/Combo/GetConfiguracionesWS").query(true).reply(200, "");

    mockConfiguraciones();
    mockComision();
    mockCondiciones();

    const template = await cliente.resolverTemplate(ENTRADA, loadComercialTemplate());
    expect(template.idConfiguracion).toBe(4444);
    expect(nock.isDone()).toBe(true);
  });

  it("si ABSA contesta el login (sesion vencida), relogea y reintenta una vez", async () => {
    // Sesion vencida: ABSA responde 200 con HTML del login en un endpoint JSON.
    nock(config.ABSA_BASE_URL)
      .get("/Combo/GetConfiguracionesWS")
      .query(true)
      .reply(200, "<html><body>login</body></html>", { "content-type": "text/html" });

    mockConfiguraciones();
    mockComision();
    mockCondiciones();

    const template = await cliente.resolverTemplate(ENTRADA, loadComercialTemplate());
    expect(template.idConfiguracion).toBe(4444);
    expect(nock.isDone()).toBe(true);
  });
});

describe("QuoteClient: con que productor se cotiza", () => {
  let storePath: string;
  let quoteClient: QuoteClient;

  const INPUT: CotizacionInput = {
    ramo: "automotor",
    asegurado: { nombre: "Juan", apellido: "Perez", fechaNacimiento: "1990-01-15", sexo: "M", estadoCivil: 2 },
    objetoAsegurado: { tipo: "vehiculo", vehiculo: { marca: "Ford", modelo: "Fiesta", anio: 2020 } },
    cobertura: { tipo: "terceros completo" },
  };

  beforeEach(() => {
    storePath = path.join(os.tmpdir(), `absa-quote-productor-test-${Date.now()}-${Math.random()}.json`);
    const sessionManager = new SessionManager({
      credentials: { user: "u", password: "p" },
      authStrategy: new InstantAuthStrategy(),
      store: new SessionStore(storePath),
    });
    quoteClient = new QuoteClient(sessionManager);
    nock.cleanAll();
  });

  afterEach(() => {
    fs.rmSync(storePath, { force: true });
    nock.cleanAll();
  });

  it("sin productor cotiza con la plantilla de archivo y no le pide nada a ABSA", async () => {
    const template = await quoteClient.templateComercialPara(INPUT);
    expect(template.idProductor).toBe(loadComercialTemplate().idProductor);
  });

  it("si el productor del lead es el de la plantilla, tampoco pide nada (y conserva sus rebajas)", async () => {
    const template = await quoteClient.templateComercialPara({ ...INPUT, productor: "ardama" });
    expect(template.camposPorAseguradora["Comercial.RebajaZurich"]).toBe(30);
  });

  it("con otro productor pide la config comercial a ABSA", async () => {
    mockConfiguraciones();
    mockComision();
    mockCondiciones();

    const template = await quoteClient.templateComercialPara({ ...INPUT, productor: "xango" });
    expect(template.idProductor).toBe(OTRO_PRODUCTOR);
    // El override del mapeo de prueba (tests/fixtures/absa-productores.test.json).
    expect(template.camposPorAseguradora["Comercial.RebajaZurich"]).toBe(25);
  });

  /**
   * El mapeo se arma a mano y siempre va atrasado: cuando entra una
   * concesionaria nueva al formulario, sus leads cotizaban con el productor por
   * defecto hasta que alguien se acordara de agregarla. Caso real del
   * 2026-08-28: "NFR MOTORS" existe en ABSA (id 11795) y cotizo con ARDAMA.
   */
  it("un productor sin mapear pero inequivoco en ABSA cotiza con el suyo", async () => {
    nock(config.ABSA_BASE_URL)
      .get("/Combo/GetProductoresIncremental")
      .query(true)
      .times(3)
      .reply(200, { data: { items: [{ value: String(OTRO_PRODUCTOR), text: "NFR MOTORS" }] } });
    mockConfiguraciones();
    mockComision();
    mockCondiciones();

    const template = await quoteClient.templateComercialPara({ ...INPUT, productor: "NFR MOTORS" });
    expect(template.idProductor).toBe(OTRO_PRODUCTOR);
  });

  /**
   * La razon por la que el umbral es "exactamente uno al 100%" y no "el mas
   * parecido". Con los datos reales de ABSA, "Car West" empata CAR WEST C
   * (7952) y CAR, WEST M (7953): elegir cualquiera es cotizar con el acuerdo
   * comercial del de al lado, sin ningun sintoma visible.
   */
  it("si varios matchean por igual no elige ninguno: cae al productor por defecto", async () => {
    nock(config.ABSA_BASE_URL)
      .get("/Combo/GetProductoresIncremental")
      .query(true)
      .times(3)
      .reply(200, {
        data: {
          items: [
            { value: "7952", text: "CAR WEST C" },
            { value: "7953", text: "CAR, WEST M" },
          ],
        },
      });

    const template = await quoteClient.templateComercialPara({ ...INPUT, productor: "Car West" });
    expect(template.idProductor).toBe(loadComercialTemplate().idProductor);
  });

  it("un productor que no esta ni en el mapeo ni en ABSA cotiza con el de defecto, sin frenar el lead", async () => {
    nock(config.ABSA_BASE_URL).get("/Combo/GetProductoresIncremental").query(true).times(3).reply(200, { data: { items: [] } });

    const template = await quoteClient.templateComercialPara({ ...INPUT, productor: "Autos del Sur" });
    expect(template.idProductor).toBe(loadComercialTemplate().idProductor);
    expect(template.camposPorAseguradora["Comercial.RebajaZurich"]).toBe(30);
  });

  it("si la busqueda en ABSA falla, el lead no se frena: sigue con el mapeo", async () => {
    nock(config.ABSA_BASE_URL).get("/Combo/GetProductoresIncremental").query(true).times(3).reply(500, "boom");

    const template = await quoteClient.templateComercialPara({ ...INPUT, productor: "Autos del Sur" });
    expect(template.idProductor).toBe(loadComercialTemplate().idProductor);
  });
});
