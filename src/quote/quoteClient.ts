import { HTTPError, RequestError } from "got";
import { httpAbsa } from "../session/httpAbsa.js";
import type { CookieJar } from "tough-cookie";
import { SessionManager } from "../session/sessionManager.js";
import { extractRequestVerificationToken } from "../session/csrf.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { CotizacionInput, CotizacionOpcion, CotizacionResult } from "./types.js";
import { toAbsaCotizarPayload, toAbsaPropuestaPayload, parseCotizacionPropuestaHtml, tryParseAbsaErrorJson, tryParseAbsaErrores, assertDatosAseguradoCompletos } from "./mapper.js";
import { loadComercialTemplate, type AbsaComercialTemplate } from "./absaTemplate.js";
import { AbsaComercialConfigClient } from "./absaComercialClient.js";
import { resolverProductor } from "./productoresConfig.js";
import { BusinessValidationError, SessionExpiredError, TransientError, UpstreamChangedError } from "./errors.js";

/**
 * Rutas reales descubiertas en Fase 0 (ver docs/absa-endpoints.md).
 * OJO: las respuestas son HTML (ASP.NET MVC partial views), no JSON.
 */
const COTIZADOR_PAGE_PATH = (idEntity: number) => `/AutoCotizador/Cotizar/${idEntity}?accion=1`;
const COTIZAR_PATH = (idEntity: number) => `/AutoCotizador/Cotizar/${idEntity}?Length=${COTIZAR_LENGTH}`;
const PROPUESTA_PATH = "/CotizadorPropuesta/CotizarPropuesta/";
const GUARDAR_PATH = "/AutoCotizador/GuardarCotizacion";
/** Modal de opciones de impresion (trae el token anti-forgery del POST de abajo). */
const EXPORTAR_PDF_FORM_PATH = "/AutoCotizador/ExportarPDF";
/** El que devuelve el PDF en si. */
const EXPORTAR_PDF_PATH = "/Impresion/ExportarPDFCotAutos";
/** Marca que propuestas entran en el PDF (el estado vive del lado del servidor, no en el form de impresion). */
const PROPUESTAS_CHECK_PATH = "/AutoCotizador/ExportarActualizarPropuestasCheck";

/**
 * `?Length=13` es un artefacto de la serializacion del frontend de ABSA, NO la
 * cantidad de aseguradoras: en las dos capturas reales valia 13 mientras el
 * productor ofrecia y el body enviaba 10. Se reproduce el valor observado en
 * vez de calcularlo, porque calcularlo daba un numero que ningun browser real
 * manda nunca.
 */
const COTIZAR_LENGTH = 13;

/** 9 = Auto (mismo valor que `id_Riesgo` en el payload, ver src/quote/mapper.ts). */
const ID_RIESGO_AUTO = 9;

/**
 * Timeout por aseguradora. Generoso a proposito: medido sobre dos capturas
 * reales, la aseguradora mas lenta tardo 40s y 55s respectivamente, mientras
 * el resto resolvia entre 5s y 17s. Con los 30s que habia antes, esa
 * aseguradora daba timeout siempre y se perdia su cotizacion.
 */
const PROPUESTA_TIMEOUT_MS = 90_000;

const SESSION_EXPIRED_STATUS = new Set([401, 403]);

/**
 * Cuando la sesion vence, ABSA NO siempre responde 401/403. En las paginas
 * HTML del cotizador redirige a `/Cuenta/UsuarioLogOut` (302), o directamente
 * sirve el login con 200 — confirmado en produccion el 2026-08-24 abriendo la
 * URL de recotizacion con una sesion vieja.
 *
 * Sin este chequeo el flujo sigue como si nada: le saca el
 * `__RequestVerificationToken` a la PAGINA DE LOGIN y postea con ese token
 * contra el endpoint real, que falla de una forma que no se parece en nada a
 * "se vencio la sesion".
 */
function esSesionCaida(response: {
  headers: { location?: string };
  redirectUrls?: readonly URL[];
  body?: unknown;
}): boolean {
  const destinos = [response.headers.location ?? "", ...(response.redirectUrls ?? []).map(String)];
  if (destinos.some((destino) => /\/Cuenta\/(UsuarioLogOut|Login)/i.test(destino))) return true;
  const body = typeof response.body === "string" ? response.body : "";
  return /id=["']loginForm["']|name=["']Password["']/i.test(body);
}

/**
 * ABSA nombra el PDF con el vehiculo y el año
 * (`attachment; filename=FIAT - ARGO 1.8 PRECISION L/21_2022.pdf`). Se respeta
 * ese nombre en el adjunto de HubSpot, pero sacando los caracteres que no
 * sirven en un nombre de archivo (la barra del "L/21", por ejemplo).
 */
function filenameDeContentDisposition(header: string | undefined): string | undefined {
  const match = header?.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  const nombre = match?.[1]?.trim();
  if (!nombre) return undefined;
  const limpio = nombre.replace(/[/\\:*?"<>|]/g, "-").trim();
  return limpio.toLowerCase().endsWith(".pdf") ? limpio : `${limpio}.pdf`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Confirmado con un HAR real (con contenido) de la Fase 0: el numero de
 * cotizacion NO viene en un input hidden -- viene embebido en llamadas JS
 * inline `cotizar('{idAseguradora}', '{nombre}', '{count}', '{nroCotizacion}',
 * '{ocultarComision}', '{accionCotizar}')`, una por cada aseguradora
 * container en la respuesta. Se prueban patrones en orden, del mas
 * especifico (el confirmado) al mas generico, por si ABSA cambia el
 * template en el futuro; si ninguno matchea, falla ruidosamente
 * (UpstreamChangedError) en vez de seguir con un nroCotizacion invalido.
 */
function extractNroCotizacion(html: string): string {
  const cotizarCall = html.match(/\bcotizar\(\s*'[^']*'\s*,\s*'[^']*'\s*,\s*'[^']*'\s*,\s*'(\d+)'/);
  if (cotizarCall?.[1]) return cotizarCall[1];

  const hiddenInput = html.match(/name=["']NroCotizacion["']\s+.*?value=["'](\d+)["']/i);
  if (hiddenInput?.[1]) return hiddenInput[1];

  const jsVar = html.match(/nroCotizacion["']?\s*[:=]\s*["']?(\d+)/i);
  if (jsVar?.[1]) return jsVar[1];

  throw new UpstreamChangedError(
    "No se pudo extraer nroCotizacion de la respuesta de /AutoCotizador/Cotizar. " +
      "Se probaron los patrones conocidos (ver docs/absa-endpoints.md seccion 4) -- revisar si ABSA cambio el template.",
    html,
  );
}

export interface ExportarPdfOpciones {
  /** Default true: el PDF puede terminar en manos del cliente. */
  ocultarComision?: boolean;
  /**
   * IDs de aseguradora cuyas coberturas hay que tildar. Default: todas las de
   * la plantilla comercial. Conviene pasar solo las que cotizaron
   * (`CotizacionResult.aseguradorasCotizadas`) para no gastar requests en las
   * que no tienen ninguna propuesta.
   */
  aseguradoras?: number[];
}

export interface ErrorRateTracker {
  attempts: number;
  errors: number;
}

/**
 * Fase 2 — Quote Client (AutoCotizador).
 *
 * Implementa el flujo real descubierto en Fase 0:
 *   1. GET la pagina del cotizador para sacar el token anti-forgery.
 *   2. POST el form principal (cliente + vehiculo + cobertura + config
 *      comercial de cuenta) -> devuelve/expone un nroCotizacion.
 *   3. POST una vez por aseguradora seleccionada a /CotizadorPropuesta/
 *      CotizarPropuesta/, parseando cada fragmento HTML por separado.
 *
 * Distingue sesion vencida (re-login + reintento) de error de negocio (no
 * reintenta) de "ABSA cambio algo" (no reintenta en loop, loguea fuerte).
 */
export class QuoteClient {
  private lastRequestAt = 0;
  private readonly rateTracker: ErrorRateTracker = { attempts: 0, errors: 0 };
  private readonly errorRateAlertThreshold = 0.5;
  private readonly errorRateMinSample = 5;

  constructor(
    private readonly sessionManager: SessionManager,
    /** Config comercial en vivo por productor. Inyectable para tests; por default habla con ABSA. */
    private readonly comercialClient: AbsaComercialConfigClient = new AbsaComercialConfigClient(sessionManager),
  ) {}

  async cotizar(input: CotizacionInput): Promise<CotizacionResult> {
    return this.attempt(input, { alreadyRelogged: false, retriesLeft: config.ABSA_MAX_RETRIES });
  }

  /**
   * Con que acuerdo comercial se cotiza este lead. Publico porque el CLI lo
   * muestra antes de cotizar: con que productor y contra que aseguradoras.
   *
   * El productor no es un dato mas del formulario: define rebajas, comisiones
   * y que aseguradoras cotizan. Por eso hay dos caminos y ninguno adivina:
   *
   * - Sin productor en el lead (o si es el mismo de la plantilla de archivo):
   *   se usa `config/absa-comercial.json` tal cual. Es el camino historico y
   *   no gasta ninguna request. La plantilla ademas tiene las rebajas que el
   *   negocio eligio a mano para ESE productor, que ABSA no devuelve por API
   *   (`ObtenerConfigCotizador` da los defaults del formulario, con las
   *   rebajas en 0).
   * - Con otro productor: se pide la config a ABSA en vivo y se le aplican
   *   los overrides del mapeo (ver ./absaComercialClient.ts).
   */
  async templateComercialPara(input: CotizacionInput): Promise<AbsaComercialTemplate> {
    const base = loadComercialTemplate();
    const entrada = resolverProductor(input.productor);

    if (!entrada || entrada.idProductor === base.idProductor) {
      if (input.productor) {
        logger.info(
          { productor: input.productor, idProductor: base.idProductor },
          "El productor del lead es el de la plantilla comercial: se cotiza con el archivo, sin pedir config a ABSA",
        );
      }
      return base;
    }

    return this.comercialClient.resolverTemplate(entrada, base);
  }

  private async attempt(
    input: CotizacionInput,
    state: { alreadyRelogged: boolean; retriesLeft: number },
  ): Promise<CotizacionResult> {
    if (!input.absa) {
      throw new BusinessValidationError(
        "Falta input.absa (idEntity + IDs de catalogo). Ver docs/absa-endpoints.md seccion 7.",
      );
    }

    // Antes de tocar la red: si faltan datos que ABSA exige, no tiene sentido
    // pedir el token ni crear una entidad de cotizacion que quedaria huerfana.
    assertDatosAseguradoCompletos(input);

    const template = await this.templateComercialPara(input);
    const session = await this.sessionManager.getSession();
    const jar = SessionManager.jarFromArtifact(session);
    const idEntity = input.absa.idEntity;

    try {
      await this.enforceRateLimit();
      this.rateTracker.attempts++;

      // 1) GET la pagina para sacar el token anti-forgery vigente.
      const pageResponse = await httpAbsa.get(new URL(COTIZADOR_PAGE_PATH(idEntity), config.ABSA_BASE_URL), {
        cookieJar: jar,
        headers: session.extraHeaders,
        throwHttpErrors: false,
        timeout: { request: 15_000 },
      });
      this.assertNotSessionExpired(pageResponse.statusCode, state);
      this.assertSesionViva(pageResponse, COTIZADOR_PAGE_PATH(idEntity));
      const csrfToken = extractRequestVerificationToken(pageResponse.body);

      // 2) POST el form principal.
      await this.enforceRateLimit();
      const payload = toAbsaCotizarPayload(input, template, csrfToken);
      const cotizarResponse = await httpAbsa.post(
        new URL(COTIZAR_PATH(idEntity), config.ABSA_BASE_URL),
        {
          cookieJar: jar,
          body: payload.toString(),
          headers: {
            ...session.extraHeaders,
            "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
            "x-requested-with": "XMLHttpRequest",
          },
          throwHttpErrors: false,
          timeout: { request: 20_000 },
        },
      );
      this.assertNotSessionExpired(cotizarResponse.statusCode, state);
      if (cotizarResponse.statusCode >= 500) throw new TransientError(`ABSA net respondio ${cotizarResponse.statusCode} en /AutoCotizador/Cotizar`);
      if (cotizarResponse.statusCode >= 400) {
        // ABSA devuelve los motivos reales en un array `Errores`; sin esto el
        // caller solo ve "status 400" y no sabe que corregir.
        const errores = tryParseAbsaErrores(cotizarResponse.body);
        throw new BusinessValidationError(
          errores
            ? `ABSA net rechazo la cotizacion: ${errores.join(" ")}`
            : `ABSA net rechazo la cotizacion (status ${cotizarResponse.statusCode})`,
          cotizarResponse.body,
        );
      }
      const nroCotizacion = extractNroCotizacion(cotizarResponse.body);

      // 3) POST por cada aseguradora seleccionada, en paralelo.
      const opciones: CotizacionOpcion[] = [];
      const fallos: string[] = [];
      const aseguradorasCotizadas: number[] = [];
      for (const aseguradora of template.aseguradoras) {
        await this.enforceRateLimit();
        const propuestaPayload = toAbsaPropuestaPayload(ID_RIESGO_AUTO, aseguradora.id, nroCotizacion);

        let propuestaResponse;
        try {
          propuestaResponse = await httpAbsa.post(new URL(PROPUESTA_PATH, config.ABSA_BASE_URL), {
            cookieJar: jar,
            body: propuestaPayload.toString(),
            headers: {
              ...session.extraHeaders,
              "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
              "x-requested-with": "XMLHttpRequest",
            },
            throwHttpErrors: false,
            timeout: { request: PROPUESTA_TIMEOUT_MS },
          });
        } catch (err) {
          // Un timeout o corte de red contra UNA aseguradora no puede abortar
          // toda la cotizacion: el reintento de `attempt()` rehace el flujo
          // desde cero y deja una cotizacion DUPLICADA en la cuenta del broker.
          // Se trata igual que un status != 200: esa aseguradora no cotizo.
          logger.warn({ err, aseguradora: aseguradora.nombre }, "Fallo la request de esta aseguradora, se omite y se sigue");
          fallos.push(`${aseguradora.nombre}: ${err instanceof Error ? err.message : String(err)}`);
          continue;
        }

        if (propuestaResponse.statusCode !== 200) {
          fallos.push(`${aseguradora.nombre}: status ${propuestaResponse.statusCode}`);
          continue;
        }

        // Confirmado en Fase 0: algunas aseguradoras devuelven un JSON chico
        // {"error":true,"responseText":"..."} en vez del HTML de la tabla --
        // es un rechazo de negocio de ESA aseguradora puntual, no un estado
        // "procesando" (ver docs/absa-endpoints.md seccion 4). Se trata como
        // un fallo mas de la lista, no de toda la cotizacion.
        const jsonError = tryParseAbsaErrorJson(propuestaResponse.body);
        if (jsonError) {
          fallos.push(`${aseguradora.nombre}: ${jsonError}`);
          continue;
        }

        try {
          opciones.push(...parseCotizacionPropuestaHtml(propuestaResponse.body, aseguradora.nombre));
          aseguradorasCotizadas.push(aseguradora.id);
        } catch (err) {
          logger.warn({ err, aseguradora: aseguradora.nombre }, "No se pudo parsear la respuesta de esta aseguradora, se omite");
          fallos.push(`${aseguradora.nombre}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      if (opciones.length === 0) {
        throw new UpstreamChangedError(
          `Ninguna aseguradora devolvio una cotizacion parseable (${fallos.join("; ")})`,
          fallos,
        );
      }
      if (fallos.length > 0) {
        logger.warn({ fallos }, "Algunas aseguradoras no devolvieron cotizacion");
      }

      const result: CotizacionResult = {
        ok: true,
        numeroCotizacion: nroCotizacion,
        opciones,
        aseguradorasCotizadas,
        rawAbsaResponse: { fallos },
        obtenidoEn: new Date().toISOString(),
      };
      logger.info({ numeroCotizacion: nroCotizacion, opciones: opciones.length }, "Cotizacion obtenida");
      return result;
    } catch (err) {
      if (err instanceof SessionExpiredError) {
        if (state.alreadyRelogged) {
          this.rateTracker.errors++;
          this.maybeWarnErrorRate();
          throw err;
        }
        await this.sessionManager.invalidateAndRelogin();
        return this.attempt(input, { alreadyRelogged: true, retriesLeft: state.retriesLeft });
      }
      if (err instanceof BusinessValidationError || err instanceof UpstreamChangedError) {
        this.rateTracker.errors++;
        this.maybeWarnErrorRate();
        throw err;
      }

      const transient = err instanceof TransientError || err instanceof RequestError || err instanceof HTTPError;
      if (transient && state.retriesLeft > 0) {
        const backoffMs = 500 * 2 ** (config.ABSA_MAX_RETRIES - state.retriesLeft);
        logger.warn({ err, backoffMs }, "Error transitorio cotizando, reintentando con backoff");
        await sleep(backoffMs);
        return this.attempt(input, { ...state, retriesLeft: state.retriesLeft - 1 });
      }

      this.rateTracker.errors++;
      this.maybeWarnErrorRate();
      logger.error({ err }, "Error no recuperable cotizando en ABSA net");
      throw err;
    }
  }

  /**
   * Guarda una cotizacion ya generada, para que quede persistida en ABSA net
   * con un nombre y se pueda recuperar despues desde el listado.
   *
   * Flujo confirmado con una captura real (Fase 0):
   *   1. GET /AutoCotizador/GuardarCotizacion?nroCotizacion={nro}&_={ts}
   *      -> devuelve el HTML del modal, con su PROPIO __RequestVerificationToken
   *      (distinto del de la pagina del cotizador: hay que sacar este, no reusar
   *      el otro).
   *   2. POST /AutoCotizador/GuardarCotizacion con NroCotizacion + Descripcion.
   *      -> HTML del modal; el exito se ve como un `alert-success`.
   *
   * `idEntity` se usa solo para armar el Referer que manda el browser real.
   */
  async guardarCotizacion(idEntity: number, nroCotizacion: string, descripcion: string): Promise<void> {
    return this.conSesionFresca(() => this.guardarCotizacionInterno(idEntity, nroCotizacion, descripcion));
  }

  private async guardarCotizacionInterno(idEntity: number, nroCotizacion: string, descripcion: string): Promise<void> {
    const session = await this.sessionManager.getSession();
    const jar = SessionManager.jarFromArtifact(session);
    const referer = new URL(COTIZADOR_PAGE_PATH(idEntity), config.ABSA_BASE_URL).toString();

    await this.enforceRateLimit();
    const formUrl = new URL(GUARDAR_PATH, config.ABSA_BASE_URL);
    formUrl.searchParams.set("nroCotizacion", nroCotizacion);
    formUrl.searchParams.set("_", String(Date.now()));
    const formResponse = await httpAbsa.get(formUrl, {
      cookieJar: jar,
      headers: { ...session.extraHeaders, "x-requested-with": "XMLHttpRequest", referer },
      throwHttpErrors: false,
      timeout: { request: 15_000 },
    });
    this.assertNotSessionExpired(formResponse.statusCode, { alreadyRelogged: false });
    this.assertSesionViva(formResponse, GUARDAR_PATH);
    if (formResponse.statusCode !== 200) {
      throw new UpstreamChangedError(
        `GET ${GUARDAR_PATH} respondio ${formResponse.statusCode} al pedir el form de guardado`,
        formResponse.body,
      );
    }
    const csrfToken = extractRequestVerificationToken(formResponse.body);

    await this.enforceRateLimit();
    const body = new URLSearchParams({
      __RequestVerificationToken: csrfToken,
      NroCotizacion: nroCotizacion,
      Descripcion: descripcion,
    });
    const saveResponse = await httpAbsa.post(new URL(GUARDAR_PATH, config.ABSA_BASE_URL), {
      cookieJar: jar,
      body: body.toString(),
      headers: {
        ...session.extraHeaders,
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        "x-requested-with": "XMLHttpRequest",
        referer,
      },
      throwHttpErrors: false,
      timeout: { request: 20_000 },
    });
    this.assertNotSessionExpired(saveResponse.statusCode, { alreadyRelogged: false });
    if (saveResponse.statusCode !== 200) {
      throw new UpstreamChangedError(`POST ${GUARDAR_PATH} respondio ${saveResponse.statusCode}`, saveResponse.body);
    }

    // ABSA responde el HTML del modal en los dos casos; el exito se distingue
    // por el alert. Si no aparece ninguno de los dos, cambio el template y es
    // mejor fallar que dar por guardada una cotizacion que no lo esta.
    if (/alert-success/i.test(saveResponse.body)) {
      logger.info({ nroCotizacion, descripcion }, "Cotizacion guardada en ABSA net");
      return;
    }
    if (/alert-danger|alert-error|validation-summary-errors/i.test(saveResponse.body)) {
      throw new BusinessValidationError(
        `ABSA net rechazo el guardado de la cotizacion ${nroCotizacion}`,
        saveResponse.body,
      );
    }
    throw new UpstreamChangedError(
      `No se pudo confirmar el guardado de la cotizacion ${nroCotizacion}: la respuesta no trae ` +
        "ni alert-success ni un alert de error (ver docs/absa-endpoints.md).",
      saveResponse.body,
    );
  }

  /**
   * Descarga la impresion en PDF que genera ABSA net para una cotizacion: la
   * MISMA que sale del boton "Exportar PDF" del cotizador, no una reconstruida
   * por nosotros.
   *
   * Son dos pasos (confirmado con el HAR de Fase 0, ver
   * docs/absa-endpoints.md seccion 3.5):
   *   1. GET /AutoCotizador/ExportarPDF?nroCotizacion=... -> HTML del modal de
   *      opciones, con el __RequestVerificationToken adentro.
   *   2. POST /Impresion/ExportarPDFCotAutos con ese token + las opciones de
   *      impresion -> application/pdf.
   *
   * `ocultarComision` va en true por default: el PDF termina adjunto en el
   * Deal y puede llegar a manos del cliente, donde la comision del productor
   * no tiene por que aparecer.
   */
  async exportarPdfCotizacion(
    idEntity: number,
    nroCotizacion: string,
    opciones: ExportarPdfOpciones = {},
  ): Promise<{ buffer: Buffer; filename: string }> {
    return this.conSesionFresca(() => this.exportarPdfCotizacionInterno(idEntity, nroCotizacion, opciones));
  }

  private async exportarPdfCotizacionInterno(
    idEntity: number,
    nroCotizacion: string,
    opciones: ExportarPdfOpciones,
  ): Promise<{ buffer: Buffer; filename: string }> {
    const ocultarComision = opciones.ocultarComision ?? true;
    const session = await this.sessionManager.getSession();
    const jar = SessionManager.jarFromArtifact(session);
    const referer = new URL(COTIZADOR_PAGE_PATH(idEntity), config.ABSA_BASE_URL).toString();

    // Sin esto el PDF sale con la cabecera (titular + vehiculo) y la tabla de
    // PROPUESTAS vacia.
    const aseguradoras = opciones.aseguradoras ?? loadComercialTemplate().aseguradoras.map((a) => a.id);
    await this.seleccionarTodasLasCoberturas(jar, session.extraHeaders, referer, nroCotizacion, aseguradoras);

    await this.enforceRateLimit();
    const formUrl = new URL(EXPORTAR_PDF_FORM_PATH, config.ABSA_BASE_URL);
    formUrl.searchParams.set("ocultarComision", ocultarComision ? "True" : "False");
    formUrl.searchParams.set("nroCotizacion", nroCotizacion);
    formUrl.searchParams.set("_", String(Date.now()));
    const formResponse = await httpAbsa.get(formUrl, {
      cookieJar: jar,
      headers: { ...session.extraHeaders, "x-requested-with": "XMLHttpRequest", referer },
      throwHttpErrors: false,
      timeout: { request: 15_000 },
    });
    this.assertNotSessionExpired(formResponse.statusCode, { alreadyRelogged: false });
    this.assertSesionViva(formResponse, EXPORTAR_PDF_FORM_PATH);
    if (formResponse.statusCode !== 200) {
      throw new UpstreamChangedError(
        `GET ${EXPORTAR_PDF_FORM_PATH} respondio ${formResponse.statusCode} al pedir el form de impresion`,
        formResponse.body,
      );
    }
    const csrfToken = extractRequestVerificationToken(formResponse.body);

    // Los pares repetidos (MostrarPremio=true&MostrarPremio=false) NO son un
    // error: es el patron checkbox+hidden de ASP.NET MVC y asi los manda el
    // navegador real. Se replica igual para no depender de como ABSA parsea
    // un body distinto al que espera.
    const body = new URLSearchParams([
      ["__RequestVerificationToken", csrfToken],
      ["OcultarComision", ocultarComision ? "True" : "False"],
      ["NroCotizacion", nroCotizacion],
      ["OcultarLogoOrganizador", "false"],
      ["OcultarLogoProductor", "false"],
      ["OcultarFooter", "false"],
      ["MostrarPrima", "false"],
      ["MostrarPremio", "true"],
      ["MostrarPremio", "false"],
      ["MostrarCobertura", "true"],
      ["MostrarCobertura", "false"],
      ["MostrarPremioTotal", "false"],
      ["Ordenamiento", "Aseguradora"],
    ]);

    await this.enforceRateLimit();
    const pdfResponse = await httpAbsa.post(new URL(EXPORTAR_PDF_PATH, config.ABSA_BASE_URL), {
      cookieJar: jar,
      body: body.toString(),
      headers: {
        ...session.extraHeaders,
        "content-type": "application/x-www-form-urlencoded",
        referer,
      },
      responseType: "buffer",
      throwHttpErrors: false,
      timeout: { request: 60_000 },
    });
    this.assertNotSessionExpired(pdfResponse.statusCode, { alreadyRelogged: false });
    this.assertSesionViva(pdfResponse, EXPORTAR_PDF_PATH);
    if (pdfResponse.statusCode !== 200) {
      throw new UpstreamChangedError(`POST ${EXPORTAR_PDF_PATH} respondio ${pdfResponse.statusCode}`, pdfResponse.statusCode);
    }

    const contentType = pdfResponse.headers["content-type"] ?? "";
    if (!contentType.includes("application/pdf")) {
      // Si vence la sesion, aca llega el HTML del login con 200: mejor fallar
      // que adjuntar en HubSpot un "PDF" que en realidad es una pagina de login.
      throw new UpstreamChangedError(
        `${EXPORTAR_PDF_PATH} devolvio "${contentType}" en vez de application/pdf para la cotizacion ${nroCotizacion}`,
        pdfResponse.body.subarray(0, 500).toString("utf8"),
      );
    }

    logger.info({ nroCotizacion, bytes: pdfResponse.body.length }, "PDF de la cotizacion descargado de ABSA net");
    return {
      buffer: Buffer.from(pdfResponse.body),
      filename: filenameDeContentDisposition(pdfResponse.headers["content-disposition"]) ?? `cotizacion-absa-${nroCotizacion}.pdf`,
    };
  }

  /**
   * Tilda TODAS las coberturas de cada aseguradora para que entren en el PDF.
   *
   * Cual propuesta se imprime NO viaja en el form de impresion: es estado del
   * lado del servidor, que el portal va actualizando a medida que el productor
   * tilda checkboxes en la grilla de resultados. Sin este paso el PDF sale con
   * los datos del titular y del vehiculo pero con la tabla de propuestas
   * vacia.
   *
   * El contrato sale del JS del propio cotizador
   * (`ActualizarPropuestasCheckExportar(idAseguradora, chktodos, idCobRiesgo,
   * chkCobRiesgo)`): el "seleccionar todas" de una aseguradora es
   * `chktodos=true, idCobRiesgo=0, chkCobRiesgo=false`. Una request por
   * aseguradora en vez de una por cobertura (que serian ~10 veces mas).
   *
   * Es best-effort: si una aseguradora falla, se sigue con las demas. Peor
   * escenario, el PDF sale con menos propuestas — mejor que no salir.
   */
  private async seleccionarTodasLasCoberturas(
    jar: CookieJar,
    headers: Record<string, string>,
    referer: string,
    nroCotizacion: string,
    aseguradoras: number[],
  ): Promise<void> {
    for (const idAseguradora of aseguradoras) {
      await this.enforceRateLimit();
      const body = new URLSearchParams({
        nroCotizacion,
        idAseguradora: String(idAseguradora),
        chktodos: "true",
        idCobRiesgo: "0",
        chkCobRiesgo: "false",
        ocultarComision: "False",
      });
      try {
        const response = await httpAbsa.post(new URL(PROPUESTAS_CHECK_PATH, config.ABSA_BASE_URL), {
          cookieJar: jar,
          body: body.toString(),
          headers: {
            ...headers,
            "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
            "x-requested-with": "XMLHttpRequest",
            referer,
          },
          throwHttpErrors: false,
          timeout: { request: 15_000 },
        });
        this.assertSesionViva(response, PROPUESTAS_CHECK_PATH);
        if (response.statusCode !== 200 || !/"result"\s*:\s*true/i.test(response.body)) {
          logger.warn(
            { idAseguradora, nroCotizacion, status: response.statusCode },
            "ABSA no confirmo la seleccion de coberturas de esta aseguradora: puede faltar en el PDF",
          );
        }
      } catch (err) {
        if (err instanceof SessionExpiredError) throw err;
        logger.warn({ err, idAseguradora, nroCotizacion }, "Fallo marcando las coberturas de esta aseguradora, se sigue");
      }
    }
  }

  private assertNotSessionExpired(statusCode: number, state: { alreadyRelogged: boolean }): void {
    if (SESSION_EXPIRED_STATUS.has(statusCode)) {
      throw new SessionExpiredError(`ABSA net respondio ${statusCode}${state.alreadyRelogged ? " (despues de relogear)" : ""}`);
    }
  }

  /** Idem, para el patron que ABSA usa en las paginas HTML: logout/login en vez de 401. */
  private assertSesionViva(response: { headers: { location?: string }; redirectUrls?: readonly URL[]; body?: unknown }, path: string): void {
    if (esSesionCaida(response)) {
      throw new SessionExpiredError(`${path}: ABSA cerro la sesion (redirect a /Cuenta/UsuarioLogOut o pagina de login con 200)`);
    }
  }

  /**
   * Corre algo y, si ABSA dio la sesion por vencida, relogea y reintenta UNA
   * vez. `cotizar()` ya tiene su propio ciclo de reintentos; esto es para las
   * operaciones sueltas (guardar, exportar PDF), que si no morian con un error
   * raro por una sesion vieja.
   */
  private async conSesionFresca<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof SessionExpiredError)) throw err;
      logger.warn({ err: err.message }, "Sesion vencida, relogueando y reintentando");
      await this.sessionManager.invalidateAndRelogin();
      return fn();
    }
  }

  private async enforceRateLimit(): Promise<void> {
    const elapsed = Date.now() - this.lastRequestAt;
    const wait = config.ABSA_MIN_REQUEST_INTERVAL_MS - elapsed;
    if (wait > 0) await sleep(wait);
    this.lastRequestAt = Date.now();
  }

  private maybeWarnErrorRate(): void {
    if (this.rateTracker.attempts < this.errorRateMinSample) return;
    const rate = this.rateTracker.errors / this.rateTracker.attempts;
    if (rate >= this.errorRateAlertThreshold) {
      logger.warn(
        { rate, attempts: this.rateTracker.attempts, errors: this.rateTracker.errors },
        `ALERTA: tasa de error de cotizaciones ABSA net >= ${this.errorRateAlertThreshold * 100}%`,
      );
    }
  }
}
