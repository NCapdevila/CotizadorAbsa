import { describe, expect, it } from "vitest";
import { crearAgenteProxy } from "../src/session/httpAbsa.js";

/**
 * El proxy existe porque ABSA filtra por lista blanca de IPs: desde un
 * servidor no habilitado hay que salir por una IP que sí lo esté. Lo que más
 * importa acá es que SIN la variable no cambie absolutamente nada — ese es el
 * rollback.
 */
describe("crearAgenteProxy", () => {
  it("sin proxy configurado no crea agente (conexion directa, comportamiento de siempre)", () => {
    expect(crearAgenteProxy("")).toBeUndefined();
    expect(crearAgenteProxy("   ")).toBeUndefined();
  });

  it("socks5:// -> agente SOCKS (lo que da un tunel SSH)", () => {
    const agente = crearAgenteProxy("socks5://127.0.0.1:1080");
    expect(agente).toBeDefined();
    expect(agente!.https.constructor.name).toBe("SocksProxyAgent");
    // El mismo agente para http y https: el tunel no distingue.
    expect(agente!.http).toBe(agente!.https);
  });

  it("http:// -> agente de proxy HTTP", () => {
    const agente = crearAgenteProxy("http://proxy.interno:3128");
    expect(agente!.https.constructor.name).toBe("HttpsProxyAgent");
  });
});
