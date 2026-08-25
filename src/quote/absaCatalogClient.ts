import { httpAbsa } from "../session/httpAbsa.js";
import type { CookieJar } from "tough-cookie";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { SessionManager } from "../session/sessionManager.js";
import type { VehiculoInput } from "./types.js";
import { SessionExpiredError, VehicleCatalogUnresolvedError } from "./errors.js";
import type { AbsaEntityIds, AbsaEntityResolver } from "./vehicleCatalog.js";
import {
  consultasDeBusqueda,
  hayVersionEnLaBusqueda,
  rankearCandidatos,
  textoBuscado,
  type CandidatoCatalogo,
  type CandidatoPuntuado,
} from "./vehicleVersionMatch.js";

/**
 * Resolver real del catalogo de vehiculos de ABSA net, confirmado con un HAR
 * real (con contenido) capturado en Fase 0 -- ver docs/absa-endpoints.md
 * seccion 3.1. Reproduce la misma cascada de llamadas AJAX que usa el
 * wizard de ABSA net cuando un usuario humano busca un vehiculo:
 *
 *   1. GET /Combo/GetVehiculos?q="{marca} {modelo}"   -> candidatos (infoAuto + descripcion)
 *   2. GET /Combo/GetAniosVehiculo?infoAuto={candidato}  -> años disponibles para ESE candidato
 *      (se prueba candidato por candidato hasta encontrar uno que soporte el año pedido)
 *   3. GET /Data/GetVehiculoInfoAuto?infoAuto={candidato} -> id_Vehiculo/id_MarcaVehiculo/id_ModeloVehiculo/id_OrigenVehiculo
 *   4. GET /Localidad/GetLocalidadesApi?query={codigoPostal} -> id_Localidad
 *   5. GET /Data/GetVehiculoSumaAsegurada?infoAuto=...&anio=... -> suma asegurada sugerida (fallback si no se proveyo una)
 *
 * ELECCION DE VERSION: un modelo/año tiene muchas versiones en ABSA
 * ("ARGO 1.8 PRECISION" vs "ARGO 1.8 PRECISION AT" vs "... PK PREMIUM"), y el
 * combo NO viene ordenado por relevancia sino por InfoAuto descendente (la
 * version mas nueva primero). Por eso este resolver ya no se queda con el
 * primer candidato: puntua TODOS contra `marca + modelo + version` con
 * `rankearCandidatos()` (ver ./vehicleVersionMatch.ts) y prueba de mas
 * parecido a menos hasta encontrar uno que tenga el año pedido. Cuanto mas
 * completo venga `vehiculo.version` (lo que dice la cedula), mas fina es la
 * eleccion; sin version se elige por marca/modelo y se avisa por log con que
 * similitud quedo.
 *
 * Escotilla de escape: si `vehiculo.codigoCatalogo` trae un InfoAuto, se usa
 * ESE vehiculo sin buscar ni puntuar nada. Es el camino para cuando el
 * operador ya vio la lista (`npm run versiones`) y quiere clavar la version
 * exacta.
 *
 * id_Entity: RESUELTO con la captura del 2026-08-20. Hay un endpoint
 * explicito -- `GET /Cotizador/NuevaCotizacion` responde 302 con
 * `Location: /AutoCotizador/Cotizar/{id_Entity}?accion=1`. Ver
 * `crearNuevaCotizacion()` al final de este archivo. (Antes se generaba un
 * random de 8 digitos: era una asuncion equivocada que podia pisar la
 * cotizacion en curso de otro usuario del portal.)
 */
/** 9 = Auto en el catalogo de riesgos de ABSA (ver docs/absa-endpoints.md seccion 3). */
const ID_RIESGO_AUTO = 9;

/**
 * Debajo de este parecido (0..100) la version elegida se loguea como warning.
 * No corta el flujo: puede ser el unico candidato del modelo y aun asi ser el
 * correcto. Es una señal para revisar, no una validacion.
 */
const SIMILITUD_ACEPTABLE = 60;

/** Cuantas alternativas se devuelven/loguean para que un humano pueda revisar la eleccion. */
const MAX_ALTERNATIVAS = 5;

/** Las otras versiones que quedaron cerca, para poder revisar (o repetir clavando el InfoAuto). */
function otrasVersiones(ranking: CandidatoPuntuado[], infoAutoElegido: string) {
  return ranking
    .filter((c) => c.value !== infoAutoElegido)
    .slice(0, MAX_ALTERNATIVAS)
    .map((c) => ({ infoAuto: Number(c.value), descripcion: c.text.trim(), similitud: c.similitud }));
}

/**
 * ABSA net NO devuelve 401/403 cuando la sesion vence: responde 200 y hay que
 * mirar el cuerpo. Son dos sintomas distintos, los dos confirmados en
 * produccion (ver docs/absa-endpoints.md seccion 5):
 *
 * - **200 con el HTML del login** en endpoints que devuelven JSON (2026-08-20).
 *   Sin este chequeo el sintoma era un "Unexpected token '<' ... is not valid
 *   JSON" reportado como "vehiculo no encontrado" -- un error terminal y
 *   enganioso para algo que se arregla solo relogueando.
 * - **200 con el cuerpo VACIO** (2026-08-25). Con una sesion vieja, todos los
 *   endpoints JSON (`/Combo/*`, `/Data/*`) contestan 200 sin un byte y sin
 *   content-type; despues de reloguear, los mismos devuelven su JSON. Sin
 *   este chequeo, el sintoma es "Unexpected end of JSON input".
 */
export function assertNoEsPaginaDeLogin(body: string, contentType: string | undefined, path: string): void {
  if (body.trim() === "") {
    throw new SessionExpiredError(
      `${path} devolvio 200 con el cuerpo vacio: es como contesta ABSA net cuando la sesion vencio.`,
    );
  }
  const esHtml = body.trimStart().startsWith("<") || (contentType ?? "").includes("text/html");
  if (esHtml) {
    throw new SessionExpiredError(
      `${path} devolvio HTML en vez de JSON: la sesion de ABSA net vencio (responde la pagina de login con status 200).`,
    );
  }
}

export class AbsaHttpVehicleCatalogResolver implements AbsaEntityResolver {
  constructor(private readonly sessionManager: SessionManager) {}

  /**
   * Resuelve el vehiculo, renovando la sesion y reintentando UNA vez si ABSA
   * la dio por vencida a mitad del camino.
   *
   * Importante: `SessionExpiredError` se deja propagar y NO se envuelve en
   * `VehicleCatalogUnresolvedError`. Son dos cosas distintas y el worker las
   * trata distinto: "no existe ese vehiculo" es terminal (se marca el Deal y
   * listo), "se vencio la sesion" es transitorio (se reintenta). Confundirlas
   * dejaba leads marcados como "vehiculo inexistente" por un problema de
   * sesion.
   */
  async resolve(vehiculo: VehiculoInput, localidadQuery?: string): Promise<AbsaEntityIds> {
    try {
      try {
        return await this.intentarResolver(vehiculo, localidadQuery);
      } catch (err) {
        if (!(err instanceof SessionExpiredError)) throw err;
        logger.warn({ err: err.message }, "Sesion vencida resolviendo el catalogo, relogueando y reintentando");
        await this.sessionManager.invalidateAndRelogin();
        return await this.intentarResolver(vehiculo, localidadQuery);
      }
    } catch (err) {
      if (err instanceof VehicleCatalogUnresolvedError) throw err;
      if (err instanceof SessionExpiredError) throw err;
      throw new VehicleCatalogUnresolvedError(
        `Error tecnico resolviendo el catalogo de ABSA para "${vehiculo.marca} ${vehiculo.modelo} ${vehiculo.anio}": ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  /**
   * Las versiones del catalogo que matchean marca/modelo(/version), ordenadas
   * por parecido y SIN cotizar ni crear nada en ABSA (son 1 o 2 GETs). Es lo
   * que usa `npm run versiones` para que un humano vea la lista real y elija
   * el InfoAuto exacto cuando la cedula y ABSA no se escriben igual.
   */
  async listarVersiones(vehiculo: VehiculoInput): Promise<CandidatoPuntuado[]> {
    return this.conSesion((jar, headers) => this.buscarYRankear(jar, headers, vehiculo));
  }

  /**
   * Los años que ABSA cotiza para ESE InfoAuto. La misma version esta cargada
   * varias veces (una por año de linea) y cada una cubre un rango distinto,
   * asi que antes de clavar un InfoAuto conviene chequear que tenga el año.
   */
  async aniosDisponibles(infoAuto: string): Promise<string[]> {
    return this.conSesion(async (jar, headers) => {
      const items = await this.getCombo(jar, headers, "/Combo/GetAniosVehiculo", {
        infoAuto,
        esInfoAuto: "true",
        sumaAseguradaMinima: "0",
      });
      return items.map((i) => i.value);
    });
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
      logger.warn({ err: err.message }, "Sesion vencida consultando el catalogo, relogueando y reintentando");
      await this.sessionManager.invalidateAndRelogin();
      return correr();
    }
  }

  private async intentarResolver(vehiculo: VehiculoInput, localidadQuery?: string): Promise<AbsaEntityIds> {
    const session = await this.sessionManager.getSession();
    const jar = SessionManager.jarFromArtifact(session);
    const headers = session.extraHeaders;

    const pedido = textoBuscado(vehiculo);
    // Un InfoAuto clavado no se puntua (es el vehiculo, no un candidato), y sin
    // version pedida no hay con que puntuar: en los dos casos el porcentaje de
    // parecido no significa nada y no se reporta.
    const seEligioPorParecido = !vehiculo.codigoCatalogo && hayVersionEnLaBusqueda(vehiculo);
    const ranking = await this.buscarYRankear(jar, headers, vehiculo);
    if (ranking.length === 0) {
      throw new VehicleCatalogUnresolvedError(`ABSA net no devolvio ningun vehiculo para "${pedido}" (Combo/GetVehiculos).`);
    }

    // De mas parecido a menos: el primero que tenga el año pedido gana. El año
    // se chequea recien aca (y no para todos de una) porque es una request por
    // candidato -- con el ranking bien puesto, casi siempre alcanza la primera.
    for (const candidato of ranking) {
      const infoAuto = candidato.value;
      const anios = await this.getCombo(jar, headers, "/Combo/GetAniosVehiculo", {
        infoAuto,
        esInfoAuto: "true",
        sumaAseguradaMinima: "0",
      });
      const tieneAnio = anios.some((a) => a.value === String(vehiculo.anio));
      if (!tieneAnio) continue;

      const detalle = await this.getVehiculoInfoAuto(jar, headers, infoAuto);
      const idLocalidad = await this.resolveLocalidad(jar, headers, localidadQuery);
      const sumaAseguradaSugerida = await this.getSumaAseguradaSugerida(jar, headers, infoAuto, vehiculo.anio);

      // La descripcion de /Data/GetVehiculoInfoAuto es la canonica de ABSA; la
      // del combo repite la marca ("FIAT - FIAT - ARGO ...").
      const descripcion = detalle.descripcion ?? candidato.text;
      const alternativas = otrasVersiones(ranking, infoAuto);
      const datosDelMatch = {
        pedido,
        infoAuto,
        descripcion,
        similitud: seEligioPorParecido ? candidato.similitud : undefined,
        coincidencias: candidato.coincidencias,
        faltantes: candidato.faltantes,
        alternativas: alternativas.map((a) => `${a.similitud}% ${a.descripcion}`),
      };
      if (!seEligioPorParecido) {
        // Sin version pedida no hay nada que puntuar: se toma la primera del
        // catalogo, igual que antes, pero que quede dicho que fue arbitrario.
        logger.info(datosDelMatch, "Vehiculo resuelto sin version pedida: se tomo la primera version del catalogo");
      } else if (candidato.similitud >= SIMILITUD_ACEPTABLE) {
        logger.info(datosDelMatch, "Vehiculo resuelto contra el catalogo real de ABSA net");
      } else {
        // No es un error (puede ser el unico candidato razonable), pero si el
        // match es flojo conviene que quede el rastro de contra que se cotizo.
        logger.warn(
          datosDelMatch,
          "La version elegida se parece poco a la pedida: revisar, o clavar el InfoAuto exacto con vehiculo.codigoCatalogo",
        );
      }

      const idEntity = await crearNuevaCotizacion(jar, headers);

      return {
        idEntity,
        idVehiculo: detalle.id_Vehiculo,
        idMarcaVehiculo: detalle.id_MarcaVehiculo,
        idModeloVehiculo: detalle.id_ModeloVehiculo,
        idOrigenVehiculo: detalle.id_OrigenVehiculo,
        infoAuto: Number(infoAuto),
        idLocalidad,
        idFormaRastreo: 1,
        sumaAseguradaSugerida,
        descripcion,
        similitudVersion: seEligioPorParecido ? candidato.similitud : undefined,
        alternativas,
      };
    }

    throw new VehicleCatalogUnresolvedError(
      `Se encontraron ${ranking.length} candidato(s) en ABSA para "${pedido}" pero ninguno tiene el año ` +
        `${vehiculo.anio} disponible. Los mas parecidos fueron: ` +
        ranking
          .slice(0, 3)
          .map((c) => `"${c.text.trim()}" (${c.similitud}%)`)
          .join(", "),
    );
  }

  /**
   * Trae los candidatos del catalogo y los deja ordenados por parecido con lo
   * pedido. Si el input clava un InfoAuto (`codigoCatalogo`), no busca nada:
   * ese es el vehiculo y punto.
   */
  private async buscarYRankear(
    jar: CookieJar,
    headers: Record<string, string>,
    vehiculo: VehiculoInput,
  ): Promise<CandidatoPuntuado[]> {
    if (vehiculo.codigoCatalogo) {
      const infoAuto = vehiculo.codigoCatalogo.trim();
      if (!/^\d+$/.test(infoAuto)) {
        throw new VehicleCatalogUnresolvedError(
          `vehiculo.codigoCatalogo debe ser un codigo InfoAuto numerico y vino "${vehiculo.codigoCatalogo}".`,
        );
      }
      logger.info({ infoAuto }, "InfoAuto fijado por el input: se saltea la busqueda en el catalogo");
      return [{ value: infoAuto, text: "", score: 0, similitud: 0, coincidencias: [], faltantes: [] }];
    }

    // Un Map por InfoAuto: las dos consultas se pisan bastante y la primera en
    // aparecer es la de la busqueda mas amplia, que es la que respeta el orden
    // original de ABSA.
    const porInfoAuto = new Map<string, CandidatoCatalogo>();
    for (const q of consultasDeBusqueda(vehiculo)) {
      const items = await this.getCombo(jar, headers, "/Combo/GetVehiculos", { q, sumaAseguradaMinima: "0" });
      for (const item of items) {
        if (!porInfoAuto.has(item.value)) porInfoAuto.set(item.value, item);
      }
    }

    return rankearCandidatos([...porInfoAuto.values()], vehiculo);
  }

  private async getCombo(
    jar: CookieJar,
    headers: Record<string, string>,
    path: string,
    searchParams: Record<string, string>,
  ): Promise<Array<{ text: string; value: string }>> {
    const response = await httpAbsa.get(new URL(path, config.ABSA_BASE_URL), {
      cookieJar: jar,
      headers,
      searchParams,
      throwHttpErrors: false,
      timeout: { request: 15_000 },
    });
    if (response.statusCode !== 200) {
      throw new Error(`${path} respondio status ${response.statusCode}`);
    }
    assertNoEsPaginaDeLogin(response.body, response.headers["content-type"], path);
    const parsed = JSON.parse(response.body) as { data?: { items?: Array<{ text: string; value: string }> } };
    return parsed?.data?.items ?? [];
  }

  private async getVehiculoInfoAuto(jar: CookieJar, headers: Record<string, string>, infoAuto: string) {
    const response = await httpAbsa.get(new URL("/Data/GetVehiculoInfoAuto", config.ABSA_BASE_URL), {
      cookieJar: jar,
      headers,
      searchParams: { infoAuto },
      throwHttpErrors: false,
      timeout: { request: 15_000 },
    });
    if (response.statusCode !== 200) {
      throw new Error(`GetVehiculoInfoAuto respondio status ${response.statusCode}`);
    }
    assertNoEsPaginaDeLogin(response.body, response.headers["content-type"], "/Data/GetVehiculoInfoAuto");
    const parsed = JSON.parse(response.body) as {
      data?: {
        vehiculo?: {
          id_Vehiculo: number;
          id_MarcaVehiculo: number;
          id_ModeloVehiculo: number;
          id_OrigenVehiculo: number;
          /** Descripcion canonica de ABSA, ej. "FIAT - ARGO 1.8 PRECISION L/21" (sin la marca repetida del combo). */
          descripcion?: string;
        };
      };
    };
    if (!parsed?.data?.vehiculo) {
      throw new Error("GetVehiculoInfoAuto no devolvio datos de vehiculo");
    }
    return parsed.data.vehiculo;
  }

  private async resolveLocalidad(jar: CookieJar, headers: Record<string, string>, query: string | undefined): Promise<number> {
    if (!query) {
      throw new Error("Falta codigo postal/localidad del asegurado -- no se puede resolver DomicilioRiesgo.id_Localidad");
    }
    const items = await this.getCombo(jar, headers, "/Localidad/GetLocalidadesApi", { query });
    if (items.length === 0) {
      throw new Error(`ABSA net no encontro ninguna localidad para "${query}"`);
    }
    return Number(items[0]!.value);
  }

  private async getSumaAseguradaSugerida(
    jar: CookieJar,
    headers: Record<string, string>,
    infoAuto: string,
    anio: number,
  ): Promise<number | undefined> {
    try {
      const response = await httpAbsa.get(new URL("/Data/GetVehiculoSumaAsegurada", config.ABSA_BASE_URL), {
        cookieJar: jar,
        headers,
        searchParams: { infoAuto, anio: String(anio) },
        throwHttpErrors: false,
        timeout: { request: 15_000 },
      });
      if (response.statusCode !== 200) return undefined;
      const parsed = JSON.parse(response.body) as { data?: { sumaAsegurada?: number } };
      return parsed?.data?.sumaAsegurada;
    } catch (err) {
      // Este dato es best-effort, pero una sesion vencida no se puede tragar:
      // tiene que llegar arriba para disparar el relogin.
      if (err instanceof SessionExpiredError) throw err;
      logger.warn({ err, infoAuto, anio }, "No se pudo obtener la suma asegurada sugerida, se sigue sin default");
      return undefined;
    }
  }
}

/**
 * Pide a ABSA net una cotizacion nueva y devuelve el id_Entity que asigna.
 *
 * CONFIRMADO con un HAR real (Fase 0): el id_Entity NO se genera del lado del
 * cliente. El wizard hace `GET /Cotizador/NuevaCotizacion`, que responde 302
 * con `Location: /AutoCotizador/Cotizar/{id_Entity}?accion=1` -- el servidor
 * crea la entidad y devuelve su ID. Antes aca se generaba un random de 8
 * digitos, lo que en el mejor caso fallaba y en el peor pisaba la cotizacion
 * en curso de otro usuario del mismo portal.
 *
 * `followRedirect: false` es imprescindible: si dejaramos que got siga el
 * redirect, perderiamos el header Location, que es el unico lugar donde viaja
 * el ID.
 */
export async function crearNuevaCotizacion(jar: CookieJar, headers: Record<string, string>): Promise<number> {
  const url = new URL("/Cotizador/NuevaCotizacion", config.ABSA_BASE_URL);
  // idRiesgo es OBLIGATORIO: sin el, ABSA no sabe que ramo arrancar y responde
  // 200 con una pagina en vez del 302 con el id_Entity. 9 = Auto (mismo valor
  // que `id_Riesgo` en el payload de cotizacion, ver src/quote/mapper.ts).
  url.searchParams.set("idRiesgo", String(ID_RIESGO_AUTO));

  const response = await httpAbsa.get(url, {
    cookieJar: jar,
    // El browser real navega desde el home; se replica el Referer.
    headers: { ...headers, referer: new URL("/Home/Index", config.ABSA_BASE_URL).toString() },
    followRedirect: false,
    throwHttpErrors: false,
    timeout: { request: 15_000 },
  });

  // Camino normal: 302 con el id_Entity en el header Location.
  const location = response.headers.location;
  if (location) {
    const match = location.match(/\/AutoCotizador\/Cotizar\/(\d+)/i);
    if (match?.[1]) return Number(match[1]);
    // Si la sesion vencio, ABSA redirige al login en vez de al cotizador.
    throw new Error(
      `/Cotizador/NuevaCotizacion redirigio a "${location}", que no tiene la forma ` +
        "/AutoCotizador/Cotizar/{id}. Puede ser una sesion vencida (redirect al login) o un cambio en ABSA net.",
    );
  }

  // Fallback: si en vez de redirigir devuelve la pagina ya renderizada, el
  // id_Entity vive igual en un hidden del form
  // (<input name="id_Entity" ... value="20174384" />).
  if (response.statusCode === 200) {
    const enHtml = response.body.match(/name=["']id_Entity["'][^>]*value=["'](\d+)["']/i);
    if (enHtml?.[1]) return Number(enHtml[1]);
  }

  throw new Error(
    `/Cotizador/NuevaCotizacion respondio ${response.statusCode} sin header Location y sin un ` +
      `id_Entity en el cuerpo (content-type: ${response.headers["content-type"] ?? "?"}). ` +
      "Se esperaba un 302 hacia /AutoCotizador/Cotizar/{id}?accion=1 (ver docs/absa-endpoints.md seccion 3.2).",
  );
}

