import { CookieJar } from "tough-cookie";
import got from "got";
import { chromium } from "playwright";
import type { AbsaCredentials, AuthStrategy, SessionArtifact } from "./types.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { extractRequestVerificationToken } from "./csrf.js";

/**
 * ============================================================================
 * Login confirmado en Fase 0 (ver docs/absa-endpoints.md seccion 1): form
 * POST tradicional a la raiz del sitio, protegido con el mismo token
 * anti-forgery que el resto de los POSTs de ABSA net (__RequestVerificationToken).
 * No es JSON, no es SPA, no se observo 2FA/captcha en el login manual.
 *
 * Se deja PlaywrightAuthStrategy como fallback igual (por si en produccion
 * aparece un challenge anti-bot que HttpFormAuthStrategy no pueda resolver
 * -- ver docs/absa-endpoints.md seccion 6).
 * ============================================================================
 */

/** Confirmado en el HTML del form de login: <input name="Password" ...> sin name en un segundo input password -- probable honeypot anti-bot, se ignora (no tiene name, un browser real tampoco lo manda). */
const LOGIN_FIELDS = { user: "Mail", password: "Password" } as const;

/**
 * Estrategia HTTP directa: login confirmado como POST tradicional
 * form-urlencoded a "/" (la home de ABSA net sirve el form de login cuando
 * no hay sesion activa).
 */
export class HttpFormAuthStrategy implements AuthStrategy {
  readonly name = "http-form";

  async login(credentials: AbsaCredentials): Promise<SessionArtifact> {
    const jar = new CookieJar();

    // 1) GET la home (= pagina de login si no hay sesion) para sacar el token anti-forgery.
    const loginPageResponse = await got.get(config.ABSA_BASE_URL, {
      cookieJar: jar,
      throwHttpErrors: false,
    });
    if (loginPageResponse.statusCode >= 400) {
      throw new Error(`GET a la pagina de login fallo con status ${loginPageResponse.statusCode}`);
    }
    const csrfToken = extractRequestVerificationToken(loginPageResponse.body);

    // 2) POST el form de login.
    const response = await got.post(config.ABSA_BASE_URL, {
      cookieJar: jar,
      form: {
        __RequestVerificationToken: csrfToken,
        [LOGIN_FIELDS.user]: credentials.user,
        [LOGIN_FIELDS.password]: credentials.password,
      },
      throwHttpErrors: false,
      followRedirect: true,
    });

    if (response.statusCode >= 400) {
      throw new Error(
        `Login HTTP fallo con status ${response.statusCode}. ` +
          "Si esto persiste, considerar PlaywrightAuthStrategy (posible cambio en el flujo de login).",
      );
    }

    // Heuristica de exito: si la respuesta final todavia muestra el form de
    // login (campo Password presente), el login fallio (credenciales
    // invalidas u otro motivo) aunque el HTTP status haya sido 200 -- ABSA
    // net re-renderiza el mismo formulario con un error en vez de devolver 4xx.
    if (/name=["']Password["']/i.test(response.body)) {
      throw new Error(
        "Login rechazado por ABSA net (la respuesta todavia muestra el formulario de login). " +
          "Verificar ABSA_USER/ABSA_PASSWORD.",
      );
    }

    logger.info({ strategy: this.name, status: response.statusCode }, "Login HTTP completado");

    return {
      cookieJarJson: jar.toJSON(),
      sessionToken: null, // no se observo token de sesion fuera de cookies
      extraHeaders: {},
      createdAt: Date.now(),
      // TODO FASE 0: no se determino la duracion real de la sesion (docs/absa-endpoints.md seccion 5).
      estimatedExpiresAt: null,
    };
  }
}

/**
 * Estrategia Playwright: fallback para cuando el login depende de JS pesado,
 * hay 2FA/captcha, o la estrategia HTTP directa no funciona de forma
 * confiable. Mas lenta y con mas footprint (requiere un browser), pero
 * replica exactamente lo que hace un usuario real.
 */
export class PlaywrightAuthStrategy implements AuthStrategy {
  readonly name = "playwright-fallback";

  constructor(private readonly headless = true) {}

  async login(credentials: AbsaCredentials): Promise<SessionArtifact> {
    const browser = await chromium.launch({ headless: this.headless });
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(config.ABSA_BASE_URL);

      // Selectores confirmados en Fase 0 (ver docs/absa-endpoints.md seccion 1):
      // form id="loginForm" con inputs name="Mail" / name="Password", boton
      // "INICIAR SESION". Hay un segundo input password sin name (honeypot
      // anti-bot observado en el HTML) que se ignora deliberadamente.
      await page.locator(`input[name="${LOGIN_FIELDS.user}"]`).fill(credentials.user);
      await page.locator(`input[name="${LOGIN_FIELDS.password}"]`).fill(credentials.password);
      await page.getByRole("button", { name: /iniciar sesi[oó]n/i }).click();
      await page.waitForLoadState("networkidle");

      // Asercion de "login exitoso": ABSA net redirige a /Home/Index cuando el
      // login funciona; si seguimos viendo el form de login, algo fallo.
      if (/\/(Account\/Login)?$/i.test(new URL(page.url()).pathname) || page.url() === config.ABSA_BASE_URL) {
        const stillHasPasswordField = await page.locator(`input[name="${LOGIN_FIELDS.password}"]`).count();
        if (stillHasPasswordField > 0) {
          throw new Error(
            "Login via Playwright parece haber fallado (todavia se ve el formulario de login). " +
              "Verificar ABSA_USER/ABSA_PASSWORD.",
          );
        }
      }

      const cookies = await context.cookies();
      const jar = new CookieJar();
      for (const c of cookies) {
        const urlScheme = c.secure ? "https" : "http";
        jar.setCookieSync(
          `${c.name}=${c.value}; Domain=${c.domain}; Path=${c.path}`,
          `${urlScheme}://${c.domain.replace(/^\./, "")}`,
        );
      }

      logger.info({ strategy: this.name }, "Login via Playwright completado");

      return {
        cookieJarJson: jar.toJSON(),
        sessionToken: null,
        extraHeaders: {},
        createdAt: Date.now(),
        estimatedExpiresAt: null,
      };
    } finally {
      await browser.close();
    }
  }
}
