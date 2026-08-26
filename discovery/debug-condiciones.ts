/** Vuelca el bloque de condiciones que ABSA renderiza para un productor (temporal). */
import fs from "node:fs";
import path from "node:path";
import { config } from "../src/config.js";
import { SessionManager } from "../src/session/sessionManager.js";
import { SessionStore } from "../src/session/sessionStore.js";
import { HttpFormAuthStrategy } from "../src/session/authStrategies.js";
import { httpAbsa } from "../src/session/httpAbsa.js";
import { parseCondicionesAseguradoras } from "../src/quote/absaTemplate.js";
import { parseArgs } from "../src/cliArgs.js";

const OUT = path.resolve("discovery/output");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const idProductor = Number(args["idproductor"] ?? 6856);
  const sm = new SessionManager({
    credentials: { user: config.ABSA_USER, password: config.ABSA_PASSWORD },
    authStrategy: new HttpFormAuthStrategy(),
    store: new SessionStore(config.ABSA_SESSION_STORE_PATH),
  });
  const session = await sm.getSession();
  const jar = SessionManager.jarFromArtifact(session);

  const url = new URL("/AutoCotizador/ObtenerConfigCotizador", config.ABSA_BASE_URL);
  url.searchParams.set("idProductor", String(idProductor));
  const res = await httpAbsa.get(url, {
    cookieJar: jar,
    headers: { ...session.extraHeaders, "x-requested-with": "XMLHttpRequest" },
    throwHttpErrors: false,
    timeout: { request: 30_000 },
  });
  console.log("status", res.statusCode, res.body.length, "bytes");
  fs.mkdirSync(OUT, { recursive: true });
  const parsed = JSON.parse(res.body) as { Estado?: unknown; View?: string };
  const html = parsed.View ?? res.body;
  fs.writeFileSync(path.join(OUT, `debug-condiciones-${idProductor}.html`), html, "utf8");

  const cond = parseCondicionesAseguradoras(html);
  fs.writeFileSync(path.join(OUT, `debug-condiciones-${idProductor}.json`), JSON.stringify(cond, null, 2), "utf8");
  console.log("aseguradoras:", cond.aseguradoras.map((a) => `${a.id}:${a.nombre}`).join(", "));
  console.log("\ncampos:");
  for (const [k, v] of Object.entries(cond.campos)) {
    const ops = cond.opciones[k];
    console.log(`  ${k.padEnd(52)} = ${JSON.stringify(v).padEnd(12)} ${ops ? `[${ops.map((o) => o.value).join("|")}]` : ""}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
