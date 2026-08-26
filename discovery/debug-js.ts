/** Baja scripts del portal para comparar que manda el browser (temporal). */
import fs from "node:fs";
import path from "node:path";
import { config } from "../src/config.js";
import { SessionManager } from "../src/session/sessionManager.js";
import { SessionStore } from "../src/session/sessionStore.js";
import { HttpFormAuthStrategy } from "../src/session/authStrategies.js";
import { httpAbsa } from "../src/session/httpAbsa.js";

const OUT = path.resolve("discovery/output/js");

async function main() {
  const rutas = process.argv.slice(2);
  const sm = new SessionManager({
    credentials: { user: config.ABSA_USER, password: config.ABSA_PASSWORD },
    authStrategy: new HttpFormAuthStrategy(),
    store: new SessionStore(config.ABSA_SESSION_STORE_PATH),
  });
  const session = await sm.getSession();
  const jar = SessionManager.jarFromArtifact(session);
  fs.mkdirSync(OUT, { recursive: true });
  for (const ruta of rutas) {
    const res = await httpAbsa.get(new URL(ruta, config.ABSA_BASE_URL), {
      cookieJar: jar, headers: session.extraHeaders, throwHttpErrors: false, timeout: { request: 30_000 },
    });
    const nombre = ruta.split("?")[0]!.split("/").pop()!;
    const destino = path.join(OUT, `${ruta.split("/").slice(-2, -1)[0]}-${nombre}`);
    fs.writeFileSync(destino, res.body, "utf8");
    console.log(res.statusCode, res.body.length, destino);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
