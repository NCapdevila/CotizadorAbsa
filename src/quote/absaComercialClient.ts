import type { CookieJar } from "tough-cookie";
import { httpAbsa } from "../session/httpAbsa.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { SessionManager } from "../session/sessionManager.js";
import { BusinessValidationError, SessionExpiredError, UpstreamChangedError } from "./errors.js";
import { assertNoEsPaginaDeLogin, crearNuevaCotizacion } from "./absaCatalogClient.js";
import { guardarCatalogoCacheado, leerCatalogoCacheado, parseComboProductores } from "./productoresCatalogo.js";
import {
  armarTemplateComercial,
  parseCondicionesAseguradoras,
  type AbsaComercialTemplate,
  type CondicionesAseguradoras,
  type OpcionCampo,
} from "./absaTemplate.js";
import type { ProductorMapeado } from "./productoresConfig.js";
import { normalizarProductor, type CandidatoProductor } from "./productorMatch.js";

/**
 * Config comercial de ABSA net leida en vivo, por productor.
 *
 * Reproduce las tres llamadas que hace el portal cuando alguien cambia el
 * productor en el cotizador (Scripts/Cotizador/Autos/productor.js, ver
 * docs/absa-endpoints.md seccion 3.3):
 *
 *   GET /Combo/GetConfiguracionesWS?idOrganizador&idProductor&idRiesgo
 *   GET /Data/GetPaquetesComision?idOrganizador&idProductor&idRiesgo&idAseguradora&comision
 *   GET /AutoCotizador/ObtenerConfigCotizador?idProductor
 *
 * Las tres juntas son lo que hace falta para cotizar con el acuerdo comercial
 * de ESE productor y no con el de otro. Cambiar solo `id_Configuracion` y
 * dejar las rebajas del productor viejo no da error: da precios equivocados.
 */
const ID_RIESGO_AUTO = 9;

const CONFIGURACIONES_PATH = "/Combo/GetConfiguracionesWS";
const COMISION_PATH = "/Data/GetPaquetesComision";
const CONDICIONES_PATH = "/AutoCotizador/ObtenerConfigCotizador";
/** Busqueda incremental de productores (el select2 del cotizador la usa cuando el combo no viene precargado). */
const PRODUCTORES_PATH = "/Combo/GetProductoresIncremental";

/** Lo que ABSA devuelve para un productor, sin mezclar todavia con la config de cuenta ni con los overrides. */
export interface ConfigDeProductor {
  configuraciones: OpcionCampo[];
  comisiones: number[];
  comisionPrincipal: number;
  comisionOrg: number;
  condiciones: CondicionesAseguradoras;
}

interface EntradaCache {
  valor: ConfigDeProductor;
  venceEn: number;
}

export class AbsaComercialConfigClient {
  /**
   * Cache por productor. La config comercial cambia cuando el broker
   * renegocia con una aseguradora — meses, no minutos — y son tres requests
   * por lead sin esto (ver ABSA_CONFIG_COMERCIAL_TTL_MS).
   */
  private readonly cache = new Map<number, EntradaCache>();

  constructor(private readonly sessionManager: SessionManager) {}

  /**
   * Plantilla comercial lista para cotizar con `idProductor`, combinando:
   * la config de CUENTA (`base`, del archivo), lo que ABSA devuelve para ese
   * productor, y los overrides del mapeo (`entrada.campos`).
   */
  async resolverTemplate(entrada: ProductorMapeado, base: AbsaComercialTemplate): Promise<AbsaComercialTemplate> {
    const cfg = await this.configDeProductor(base.idOrganizador, entrada.idProductor);
    const idConfiguracion = elegirConfiguracion(entrada, cfg.configuraciones);
    const comision = elegirComision(entrada, cfg);

    const template = armarTemplateComercial({
      base,
      idProductor: entrada.idProductor,
      idConfiguracion,
      comision,
      condiciones: cfg.condiciones,
      overrides: {
        // `Comercial.ConfigCotizacion.ComisionOrg` no viene en el bloque de
        // condiciones pero SI cambia por productor (lo setea el mismo endpoint
        // de comisiones). El mapper lo escribe en cero y despues aplica
        // camposPorAseguradora encima, asi que este es el lugar para pisarlo.
        "Comercial.ConfigCotizacion.ComisionOrg": cfg.comisionOrg,
        // Las condiciones comerciales (rebajas, clausulas de ajuste, tipo de
        // poliza, planes) son las MISMAS para todos los productores del
        // broker: es un acuerdo unico, no uno por concesionaria. Se toman de
        // config/absa-comercial.json, que es donde estan los valores que el
        // negocio eligio a mano en la pantalla de ABSA.
        //
        // Sin esto se cotizaria con los defaults del formulario, que traen las
        // rebajas en 0 y dan primas mas caras que cotizando a mano. Lo que ABSA
        // aporta por productor es lo que SI cambia: la configuracion/tarifa, la
        // comision y que aseguradoras tiene habilitadas.
        ...base.camposPorAseguradora,
        ...(entrada.campos ?? {}),
      },
    });

    logger.info(
      {
        productor: entrada.clave,
        idProductor: entrada.idProductor,
        idConfiguracion,
        comision,
        aseguradoras: template.aseguradoras.length,
        overrides: Object.keys(entrada.campos ?? {}).length,
      },
      "Config comercial resuelta en vivo para el productor del lead",
    );
    return template;
  }

  /**
   * Todo lo que ABSA devuelve para un productor (configuraciones, comisiones,
   * aseguradoras habilitadas y los campos con sus opciones validas), sin
   * mezclar con la config de cuenta ni con los overrides.
   *
   * Es lo que muestra `npm run productores`: sirve para armar el mapeo y para
   * ver que valores se pueden poner en `campos`.
   */
  async detalleDeProductor(idOrganizador: number, idProductor: number): Promise<ConfigDeProductor> {
    return this.configDeProductor(idOrganizador, idProductor);
  }

  /**
   * Busca productores por texto con el endpoint incremental (solo lectura, no
   * crea nada).
   *
   * **Devuelve menos de lo que existe**: confirmado el 2026-08-25 contra
   * produccion, hay productores del combo del cotizador que este endpoint no
   * encuentra ni buscando su apellido exacto (7616 "WOSCOFF, GABRIEL",
   * 11026 "BALLESTEROS, JOSE LUIS", 9711 "YIMI AUTOMOTORES"), mientras otros
   * del mismo estilo si aparecen. Por eso el camino principal para armar el
   * mapeo es `catalogoDeProductores()`, y esto queda de respaldo para las
   * cuentas donde el combo no viene precargado en la pagina.
   */
  async buscarProductores(query: string): Promise<CandidatoProductor[]> {
    const items = await this.conSesion((jar, headers) =>
      this.getJson<{ data?: { items?: CandidatoProductor[] }; items?: CandidatoProductor[] }>(
        jar,
        headers,
        PRODUCTORES_PATH,
        { query },
      ),
    );
    return items.data?.items ?? items.items ?? [];
  }

  /**
   * El catalogo COMPLETO de productores, tal cual lo ve el productor en el
   * combo del cotizador (1036 en esta cuenta). Es la fuente correcta para
   * armar el mapeo del formulario: la busqueda incremental se saltea algunos
   * (ver `buscarProductores`).
   *
   * Sale del `<select id="idProductor">` de la pagina del cotizador, asi que
   * hay que abrir una:
   *
   * - Con `nroCotizacionReferencia`: se abre una cotizacion que YA existe
   *   (`accion=4`). No crea ni modifica nada.
   * - Sin el: se pide una cotizacion nueva, que **deja una entidad vacia** en
   *   la cuenta del broker. Por eso el resultado se cachea en disco
   *   (`.session/`, ver ./productoresCatalogo.ts): en la practica pasa una vez
   *   por dia como mucho.
   *
   * Si la pagina no trae el combo (hay cuentas donde el select2 lo llena por
   * busqueda incremental), devuelve lista vacia y el llamador cae al otro
   * camino.
   */
  async catalogoDeProductores(nroCotizacionReferencia?: string): Promise<CandidatoProductor[]> {
    const cacheado = leerCatalogoCacheado();
    if (cacheado) return cacheado;

    const items = await this.conSesion(async (jar, headers) => {
      const path = nroCotizacionReferencia
        ? `/AutoCotizador/Cotizar/${encodeURIComponent(nroCotizacionReferencia)}?accion=4&esRecotizacionAnalisis=False`
        : `/AutoCotizador/Cotizar/${await crearNuevaCotizacion(jar, headers)}?accion=1`;

      const response = await httpAbsa.get(new URL(path, config.ABSA_BASE_URL), {
        cookieJar: jar,
        headers,
        throwHttpErrors: false,
        timeout: { request: 30_000 },
      });
      if (response.statusCode !== 200) {
        throw new UpstreamChangedError(`${path} respondio status ${response.statusCode} al pedir el combo de productores`);
      }
      // Aca el chequeo de sesion es al reves que en los endpoints JSON: la
      // pagina del cotizador ES html, y una sesion vencida devuelve el login
      // (que no tiene el combo). Se detecta por eso mismo mas abajo.
      return parseComboProductores(response.body);
    });

    if (items.length > 0) guardarCatalogoCacheado(items);
    return items;
  }

  /** Solo para tests: vacia el cache por productor. */
  vaciarCache(): void {
    this.cache.clear();
  }

  private async configDeProductor(idOrganizador: number, idProductor: number): Promise<ConfigDeProductor> {
    const enCache = this.cache.get(idProductor);
    if (enCache && enCache.venceEn > Date.now()) return enCache.valor;

    const valor = await this.conSesion(async (jar, headers) => {
      const configuraciones = await this.getConfiguraciones(jar, headers, idOrganizador, idProductor);
      const comisiones = await this.getComisiones(jar, headers, idOrganizador, idProductor);
      const condiciones = await this.getCondiciones(jar, headers, idProductor);
      return { configuraciones, ...comisiones, condiciones };
    });

    this.cache.set(idProductor, { valor, venceEn: Date.now() + config.ABSA_CONFIG_COMERCIAL_TTL_MS });
    return valor;
  }

  /** Corre algo con la sesion actual y, si ABSA la dio por vencida, relogea y reintenta UNA vez. */
  private async conSesion<T>(fn: (jar: CookieJar, headers: Record<string, string>) => Promise<T>): Promise<T> {
    const correr = async () => {
      const session = await this.sessionManager.getSession();
      return fn(SessionManager.jarFromArtifact(session), session.extraHeaders);
    };
    try {
      return await correr();
    } catch (err) {
      if (!(err instanceof SessionExpiredError)) throw err;
      logger.warn({ err: err.message }, "Sesion vencida pidiendo la config comercial, relogueando y reintentando");
      await this.sessionManager.invalidateAndRelogin();
      return correr();
    }
  }

  private async getJson<T>(
    jar: CookieJar,
    headers: Record<string, string>,
    path: string,
    searchParams: Record<string, string>,
  ): Promise<T> {
    const response = await httpAbsa.get(new URL(path, config.ABSA_BASE_URL), {
      cookieJar: jar,
      headers: { ...headers, "x-requested-with": "XMLHttpRequest" },
      searchParams,
      throwHttpErrors: false,
      timeout: { request: 15_000 },
    });
    if (response.statusCode !== 200) {
      throw new UpstreamChangedError(`${path} respondio status ${response.statusCode}`, response.body.slice(0, 500));
    }
    assertNoEsPaginaDeLogin(response.body, response.headers["content-type"], path);
    return JSON.parse(response.body) as T;
  }

  private async getConfiguraciones(
    jar: CookieJar,
    headers: Record<string, string>,
    idOrganizador: number,
    idProductor: number,
  ): Promise<OpcionCampo[]> {
    const json = await this.getJson<{ data?: { items?: OpcionCampo[] } }>(jar, headers, CONFIGURACIONES_PATH, {
      idOrganizador: String(idOrganizador),
      idProductor: String(idProductor),
      idRiesgo: String(ID_RIESGO_AUTO),
    });
    return json.data?.items ?? [];
  }

  private async getComisiones(
    jar: CookieJar,
    headers: Record<string, string>,
    idOrganizador: number,
    idProductor: number,
  ): Promise<{ comisiones: number[]; comisionPrincipal: number; comisionOrg: number }> {
    const json = await this.getJson<{
      data?: { comisiones?: number[]; comisionPrincipal?: number; comisionOrg?: number };
    }>(jar, headers, COMISION_PATH, {
      idOrganizador: String(idOrganizador),
      idProductor: String(idProductor),
      idRiesgo: String(ID_RIESGO_AUTO),
      idAseguradora: "",
      comision: "0",
    });
    const data = json.data ?? {};
    if (data.comisionPrincipal === undefined) {
      throw new UpstreamChangedError(
        `${COMISION_PATH} no devolvio comisionPrincipal para el productor: sin eso no se sabe con que comision cotizar.`,
        json,
      );
    }
    return {
      comisiones: data.comisiones ?? [],
      comisionPrincipal: data.comisionPrincipal,
      comisionOrg: data.comisionOrg ?? 0,
    };
  }

  private async getCondiciones(
    jar: CookieJar,
    headers: Record<string, string>,
    idProductor: number,
  ): Promise<CondicionesAseguradoras> {
    const json = await this.getJson<{ Estado?: number; View?: string; Mensaje?: string }>(
      jar,
      headers,
      CONDICIONES_PATH,
      { idProductor: String(idProductor) },
    );
    // El portal trata cualquier Estado != 1 como error y muestra `Mensaje` en
    // un modal; el caso tipico es un productor que el usuario no tiene
    // habilitado. Es un error de datos, no tecnico: no se reintenta.
    if (json.Estado !== 1 || !json.View) {
      throw new BusinessValidationError(
        `ABSA no devolvio las condiciones comerciales del productor ${idProductor}` +
          (json.Mensaje ? `: ${json.Mensaje}` : ` (Estado=${json.Estado})`),
        json,
      );
    }
    return parseCondicionesAseguradoras(json.View);
  }
}

/**
 * Que `Comercial.id_Configuracion` mandar.
 *
 * Mismo criterio que el portal (`CargarComboConfiguracion`): si el productor
 * tiene una sola configuracion, se elige sola. Con varias hay que decirlo en
 * el mapeo — elegir "la primera" seria elegir una tarifa al azar.
 */
export function elegirConfiguracion(entrada: ProductorMapeado, configuraciones: OpcionCampo[]): number {
  const disponibles = configuraciones.map((c) => `${c.text} (${c.value})`).join(", ") || "(ninguna)";

  if (entrada.idConfiguracion !== undefined) {
    const existe = configuraciones.some((c) => c.value === String(entrada.idConfiguracion));
    if (!existe) {
      throw new BusinessValidationError(
        `El mapeo dice idConfiguracion=${entrada.idConfiguracion} para "${entrada.clave}", pero ABSA no la ofrece ` +
          `para el productor ${entrada.idProductor}. Las disponibles son: ${disponibles}.`,
        { productor: entrada.clave, configuraciones },
      );
    }
    return entrada.idConfiguracion;
  }

  if (entrada.configuracion) {
    const buscado = normalizarProductor(entrada.configuracion);
    const exacta = configuraciones.find((c) => normalizarProductor(c.text) === buscado);
    if (exacta) return Number(exacta.value);
    throw new BusinessValidationError(
      `El mapeo pide la configuracion "${entrada.configuracion}" para "${entrada.clave}" y ABSA no tiene ninguna con ` +
        `ese nombre para el productor ${entrada.idProductor}. Las disponibles son: ${disponibles}.`,
      { productor: entrada.clave, configuraciones },
    );
  }

  if (configuraciones.length === 1) return Number(configuraciones[0]!.value);

  throw new BusinessValidationError(
    configuraciones.length === 0
      ? `ABSA no devolvio ninguna configuracion para el productor ${entrada.idProductor} ("${entrada.clave}"): ` +
        "sin configuracion no se puede cotizar (el portal muestra 'No se encontraron configuraciones para el productor')."
      : `El productor ${entrada.idProductor} ("${entrada.clave}") tiene ${configuraciones.length} configuraciones y el ` +
        `mapeo no dice cual usar. Agregá "idConfiguracion" o "configuracion" a la entrada. Disponibles: ${disponibles}.`,
    { productor: entrada.clave, configuraciones },
  );
}

/**
 * Que comision mandar: la del mapeo si la hay, si no la que ABSA propone por
 * default para ese productor (`comisionPrincipal`, igual que el portal).
 */
export function elegirComision(
  entrada: ProductorMapeado,
  cfg: { comisiones: number[]; comisionPrincipal: number },
): number {
  if (entrada.comision === undefined) return cfg.comisionPrincipal;
  if (cfg.comisiones.length > 0 && !cfg.comisiones.includes(entrada.comision)) {
    logger.warn(
      { productor: entrada.clave, comision: entrada.comision, disponibles: cfg.comisiones },
      "La comision del mapeo no esta entre las que ABSA ofrece para este productor: se manda igual",
    );
  }
  return entrada.comision;
}
