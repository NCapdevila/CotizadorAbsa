/** Lista, para varios productores, que aseguradoras les habilita ABSA (solo GET). Temporal. */
import { config } from "../src/config.js";
import { SessionManager } from "../src/session/sessionManager.js";
import { SessionStore } from "../src/session/sessionStore.js";
import { HttpFormAuthStrategy } from "../src/session/authStrategies.js";
import { httpAbsa } from "../src/session/httpAbsa.js";
import { parseCondicionesAseguradoras } from "../src/quote/absaTemplate.js";

async function main() {
  const ids = process.argv.slice(2).map(Number).filter(Number.isFinite);
  const sm = new SessionManager({
    credentials: { user: config.ABSA_USER, password: config.ABSA_PASSWORD },
    authStrategy: new HttpFormAuthStrategy(),
    store: new SessionStore(config.ABSA_SESSION_STORE_PATH),
  });
  const session = await sm.getSession();
  const jar = SessionManager.jarFromArtifact(session);

  for (const idProductor of ids) {
    const url = new URL("/AutoCotizador/ObtenerConfigCotizador", config.ABSA_BASE_URL);
    url.searchParams.set("idProductor", String(idProductor));
    const res = await httpAbsa.get(url, {
      cookieJar: jar,
      headers: { ...session.extraHeaders, "x-requested-with": "XMLHttpRequest" },
      throwHttpErrors: false,
      timeout: { request: 30_000 },
    });
    try {
      const html = (JSON.parse(res.body) as { View?: string }).View ?? res.body;
      const cond = parseCondicionesAseguradoras(html);
      const ids2 = cond.aseguradoras.map((a) => a.id);
      const marca = [68, 69].filter((x) => ids2.includes(x));
      console.log(
        `${String(idProductor).padEnd(7)} ${String(ids2.length).padStart(2)} aseg  ${marca.length ? "<< tiene " + marca.join("+") : ""}  ${cond.aseguradoras.map((a) => a.id).join(",")}`,
      );
    } catch (e) {
      console.log(`${idProductor}  ERROR ${(e as Error).message.slice(0, 60)}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
