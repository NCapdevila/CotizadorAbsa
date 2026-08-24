export interface AbsaCredentials {
  user: string;
  password: string;
}

/**
 * Artefacto de sesion persistible. El cookie jar cubre el caso "sesion =
 * cookie(s)"; sessionToken cubre el caso "sesion = token en header/body"
 * (algunos SPA devuelven un token JSON en vez de, o ademas de, cookies).
 * Fase 0 determina cual de los dos (o ambos) aplica a ABSA net — ver
 * docs/absa-endpoints.md seccion 2.
 */
export interface SessionArtifact {
  /** tough-cookie CookieJar serializado (jar.toJSON()). */
  cookieJarJson: unknown;
  /** Token de sesion si ABSA net lo devuelve fuera de una cookie (o null). */
  sessionToken: string | null;
  /** Cualquier header adicional que haya que reenviar en cada request (CSRF, etc). */
  extraHeaders: Record<string, string>;
  /** Timestamp epoch ms de cuando se creo esta sesion. */
  createdAt: number;
  /**
   * Timestamp epoch ms estimado de expiracion, si se pudo determinar en
   * Fase 0 (por ejemplo, a partir de un Max-Age de cookie). Si no se sabe,
   * queda null y la deteccion de expiracion se apoya solo en 401/403.
   */
  estimatedExpiresAt: number | null;
}

export interface AuthStrategy {
  /** Nombre human-readable para logs (ej "http-form", "playwright-fallback"). */
  readonly name: string;
  login(credentials: AbsaCredentials): Promise<SessionArtifact>;
}
