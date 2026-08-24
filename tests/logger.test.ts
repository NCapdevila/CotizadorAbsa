import { describe, expect, it } from "vitest";
import { serializeError } from "../src/logger.js";
import { BusinessValidationError } from "../src/quote/errors.js";

/**
 * Regresion de una fuga real: un timeout de `got` logueado como
 * `logger.warn({ err }, ...)` volcaba a stdout el cookie jar completo, con la
 * cookie de sesion viva de ABSA (`.AspNet.ApplicationCookie`) — suficiente para
 * entrar a la cuenta del broker sin credenciales.
 */
describe("serializeError", () => {
  const COOKIE_VIVA = ".AspNet.ApplicationCookie=mwR9csWAx8buDdWjyhm2i147u_Iq-kFsSasVXOYNYVk9";

  /** Imita la forma de un RequestError de got, que adjunta todo el `options`. */
  function fakeGotError() {
    const err = new Error("Timeout awaiting 'request' for 90000ms") as Error & Record<string, unknown>;
    err.name = "TimeoutError";
    err["code"] = "ETIMEDOUT";
    err["options"] = {
      method: "POST",
      url: "https://www.absanet.net/CotizadorPropuesta/CotizarPropuesta/",
      headers: { cookie: COOKIE_VIVA, "content-type": "application/x-www-form-urlencoded" },
      cookieJar: { cookies: [{ key: ".AspNet.ApplicationCookie", value: "mwR9csWAx8buDdWjyhm2i147u_Iq" }] },
      password: "hunter2",
    };
    return err;
  }

  it("no deja pasar la cookie de sesion ni el cookie jar de un error de got", () => {
    const serializado = JSON.stringify(serializeError(fakeGotError()));

    expect(serializado).not.toContain("AspNet.ApplicationCookie");
    expect(serializado).not.toContain("mwR9csWAx8buDdWjyhm2i147u_Iq");
    expect(serializado).not.toContain("hunter2");
    expect(serializado).not.toContain("cookieJar");
  });

  it("igual conserva lo necesario para diagnosticar", () => {
    const out = serializeError(fakeGotError()) as Record<string, unknown>;

    expect(out["type"]).toBe("TimeoutError");
    expect(out["code"]).toBe("ETIMEDOUT");
    expect(out["message"]).toMatch(/Timeout/);
    expect(out["url"]).toBe("https://www.absanet.net/CotizadorPropuesta/CotizarPropuesta/");
    expect(out["method"]).toBe("POST");
  });

  it("conserva los detalles de un error de negocio, recortados si son enormes", () => {
    const corto = serializeError(new BusinessValidationError("rechazado", { faltantes: ["sexo"] })) as Record<string, unknown>;
    expect(corto["detalles"]).toEqual({ faltantes: ["sexo"] });

    const largo = serializeError(new BusinessValidationError("rechazado", "x".repeat(5000))) as Record<string, unknown>;
    expect(String(largo["detalles"])).toHaveLength(800 + "... <recortado>".length);
  });

  it("deja pasar tal cual lo que no es un Error", () => {
    expect(serializeError("un string suelto")).toBe("un string suelto");
  });
});
