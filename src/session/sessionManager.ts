import { CookieJar } from "tough-cookie";
import type { AbsaCredentials, AuthStrategy, SessionArtifact } from "./types.js";
import { SessionStore } from "./sessionStore.js";
import { logger } from "../logger.js";

export interface SessionManagerOptions {
  credentials: AbsaCredentials;
  authStrategy: AuthStrategy;
  store: SessionStore;
  /**
   * Margen de seguridad antes de estimatedExpiresAt para relogear
   * proactivamente en vez de esperar a que ABSA devuelva 401/403.
   */
  refreshMarginMs?: number;
}

/**
 * Fase 1 — Session Manager.
 *
 * Responsable de obtener y mantener una sesion valida contra ABSA net.
 * No sabe nada de cotizaciones: solo entrega un CookieJar (+ headers extra)
 * listos para usar, y sabe cuando hay que renovarlos.
 *
 * Nunca loguea credenciales ni el contenido del cookie jar (ver src/logger.ts).
 */
export class SessionManager {
  private current: SessionArtifact | null = null;
  private loginInFlight: Promise<SessionArtifact> | null = null;

  constructor(private readonly opts: SessionManagerOptions) {}

  /**
   * Ejecuta el login contra ABSA net usando la estrategia configurada,
   * persiste el resultado, y lo deja como sesion activa. Si ya hay un
   * login en curso (por ejemplo, dos requests concurrentes detectan 401
   * al mismo tiempo), reutiliza esa misma promesa en vez de loguear dos
   * veces.
   */
  async login(): Promise<SessionArtifact> {
    if (this.loginInFlight) return this.loginInFlight;

    this.loginInFlight = (async () => {
      logger.info({ strategy: this.opts.authStrategy.name }, "Iniciando login contra ABSA net");
      try {
        const artifact = await this.opts.authStrategy.login(this.opts.credentials);
        this.current = artifact;
        this.opts.store.save(artifact);
        logger.info("Login completado y sesion persistida");
        return artifact;
      } catch (err) {
        logger.error({ err }, "Login contra ABSA net fallo");
        throw err;
      } finally {
        this.loginInFlight = null;
      }
    })();

    return this.loginInFlight;
  }

  /**
   * Devuelve la sesion activa, logueando si todavia no hay una en memoria
   * (intentando primero recuperar la persistida en disco), o relogueando
   * si esta vencida segun estimatedExpiresAt. No detecta 401/403 de una
   * request real — eso lo maneja el caller via invalidateAndRelogin()
   * (ver quote/quoteClient.ts).
   */
  async getSession(): Promise<SessionArtifact> {
    if (this.current && !this.isExpired(this.current)) {
      return this.current;
    }

    const persisted = this.opts.store.load();
    if (persisted && !this.isExpired(persisted)) {
      this.current = persisted;
      return persisted;
    }

    return this.login();
  }

  /** Invalida la sesion actual (ej. tras un 401/403) y logea de nuevo. */
  async invalidateAndRelogin(): Promise<SessionArtifact> {
    logger.warn("Sesion invalidada (401/403 o patron de sesion vencida detectado), relogueando");
    this.current = null;
    this.opts.store.clear();
    return this.login();
  }

  /** Reconstruye un CookieJar de tough-cookie a partir del artefacto persistido. */
  static jarFromArtifact(artifact: SessionArtifact): CookieJar {
    return CookieJar.fromJSON(JSON.stringify(artifact.cookieJarJson));
  }

  private isExpired(artifact: SessionArtifact): boolean {
    if (artifact.estimatedExpiresAt === null) return false;
    const margin = this.opts.refreshMarginMs ?? 30_000;
    return Date.now() >= artifact.estimatedExpiresAt - margin;
  }
}
