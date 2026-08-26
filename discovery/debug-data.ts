/** GET arbitrario a un endpoint de ABSA con la sesion viva (temporal). */
import { config } from "../src/config.js";
import { SessionManager } from "../src/session/sessionManager.js";
import { SessionStore } from "../src/session/sessionStore.js";
import { HttpFormAuthStrategy } from "../src/session/authStrategies.js";
import { httpAbsa } from "../src/session/httpAbsa.js";

async function main() {
  const [ruta, ...pares] = process.argv.slice(2);
  const sm = new SessionManager({
    credentials: { user: config.ABSA_USER, password: config.ABSA_PASSWORD },
    authStrategy: new HttpFormAuthStrategy(),
    store: new SessionStore(config.ABSA_SESSION_STORE_PATH),
  });
  const session = await sm.getSession();
  const jar = SessionManager.jarFromArtifact(session);
  const url = new URL(ruta!, config.ABSA_BASE_URL);
  for (const par of pares) {
    const [k, ...v] = par.split("=");
    url.searchParams.set(k!, v.join("="));
  }
  const res = await httpAbsa.get(url, {
    cookieJar: jar,
    headers: { ...session.extraHeaders, "x-requested-with": "XMLHttpRequest" },
    throwHttpErrors: false,
    timeout: { request: 30_000 },
  });
  console.log("STATUS", res.statusCode, url.toString());
  console.log(res.body.slice(0, 4000));
}
main().catch((e) => { console.error(e); process.exit(1); });
