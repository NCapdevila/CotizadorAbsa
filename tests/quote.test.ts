import { afterEach, beforeEach, describe, expect, it } from "vitest";
import nock from "nock";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CookieJar } from "tough-cookie";
import { SessionManager } from "../src/session/sessionManager.js";
import { SessionStore } from "../src/session/sessionStore.js";
import type { AuthStrategy, SessionArtifact } from "../src/session/types.js";
import { QuoteClient } from "../src/quote/quoteClient.js";
import { assertDatosAseguradoCompletos, descripcionCotizacion, toAbsaCotizarPayload } from "../src/quote/mapper.js";
import { loadComercialTemplate } from "../src/quote/absaTemplate.js";
import { BusinessValidationError, SessionExpiredError, UpstreamChangedError } from "../src/quote/errors.js";
import { config } from "../src/config.js";
import type { CotizacionInput } from "../src/quote/types.js";

/** Estrategia de auth stub: nunca pega a la red, cuenta cuantas veces se llamo. */
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

const SAMPLE_INPUT: CotizacionInput = {
  ramo: "automotor",
  asegurado: {
    nombre: "Juan",
    apellido: "Perez",
    documentoTipo: "DNI",
    documentoNumero: "12345678",
    fechaNacimiento: "1990-01-15",
    sexo: "M",
    estadoCivil: 2,
    provincia: "1",
  },
  objetoAsegurado: {
    tipo: "vehiculo",
    vehiculo: { marca: "Ford", modelo: "Fiesta", anio: 2020, usoTipo: "particular" },
  },
  cobertura: { tipo: "terceros completo", sumaAsegurada: 22400000 },
  absa: {
    idEntity: 19156383,
    idVehiculo: 14076,
    idMarcaVehiculo: 17,
    idModeloVehiculo: 51,
    idOrigenVehiculo: 1,
    infoAuto: 170840,
    idLocalidad: 313,
  },
};

/** HTML minimo con el token anti-forgery, como el que devuelve el GET del cotizador. */
const PAGE_WITH_TOKEN_HTML = `<html><body><form>
  <input type="hidden" name="__RequestVerificationToken" value="test-csrf-token" />
</form></body></html>`;

/** HTML minimo de la respuesta del POST principal: el nroCotizacion va embebido en un script inline `cotizar(...)`, confirmado con un HAR real (ver docs/absa-endpoints.md seccion 4). */
const COTIZAR_RESPONSE_HTML = `<html><body>
  <script>cotizar('97', 'EXPERTA SEGUROS (P)', '10', '41318289', 'False', '1')</script>
</body></html>`;

/** Tabla real de propuesta (recortada), confirmada con un HAR con contenido: table.table-propuesta con fila de encabezado (nombre de plan en a.labelDetalle) y una fila "Premio" con un valor por plan. */
function propuestaHtml(...premios: string[]): string {
  const headers = premios.map((_, i) => `<th class="panel-heading"><a class="labelDetalle">Plan ${i + 1}</a></th>`).join("");
  const celdas = premios.map((p) => `<td>$ ${p}</td>`).join("");
  return `<html><body>
    <table class="table table-propuesta">
      <tr><th class="panel-heading">logo</th>${headers}</tr>
      <tr><td>Premio</td>${celdas}</tr>
    </table>
  </body></html>`;
}

/** Respuesta JSON de error para una aseguradora puntual (confirmada con un HAR real, ver docs/absa-endpoints.md seccion 4). */
const PROPUESTA_ERROR_JSON = `{"error":true,"responseText":"Error al Cotizar"}`;

function buildClient(storePath: string) {
  const authStrategy = new InstantAuthStrategy();
  const manager = new SessionManager({
    credentials: { user: "u", password: "p" },
    authStrategy,
    store: new SessionStore(storePath),
  });
  return { client: new QuoteClient(manager), authStrategy };
}

describe("QuoteClient.cotizar (flujo real AutoCotizador)", () => {
  let storePath: string;

  beforeEach(() => {
    storePath = path.join(os.tmpdir(), `absa-quote-test-${Date.now()}-${Math.random()}.json`);
    nock.cleanAll();
  });

  afterEach(() => {
    nock.cleanAll();
    if (fs.existsSync(storePath)) fs.unlinkSync(storePath);
  });

  it("hace GET (token) + POST principal + POST por aseguradora, y agrega los resultados", async () => {
    nock(config.ABSA_BASE_URL).get("/AutoCotizador/Cotizar/19156383?accion=1").reply(200, PAGE_WITH_TOKEN_HTML);
    nock(config.ABSA_BASE_URL).post("/AutoCotizador/Cotizar/19156383?Length=13").reply(200, COTIZAR_RESPONSE_HTML);
    nock(config.ABSA_BASE_URL).post("/CotizadorPropuesta/CotizarPropuesta/").reply(200, propuestaHtml("110.211,00"));
    nock(config.ABSA_BASE_URL).post("/CotizadorPropuesta/CotizarPropuesta/").reply(200, propuestaHtml("91.541,20"));

    const { client } = buildClient(storePath);
    const result = await client.cotizar(SAMPLE_INPUT);

    expect(result.ok).toBe(true);
    expect(result.numeroCotizacion).toBe("41318289");
    expect(result.opciones).toHaveLength(2);
    expect(result.opciones.map((o) => o.premio).sort((a, b) => a - b)).toEqual([91541.2, 110211]);
    // Se registran para poder tildar solo SUS coberturas al exportar el PDF.
    expect(result.aseguradorasCotizadas).toEqual([2, 21]);
  });

  it("solo lista como cotizadas las aseguradoras que devolvieron propuesta", async () => {
    nock(config.ABSA_BASE_URL).get("/AutoCotizador/Cotizar/19156383?accion=1").reply(200, PAGE_WITH_TOKEN_HTML);
    nock(config.ABSA_BASE_URL).post("/AutoCotizador/Cotizar/19156383?Length=13").reply(200, COTIZAR_RESPONSE_HTML);
    nock(config.ABSA_BASE_URL).post("/CotizadorPropuesta/CotizarPropuesta/").reply(200, propuestaHtml("110.211,00"));
    // La segunda falla (el caso real: "Error al Cotizar" de esa compañia).
    nock(config.ABSA_BASE_URL).post("/CotizadorPropuesta/CotizarPropuesta/").reply(200, PROPUESTA_ERROR_JSON);

    const { client } = buildClient(storePath);
    const result = await client.cotizar(SAMPLE_INPUT);

    expect(result.aseguradorasCotizadas).toEqual([2]);
  });

  it("lanza BusinessValidationError si falta input.absa", async () => {
    const { client } = buildClient(storePath);
    const { absa, ...withoutAbsa } = SAMPLE_INPUT;
    await expect(client.cotizar(withoutAbsa as CotizacionInput)).rejects.toBeInstanceOf(BusinessValidationError);
  });

  it("no sale a la red si falta sexo/estadoCivil/fechaNacimiento, y dice cuales faltan", async () => {
    // nock.disableNetConnect() esta activo: si intentara cotizar, explotaria
    // por red en vez de por validacion. Que pase significa que corta antes.
    const { client } = buildClient(storePath);
    const sinDatos = {
      ...SAMPLE_INPUT,
      asegurado: { ...SAMPLE_INPUT.asegurado, sexo: undefined, estadoCivil: undefined, fechaNacimiento: undefined },
    };

    await expect(client.cotizar(sinDatos)).rejects.toThrow(/sexo.*estadoCivil.*fechaNacimiento/s);
  });

  it("propaga los mensajes de error que manda ABSA en vez de un 'status 400' pelado", async () => {
    nock(config.ABSA_BASE_URL).get("/AutoCotizador/Cotizar/19156383?accion=1").reply(200, PAGE_WITH_TOKEN_HTML);
    nock(config.ABSA_BASE_URL)
      .post("/AutoCotizador/Cotizar/19156383?Length=13")
      .reply(400, '{"success":false,"Errores":["Debe seleccionar un sexo.","Debe ingresar una fecha de nacimiento."]}');

    const { client } = buildClient(storePath);
    await expect(client.cotizar(SAMPLE_INPUT)).rejects.toThrow(/Debe seleccionar un sexo/);
  });

  it("relogea automaticamente si el GET de la pagina del cotizador devuelve 401", async () => {
    nock(config.ABSA_BASE_URL).get("/AutoCotizador/Cotizar/19156383?accion=1").reply(401, "");
    nock(config.ABSA_BASE_URL).get("/AutoCotizador/Cotizar/19156383?accion=1").reply(200, PAGE_WITH_TOKEN_HTML);
    nock(config.ABSA_BASE_URL).post("/AutoCotizador/Cotizar/19156383?Length=13").reply(200, COTIZAR_RESPONSE_HTML);
    nock(config.ABSA_BASE_URL).post("/CotizadorPropuesta/CotizarPropuesta/").twice().reply(200, propuestaHtml("1.000,00"));

    const { client, authStrategy } = buildClient(storePath);
    const result = await client.cotizar(SAMPLE_INPUT);

    expect(result.ok).toBe(true);
    expect(authStrategy.loginCalls).toBeGreaterThanOrEqual(2);
  });

  it("lanza SessionExpiredError si sigue devolviendo 401 despues de relogear", async () => {
    nock(config.ABSA_BASE_URL).get("/AutoCotizador/Cotizar/19156383?accion=1").twice().reply(401, "");

    const { client } = buildClient(storePath);
    await expect(client.cotizar(SAMPLE_INPUT)).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it("lanza UpstreamChangedError si no puede extraer nroCotizacion de la respuesta principal", async () => {
    nock(config.ABSA_BASE_URL).get("/AutoCotizador/Cotizar/19156383?accion=1").reply(200, PAGE_WITH_TOKEN_HTML);
    nock(config.ABSA_BASE_URL).post("/AutoCotizador/Cotizar/19156383?Length=13").reply(200, "<html><body>sin numero</body></html>");

    const { client } = buildClient(storePath);
    await expect(client.cotizar(SAMPLE_INPUT)).rejects.toBeInstanceOf(UpstreamChangedError);
  });

  it("lanza UpstreamChangedError si ninguna aseguradora devuelve un monto parseable", async () => {
    nock(config.ABSA_BASE_URL).get("/AutoCotizador/Cotizar/19156383?accion=1").reply(200, PAGE_WITH_TOKEN_HTML);
    nock(config.ABSA_BASE_URL).post("/AutoCotizador/Cotizar/19156383?Length=13").reply(200, COTIZAR_RESPONSE_HTML);
    nock(config.ABSA_BASE_URL)
      .post("/CotizadorPropuesta/CotizarPropuesta/")
      .twice()
      .reply(200, "<html><body>sin montos</body></html>");

    const { client } = buildClient(storePath);
    await expect(client.cotizar(SAMPLE_INPUT)).rejects.toBeInstanceOf(UpstreamChangedError);
  });

  it("sigue devolviendo resultado si solo algunas aseguradoras fallan", async () => {
    nock(config.ABSA_BASE_URL).get("/AutoCotizador/Cotizar/19156383?accion=1").reply(200, PAGE_WITH_TOKEN_HTML);
    nock(config.ABSA_BASE_URL).post("/AutoCotizador/Cotizar/19156383?Length=13").reply(200, COTIZAR_RESPONSE_HTML);
    nock(config.ABSA_BASE_URL).post("/CotizadorPropuesta/CotizarPropuesta/").reply(200, propuestaHtml("50.000,00"));
    nock(config.ABSA_BASE_URL).post("/CotizadorPropuesta/CotizarPropuesta/").reply(500, "error interno");

    const { client } = buildClient(storePath);
    const result = await client.cotizar(SAMPLE_INPUT);
    expect(result.opciones).toHaveLength(1);
    expect(result.opciones[0]?.premio).toBe(50000);
  });

  it("un timeout contra UNA aseguradora no aborta la cotizacion ni la duplica", async () => {
    nock(config.ABSA_BASE_URL).get("/AutoCotizador/Cotizar/19156383?accion=1").reply(200, PAGE_WITH_TOKEN_HTML);
    nock(config.ABSA_BASE_URL).post("/AutoCotizador/Cotizar/19156383?Length=13").reply(200, COTIZAR_RESPONSE_HTML);
    nock(config.ABSA_BASE_URL).post("/CotizadorPropuesta/CotizarPropuesta/").reply(200, propuestaHtml("50.000,00"));
    nock(config.ABSA_BASE_URL)
      .post("/CotizadorPropuesta/CotizarPropuesta/")
      .replyWithError({ code: "ETIMEDOUT", message: "Timeout awaiting 'request' for 90000ms" });

    const { client } = buildClient(storePath);
    const result = await client.cotizar(SAMPLE_INPUT);

    // Antes esto reintentaba TODO el flujo, creando una segunda cotizacion en
    // ABSA. Los mocks estan definidos una sola vez a proposito: si reintentara,
    // el segundo GET no tendria mock y el test fallaria.
    expect(result.opciones).toHaveLength(1);
    expect(result.numeroCotizacion).toBe("41318289");
    expect((result.rawAbsaResponse as { fallos: string[] }).fallos.join(" ")).toMatch(/Timeout/);
  });

  it("trata el JSON {error:true} de una aseguradora como fallo puntual, no de toda la cotizacion", async () => {
    nock(config.ABSA_BASE_URL).get("/AutoCotizador/Cotizar/19156383?accion=1").reply(200, PAGE_WITH_TOKEN_HTML);
    nock(config.ABSA_BASE_URL).post("/AutoCotizador/Cotizar/19156383?Length=13").reply(200, COTIZAR_RESPONSE_HTML);
    nock(config.ABSA_BASE_URL).post("/CotizadorPropuesta/CotizarPropuesta/").reply(200, propuestaHtml("50.000,00"));
    nock(config.ABSA_BASE_URL)
      .post("/CotizadorPropuesta/CotizarPropuesta/")
      .reply(200, PROPUESTA_ERROR_JSON, { "content-type": "application/json" });

    const { client } = buildClient(storePath);
    const result = await client.cotizar(SAMPLE_INPUT);
    expect(result.ok).toBe(true);
    expect(result.opciones).toHaveLength(1);
  });

  it("una respuesta con varios planes (columnas) para la misma aseguradora arma una opcion por plan", async () => {
    nock(config.ABSA_BASE_URL).get("/AutoCotizador/Cotizar/19156383?accion=1").reply(200, PAGE_WITH_TOKEN_HTML);
    nock(config.ABSA_BASE_URL).post("/AutoCotizador/Cotizar/19156383?Length=13").reply(200, COTIZAR_RESPONSE_HTML);
    nock(config.ABSA_BASE_URL)
      .post("/CotizadorPropuesta/CotizarPropuesta/")
      .reply(200, propuestaHtml("110.211,00", "95.339,00", "44.852,00"));
    nock(config.ABSA_BASE_URL).post("/CotizadorPropuesta/CotizarPropuesta/").reply(200, propuestaHtml("50.000,00"));

    const { client } = buildClient(storePath);
    const result = await client.cotizar(SAMPLE_INPUT);
    expect(result.opciones).toHaveLength(4);
    expect(result.opciones.map((o) => o.premio).sort((a, b) => a - b)).toEqual([44852, 50000, 95339, 110211]);
  });
});

/** HTML del modal de guardado: trae su PROPIO token, distinto al de la pagina del cotizador. */
const GUARDAR_FORM_HTML = `<form action="/AutoCotizador/GuardarCotizacion" id="GuardarCotizacionForm" method="post">
  <input name="__RequestVerificationToken" type="hidden" value="token-del-modal" />
  <input name="NroCotizacion" type="hidden" value="41319971" />
  <input name="Descripcion" type="text" />
</form>`;

/**
 * Flujo confirmado con el HAR de Fase 0: el PDF que imprime ABSA sale de un
 * GET al modal (que trae el token) + un POST que devuelve application/pdf.
 */
describe("QuoteClient.exportarPdfCotizacion", () => {
  let storePath: string;

  beforeEach(() => {
    storePath = path.join(os.tmpdir(), `absa-pdf-test-${Date.now()}-${Math.random()}.json`);
    nock.cleanAll();
  });

  afterEach(() => {
    nock.cleanAll();
    if (fs.existsSync(storePath)) fs.unlinkSync(storePath);
  });

  it("tilda todas las coberturas de cada aseguradora antes de exportar (si no, el PDF sale sin propuestas)", async () => {
    // Cual propuesta entra al PDF es estado del servidor, no un campo del form
    // de impresion: hay que marcarlas con ExportarActualizarPropuestasCheck.
    const checks: Array<Record<string, unknown>> = [];
    nock(config.ABSA_BASE_URL)
      .post("/AutoCotizador/ExportarActualizarPropuestasCheck", (body: Record<string, unknown>) => {
        checks.push(body);
        return true;
      })
      .twice()
      .reply(200, { result: true });
    nock(config.ABSA_BASE_URL).get("/AutoCotizador/ExportarPDF").query(true).reply(200, PAGE_WITH_TOKEN_HTML);
    nock(config.ABSA_BASE_URL)
      .post("/Impresion/ExportarPDFCotAutos")
      .reply(200, Buffer.from("%PDF-1.4 con propuestas"), { "content-type": "application/pdf" });

    const { client } = buildClient(storePath);
    await client.exportarPdfCotizacion(19156383, "41319921", { aseguradoras: [97, 3] });

    // Una request por aseguradora, con el "seleccionar todas" del portal
    // (chktodos=true, idCobRiesgo=0), no una por cobertura.
    expect(checks).toHaveLength(2);
    expect(checks.map((c) => c.idAseguradora)).toEqual(["97", "3"]);
    expect(checks[0]).toMatchObject({ nroCotizacion: "41319921", chktodos: "true", idCobRiesgo: "0", chkCobRiesgo: "false" });
  });

  it("no marca las aseguradoras que no cotizaron", async () => {
    let checks = 0;
    nock(config.ABSA_BASE_URL)
      .post("/AutoCotizador/ExportarActualizarPropuestasCheck")
      .reply(200, () => {
        checks++;
        return { result: true };
      });
    nock(config.ABSA_BASE_URL).get("/AutoCotizador/ExportarPDF").query(true).reply(200, PAGE_WITH_TOKEN_HTML);
    nock(config.ABSA_BASE_URL)
      .post("/Impresion/ExportarPDFCotAutos")
      .reply(200, Buffer.from("%PDF-1.4"), { "content-type": "application/pdf" });

    const { client } = buildClient(storePath);
    await client.exportarPdfCotizacion(19156383, "41319921", { aseguradoras: [97] });

    expect(checks).toBe(1);
  });

  it("baja el PDF de ABSA y respeta el nombre que manda en el Content-Disposition", async () => {
    nock(config.ABSA_BASE_URL).post("/AutoCotizador/ExportarActualizarPropuestasCheck").reply(200, { result: true });
    nock(config.ABSA_BASE_URL)
      .get("/AutoCotizador/ExportarPDF")
      .query({ ocultarComision: "True", nroCotizacion: "41319921", _: /\d+/ })
      .reply(200, PAGE_WITH_TOKEN_HTML);
    nock(config.ABSA_BASE_URL)
      // nock parsea el body urlencoded a objeto; los campos repetidos
      // (MostrarPremio=true&MostrarPremio=false, el patron checkbox+hidden de
      // ASP.NET) llegan como array.
      .post("/Impresion/ExportarPDFCotAutos", (body: Record<string, unknown>) => {
        // El token tiene que viajar, y la comision oculta: el PDF puede
        // terminar en manos del cliente.
        return (
          body.__RequestVerificationToken === "test-csrf-token" &&
          body.OcultarComision === "True" &&
          body.NroCotizacion === "41319921" &&
          Array.isArray(body.MostrarPremio)
        );
      })
      .reply(200, Buffer.from("%PDF-1.4 contenido"), {
        "content-type": "application/pdf",
        "content-disposition": "attachment; filename=FIAT - ARGO 1.8 PRECISION L/21_2022.pdf",
      });

    const { client } = buildClient(storePath);
    const pdf = await client.exportarPdfCotizacion(19156383, "41319921");

    expect(pdf.buffer.subarray(0, 4).toString()).toBe("%PDF");
    // La barra de "L/21" no sirve en un nombre de archivo.
    expect(pdf.filename).toBe("FIAT - ARGO 1.8 PRECISION L-21_2022.pdf");
  });

  it("si ABSA cerro la sesion (302 a /Cuenta/UsuarioLogOut), relogea y reintenta solo", async () => {
    // Confirmado en produccion: con la sesion vieja, las paginas HTML del
    // cotizador redirigen al logout en vez de dar 401.
    nock(config.ABSA_BASE_URL)
      .get("/AutoCotizador/ExportarPDF")
      .query(true)
      .reply(302, "", { location: "/Cuenta/UsuarioLogOut" });
    // got sigue el redirect; lo que delata la sesion caida es haber pasado por ahi.
    nock(config.ABSA_BASE_URL).get("/Cuenta/UsuarioLogOut").reply(200, "<html>sesion cerrada</html>");
    // Post-relogin, el mismo pedido responde normal.
    nock(config.ABSA_BASE_URL).get("/AutoCotizador/ExportarPDF").query(true).reply(200, PAGE_WITH_TOKEN_HTML);
    nock(config.ABSA_BASE_URL)
      .post("/Impresion/ExportarPDFCotAutos")
      .reply(200, Buffer.from("%PDF-1.4 ok"), { "content-type": "application/pdf" });

    const { client, authStrategy } = buildClient(storePath);
    const pdf = await client.exportarPdfCotizacion(19156383, "41319921");

    expect(pdf.buffer.subarray(0, 4).toString()).toBe("%PDF");
    expect(authStrategy.loginCalls).toBeGreaterThanOrEqual(2); // el login inicial + el relogin
  });

  it("falla si ABSA devuelve HTML en vez del PDF (sesion vencida: no adjuntar el login a HubSpot)", async () => {
    nock(config.ABSA_BASE_URL).get("/AutoCotizador/ExportarPDF").query(true).reply(200, PAGE_WITH_TOKEN_HTML);
    nock(config.ABSA_BASE_URL)
      .post("/Impresion/ExportarPDFCotAutos")
      .reply(200, "<html>login</html>", { "content-type": "text/html; charset=utf-8" });

    const { client } = buildClient(storePath);
    await expect(client.exportarPdfCotizacion(19156383, "41319921")).rejects.toBeInstanceOf(UpstreamChangedError);
  });
});

describe("descripcionCotizacion: el nombre con el que queda guardada en ABSA", () => {
  const conVehiculo = (extra: Record<string, unknown>, asegurado: Record<string, unknown> = {}) => ({
    ...SAMPLE_INPUT,
    asegurado: { ...SAMPLE_INPUT.asegurado, ...asegurado },
    objetoAsegurado: { tipo: "vehiculo" as const, vehiculo: { ...SAMPLE_INPUT.objetoAsegurado.vehiculo!, ...extra } },
  });

  it("arma vehiculo - patente - titular - documento", () => {
    expect(descripcionCotizacion(conVehiculo({ patente: "AB123CD" }))).toBe("Ford Fiesta 2020 - AB123CD - Juan Perez - 12345678");
  });

  it("normaliza la patente (los formularios la mandan como sea)", () => {
    expect(descripcionCotizacion(conVehiculo({ patente: " ab123cd " }))).toContain("- AB123CD -");
  });

  it("saltea lo que no vino, sin dejar separadores colgando", () => {
    expect(descripcionCotizacion(conVehiculo({}))).toBe("Ford Fiesta 2020 - Juan Perez - 12345678");
    expect(descripcionCotizacion(conVehiculo({ patente: "AB123CD" }, { documentoNumero: undefined }))).toBe(
      "Ford Fiesta 2020 - AB123CD - Juan Perez",
    );
    expect(descripcionCotizacion(conVehiculo({}, { nombre: "", apellido: "", documentoNumero: undefined }))).toBe("Ford Fiesta 2020");
  });

  it("usa el fallback solo si no quedo nada que identifique al titular", () => {
    // Un lead sin nombre ni documento igual tiene que ser ubicable en el listado.
    expect(descripcionCotizacion(conVehiculo({}, { nombre: "", apellido: "", documentoNumero: undefined }), "Deal 777")).toBe(
      "Ford Fiesta 2020 - Deal 777",
    );
    // Con titular, el fallback no aporta nada y no se agrega.
    expect(descripcionCotizacion(conVehiculo({}), "Deal 777")).not.toContain("Deal 777");
  });
});

describe("toAbsaCotizarPayload: documento del asegurado", () => {
  const template = loadComercialTemplate();

  it("manda el documento cuando viene", () => {
    const p = toAbsaCotizarPayload(SAMPLE_INPUT, template, "token");
    expect(p.get("Cliente.Documento")).toBe("12345678");
    expect(p.get("Cliente.id_TipoDocumento")).toBe("7"); // 7 = DNI
  });

  it("cotiza sin documento: manda el campo vacio y el tipo por default", () => {
    // ABSA no exige documento para cotizar (la prima sale del vehiculo, el
    // año, la localidad, el sexo, la edad y el estado civil).
    const { documentoNumero, documentoTipo, ...sinDocumento } = SAMPLE_INPUT.asegurado;
    const p = toAbsaCotizarPayload({ ...SAMPLE_INPUT, asegurado: sinDocumento }, template, "token");
    expect(p.get("Cliente.Documento")).toBe("");
    expect(p.get("Cliente.id_TipoDocumento")).toBe("7");
  });

  it("no rechaza un input sin documento antes de salir a la red", () => {
    const { documentoNumero, ...sinDocumento } = SAMPLE_INPUT.asegurado;
    expect(() => assertDatosAseguradoCompletos({ ...SAMPLE_INPUT, asegurado: sinDocumento })).not.toThrow();
  });
});

describe("toAbsaCotizarPayload: provincia del riesgo", () => {
  const template = loadComercialTemplate();
  const sinProvincia = (() => {
    const { provincia, ...resto } = SAMPLE_INPUT.asegurado;
    return { ...SAMPLE_INPUT, asegurado: resto };
  })();

  it("usa la provincia que salio del codigo postal, no una fija", () => {
    // El portal nunca pide la provincia: la llena al elegir la localidad
    // (/Localidad/GetLocalidad). Antes se mandaba "1" (Capital Federal) fijo,
    // que para un riesgo en Cordoba es sencillamente el dato equivocado.
    const p = toAbsaCotizarPayload(
      { ...sinProvincia, absa: { ...SAMPLE_INPUT.absa!, idProvincia: 4 } },
      template,
      "token",
    );
    expect(p.get("DomicilioRiesgo.id_Provincia")).toBe("4");
  });

  it("el codigo postal le gana a un ID pasado a mano que lo contradice", () => {
    // Regla de negocio: el CP es el unico dato de domicilio que el cliente
    // escribe bien. Mandar la provincia del formulario junto a la localidad
    // del CP le daria a ABSA un par incoherente (localidad de una provincia,
    // provincia de otra): cotiza con la zona equivocada o rechaza.
    const p = toAbsaCotizarPayload(
      { ...SAMPLE_INPUT, asegurado: { ...SAMPLE_INPUT.asegurado, provincia: "13" }, absa: { ...SAMPLE_INPUT.absa!, idProvincia: 4 } },
      template,
      "token",
    );
    expect(p.get("DomicilioRiesgo.id_Provincia")).toBe("4");
  });

  it("si coinciden no hay nada que decidir", () => {
    const p = toAbsaCotizarPayload(
      { ...SAMPLE_INPUT, asegurado: { ...SAMPLE_INPUT.asegurado, provincia: "4" }, absa: { ...SAMPLE_INPUT.absa!, idProvincia: 4 } },
      template,
      "token",
    );
    expect(p.get("DomicilioRiesgo.id_Provincia")).toBe("4");
  });

  it("'BA' o cualquier texto tampoco pisa la del codigo postal", () => {
    for (const provincia of ["ba", "BA", "Buenos Aires", "  "]) {
      const p = toAbsaCotizarPayload(
        { ...SAMPLE_INPUT, asegurado: { ...SAMPLE_INPUT.asegurado, provincia }, absa: { ...SAMPLE_INPUT.absa!, idProvincia: 1 } },
        template,
        "token",
      );
      expect(p.get("DomicilioRiesgo.id_Provincia")).toBe("1");
    }
  });

  it("si el CP no resolvio provincia, el ID del lead es la ultima carta", () => {
    const { idProvincia, ...absaSinProvincia } = SAMPLE_INPUT.absa!;
    const p = toAbsaCotizarPayload(
      { ...SAMPLE_INPUT, asegurado: { ...SAMPLE_INPUT.asegurado, provincia: "13" }, absa: absaSinProvincia },
      template,
      "token",
    );
    expect(p.get("DomicilioRiesgo.id_Provincia")).toBe("13");
  });

  it("si el CP no resolvio provincia y la del lead es un nombre, va vacio", () => {
    const { idProvincia, ...absaSinProvincia } = SAMPLE_INPUT.absa!;
    const p = toAbsaCotizarPayload(
      { ...SAMPLE_INPUT, asegurado: { ...SAMPLE_INPUT.asegurado, provincia: "Cordoba" }, absa: absaSinProvincia },
      template,
      "token",
    );
    expect(p.get("DomicilioRiesgo.id_Provincia")).toBe("");
  });

  it("un NOMBRE de provincia se ignora: es lo que manda un formulario y ABSA espera un ID", () => {
    const p = toAbsaCotizarPayload(
      { ...SAMPLE_INPUT, asegurado: { ...SAMPLE_INPUT.asegurado, provincia: "Cordoba" }, absa: { ...SAMPLE_INPUT.absa!, idProvincia: 4 } },
      template,
      "token",
    );
    expect(p.get("DomicilioRiesgo.id_Provincia")).toBe("4");
  });

  it("sin provincia resuelta ni pasada, va vacio y lo valida ABSA", () => {
    const p = toAbsaCotizarPayload(sinProvincia, template, "token");
    expect(p.get("DomicilioRiesgo.id_Provincia")).toBe("");
  });
});

describe("QuoteClient.guardarCotizacion (flujo real de guardado)", () => {
  let storePath: string;

  beforeEach(() => {
    storePath = path.join(os.tmpdir(), `absa-guardar-test-${Date.now()}-${Math.random()}.json`);
    nock.cleanAll();
  });

  afterEach(() => {
    nock.cleanAll();
    if (fs.existsSync(storePath)) fs.unlinkSync(storePath);
  });

  it("pide el form, manda NroCotizacion + Descripcion y confirma con alert-success", async () => {
    nock(config.ABSA_BASE_URL).get("/AutoCotizador/GuardarCotizacion").query(true).reply(200, GUARDAR_FORM_HTML);
    const post = nock(config.ABSA_BASE_URL)
      .post("/AutoCotizador/GuardarCotizacion", (body) => {
        const p = new URLSearchParams(body as unknown as string);
        // usa el token del MODAL, no el de la pagina del cotizador
        return (
          p.get("__RequestVerificationToken") === "token-del-modal" &&
          p.get("NroCotizacion") === "41319971" &&
          p.get("Descripcion") === "prueba - gomez"
        );
      })
      .reply(200, '<div class="alert alert-success">Cotizacion guardada</div>');

    const { client } = buildClient(storePath);
    await client.guardarCotizacion(20174384, "41319971", "prueba - gomez");
    expect(post.isDone()).toBe(true);
  });

  it("lanza BusinessValidationError si ABSA responde con un alert de error", async () => {
    nock(config.ABSA_BASE_URL).get("/AutoCotizador/GuardarCotizacion").query(true).reply(200, GUARDAR_FORM_HTML);
    nock(config.ABSA_BASE_URL)
      .post("/AutoCotizador/GuardarCotizacion")
      .reply(200, '<div class="alert alert-danger">La descripcion es obligatoria</div>');

    const { client } = buildClient(storePath);
    await expect(client.guardarCotizacion(1, "41319971", "")).rejects.toBeInstanceOf(BusinessValidationError);
  });

  it("no da por guardada una cotizacion si la respuesta no confirma nada", async () => {
    nock(config.ABSA_BASE_URL).get("/AutoCotizador/GuardarCotizacion").query(true).reply(200, GUARDAR_FORM_HTML);
    nock(config.ABSA_BASE_URL).post("/AutoCotizador/GuardarCotizacion").reply(200, "<div>otra cosa</div>");

    const { client } = buildClient(storePath);
    await expect(client.guardarCotizacion(1, "41319971", "x")).rejects.toBeInstanceOf(UpstreamChangedError);
  });

  it("detecta sesion vencida al pedir el form de guardado: relogea, reintenta y guarda", async () => {
    nock(config.ABSA_BASE_URL).get("/AutoCotizador/GuardarCotizacion").query(true).reply(401, "");
    // Post-relogin sale bien: el guardado no se pierde por una sesion vieja.
    nock(config.ABSA_BASE_URL).get("/AutoCotizador/GuardarCotizacion").query(true).reply(200, GUARDAR_FORM_HTML);
    nock(config.ABSA_BASE_URL).post("/AutoCotizador/GuardarCotizacion").reply(200, "<div class=\"alert alert-success\">Guardado</div>");

    const { client, authStrategy } = buildClient(storePath);
    await client.guardarCotizacion(1, "41319971", "x");
    expect(authStrategy.loginCalls).toBeGreaterThanOrEqual(2);
  });

  /**
   * Caso REAL de produccion (cotizacion 41328290, 2026-08-28): la cotizacion
   * salio bien pero el guardado murio con "No se encontro
   * __RequestVerificationToken en la pagina". ABSA no contesta 401 ni redirige
   * al login cuando la sesion vencio en este endpoint: contesta **200 con el
   * cuerpo vacio** (verificado con un cookie jar vacio). Como no era un
   * SessionExpiredError, no disparaba el relogin y el Deal quedaba con un link
   * a una cotizacion que nunca se guardo.
   */
  it("200 con el cuerpo vacio es sesion vencida, no un template roto: relogea y guarda", async () => {
    nock(config.ABSA_BASE_URL).get("/AutoCotizador/GuardarCotizacion").query(true).reply(200, "");
    nock(config.ABSA_BASE_URL).get("/AutoCotizador/GuardarCotizacion").query(true).reply(200, GUARDAR_FORM_HTML);
    const post = nock(config.ABSA_BASE_URL)
      .post("/AutoCotizador/GuardarCotizacion")
      .reply(200, '<div class="alert alert-success">Guardado</div>');

    const { client, authStrategy } = buildClient(storePath);
    await client.guardarCotizacion(1, "41319971", "x");
    expect(post.isDone()).toBe(true);
    expect(authStrategy.loginCalls).toBeGreaterThanOrEqual(2);
  });

  it("si sigue vencida despues de relogear, lanza SessionExpiredError", async () => {
    nock(config.ABSA_BASE_URL).get("/AutoCotizador/GuardarCotizacion").query(true).twice().reply(401, "");

    const { client } = buildClient(storePath);
    await expect(client.guardarCotizacion(1, "41319971", "x")).rejects.toBeInstanceOf(SessionExpiredError);
  });
});
