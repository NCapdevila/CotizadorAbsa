import { afterEach, beforeEach, describe, expect, it } from "vitest";
import nock from "nock";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "../src/session/sessionManager.js";
import { SessionStore } from "../src/session/sessionStore.js";
import { HttpFormAuthStrategy } from "../src/session/authStrategies.js";
import { config } from "../src/config.js";

/** HTML minimo con el token anti-forgery, como el que devuelve el GET de "/" cuando no hay sesion activa. */
const LOGIN_PAGE_HTML = `<html><body><form id="loginForm">
  <input type="hidden" name="__RequestVerificationToken" value="test-csrf-token" />
  <input type="text" name="Mail" />
  <input type="password" name="Password" />
</form></body></html>`;

/** HTML de exito: pagina post-login (ya no muestra el form de login). */
const HOME_HTML = `<html><body><h1>Principal - AbsaNet</h1></body></html>`;

describe("SessionManager + HttpFormAuthStrategy", () => {
  let storePath: string;

  beforeEach(() => {
    storePath = path.join(os.tmpdir(), `absa-session-test-${Date.now()}-${Math.random()}.json`);
    nock.cleanAll();
  });

  afterEach(() => {
    nock.cleanAll();
    if (fs.existsSync(storePath)) fs.unlinkSync(storePath);
  });

  function buildManager() {
    return new SessionManager({
      credentials: { user: config.ABSA_USER, password: config.ABSA_PASSWORD },
      authStrategy: new HttpFormAuthStrategy(),
      store: new SessionStore(storePath),
    });
  }

  /** Mockea el GET (token) + POST (login) contra la raiz, como hace HttpFormAuthStrategy. */
  function mockLoginFlow(opts?: { postStatus?: number; postBody?: string; times?: number }) {
    const times = opts?.times ?? 1;
    const scope = nock(config.ABSA_BASE_URL);
    scope
      .get("/")
      .times(times)
      .reply(200, LOGIN_PAGE_HTML, { "set-cookie": "ASP.NET_SessionId=abc123; Path=/" });
    scope
      .post("/")
      .times(times)
      .reply(opts?.postStatus ?? 200, opts?.postBody ?? HOME_HTML);
    return scope;
  }

  it("hace GET (token) + POST de login via HTTP y persiste la sesion en disco", async () => {
    mockLoginFlow();

    const session = await buildManager().getSession();

    expect(session.cookieJarJson).toBeDefined();
    expect(fs.existsSync(storePath)).toBe(true);
  });

  it("reutiliza la sesion persistida en vez de loguear de nuevo", async () => {
    const scope = mockLoginFlow();

    await buildManager().getSession();
    expect(scope.isDone()).toBe(true);

    // Segundo manager, misma store, SIN mock de login pendiente: si
    // intentara loguear de nuevo, nock (con disableNetConnect) tiraria error.
    const session = await buildManager().getSession();
    expect(session.cookieJarJson).toBeDefined();
  });

  it("invalidateAndRelogin fuerza un login nuevo aunque haya sesion persistida", async () => {
    mockLoginFlow({ times: 2 });

    const manager = buildManager();
    await manager.getSession();
    const renewed = await manager.invalidateAndRelogin();

    expect(renewed.cookieJarJson).toBeDefined();
    expect(nock.isDone()).toBe(true);
  });

  it("propaga el error si el GET de la pagina de login falla (ej. 500)", async () => {
    nock(config.ABSA_BASE_URL).get("/").reply(500, "error interno");

    await expect(buildManager().getSession()).rejects.toThrow();
  });

  it("propaga el error si el POST de login sigue mostrando el form (credenciales invalidas)", async () => {
    nock(config.ABSA_BASE_URL)
      .get("/")
      .reply(200, LOGIN_PAGE_HTML, { "set-cookie": "ASP.NET_SessionId=abc123; Path=/" });
    nock(config.ABSA_BASE_URL).post("/").reply(200, LOGIN_PAGE_HTML);

    await expect(buildManager().getSession()).rejects.toThrow(/rechazado/i);
  });
});
