/**
 * Debug aislado de MERCANTIL ANDINA (temporal, no forma parte del producto).
 *
 * Hace el flujo real de cotizacion y vuelca a discovery/output/:
 *   - el payload exacto del POST principal
 *   - la respuesta cruda de la propuesta de CADA aseguradora indicada
 *
 * Uso:
 *   npx tsx discovery/debug-mercantil.ts --marca FIAT --modelo CRONOS --anio 2022 --cp 1425 \
 *      --sexo M --estadocivil 2 --nacimiento 1990-01-15 [--productor "..."]
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "../src/config.js";
import { SessionManager } from "../src/session/sessionManager.js";
import { SessionStore } from "../src/session/sessionStore.js";
import { HttpFormAuthStrategy } from "../src/session/authStrategies.js";
import { QuoteClient } from "../src/quote/quoteClient.js";
import { AbsaHttpVehicleCatalogResolver } from "../src/quote/absaCatalogClient.js";
import { httpAbsa } from "../src/session/httpAbsa.js";
import { extractRequestVerificationToken } from "../src/session/csrf.js";
import { toAbsaCotizarPayload, toAbsaPropuestaPayload } from "../src/quote/mapper.js";
import { parseArgs } from "../src/cliArgs.js";
import type { CotizacionInput } from "../src/quote/types.js";

const OUT = path.resolve("discovery/output");
const ID_RIESGO_AUTO = 9;

function write(name: string, data: string) {
  fs.mkdirSync(OUT, { recursive: true });
  const p = path.join(OUT, name);
  fs.writeFileSync(p, data, "utf8");
  console.log(`   -> ${p} (${data.length} bytes)`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sessionManager = new SessionManager({
    credentials: { user: config.ABSA_USER, password: config.ABSA_PASSWORD },
    authStrategy: new HttpFormAuthStrategy(),
    store: new SessionStore(config.ABSA_SESSION_STORE_PATH),
  });
  const resolver = new AbsaHttpVehicleCatalogResolver(sessionManager);
  const quoteClient = new QuoteClient(sessionManager);

  const input: CotizacionInput = {
    ramo: "automotor",
    asegurado: {
      nombre: args["nombre"] ?? "",
      apellido: args["apellido"] ?? "",
      documentoTipo: "DNI",
      documentoNumero: args["dni"],
      fechaNacimiento: args["nacimiento"],
      sexo: (args["sexo"] ?? "M").toUpperCase() === "F" ? "F" : "M",
      estadoCivil: Number(args["estadocivil"] ?? 2) as CotizacionInput["asegurado"]["estadoCivil"],
      codigoPostal: args["cp"],
      provincia: args["provincia"] ?? "1",
    },
    objetoAsegurado: {
      tipo: "vehiculo",
      vehiculo: {
        marca: args["marca"]!,
        modelo: args["modelo"]!,
        anio: Number(args["anio"]),
        version: args["version"],
        codigoCatalogo: args["infoauto"],
        usoTipo: args["uso"] ?? "particular",
      },
    },
    cobertura: { tipo: "todas", sumaAsegurada: args["suma"] ? Number(args["suma"]) : undefined },
    productor: args["productor"],
    extra: Object.fromEntries(
      (args["extra"] ?? "")
        .split(";")
        .filter(Boolean)
        .map((par) => {
          const i = par.indexOf("=");
          return [par.slice(0, i).trim(), par.slice(i + 1).trim()];
        }),
    ),
  };

  console.log("[1] Resolviendo vehiculo...");
  input.absa = await resolver.resolve(input.objetoAsegurado.vehiculo!, args["cp"]);
  console.log(`   ${input.absa.descripcion} infoAuto=${input.absa.infoAuto} idEntity=${input.absa.idEntity}`);

  console.log("[2] Resolviendo template comercial...");
  const template = await quoteClient.templateComercialPara(input);
  console.log(`   idProductor=${template.idProductor} idConfiguracion=${template.idConfiguracion} comision=${template.comision}`);
  console.log(`   aseguradoras: ${template.aseguradoras.map((a) => `${a.id}:${a.nombre}`).join(", ")}`);
  write("debug-template.json", JSON.stringify(template, null, 2));

  const session = await sessionManager.getSession();
  const jar = SessionManager.jarFromArtifact(session);
  const idEntity = input.absa.idEntity;

  console.log("[3] GET pagina cotizador...");
  const pageUrl = new URL(`/AutoCotizador/Cotizar/${idEntity}?accion=1`, config.ABSA_BASE_URL);
  const page = await httpAbsa.get(pageUrl, {
    cookieJar: jar,
    headers: session.extraHeaders,
    throwHttpErrors: false,
    timeout: { request: 30_000 },
  });
  console.log(`   status ${page.statusCode}`);
  write("debug-pagina-cotizador.html", page.body);
  const csrf = extractRequestVerificationToken(page.body);

  console.log("[4] POST /AutoCotizador/Cotizar ...");
  const payload = toAbsaCotizarPayload(input, template, csrf);
  const payloadPlano: Record<string, string> = {};
  for (const [k, v] of payload.entries()) payloadPlano[k] = v;
  write("debug-payload-cotizar.json", JSON.stringify(payloadPlano, null, 2));

  const cotizar = await httpAbsa.post(new URL(`/AutoCotizador/Cotizar/${idEntity}?Length=13`, config.ABSA_BASE_URL), {
    cookieJar: jar,
    body: payload.toString(),
    headers: {
      ...session.extraHeaders,
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      "x-requested-with": "XMLHttpRequest",
    },
    throwHttpErrors: false,
    timeout: { request: 40_000 },
  });
  console.log(`   status ${cotizar.statusCode}`);
  write("debug-cotizar-response.html", cotizar.body);

  const m = cotizar.body.match(/\bcotizar\(\s*'[^']*'\s*,\s*'[^']*'\s*,\s*'[^']*'\s*,\s*'(\d+)'/);
  const nro = m?.[1];
  console.log(`   nroCotizacion = ${nro}`);
  if (!nro) return;

  // Todas las llamadas cotizar(...) que arma la pagina: asi se ve si el portal
  // manda algo distinto por aseguradora.
  const llamadas = [...cotizar.body.matchAll(/\bcotizar\(([^)]*)\)/g)].map((x) => x[1]);
  write("debug-llamadas-cotizar.txt", llamadas.join("\n"));

  const objetivo = (args["aseguradoras"] ?? "71")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter(Number.isFinite);

  for (const id of objetivo) {
    const nombre = template.aseguradoras.find((a) => a.id === id)?.nombre ?? String(id);
    console.log(`[5] POST propuesta ${id} (${nombre}) ...`);
    const body = toAbsaPropuestaPayload(ID_RIESGO_AUTO, id, nro);
    const t0 = Date.now();
    const res = await httpAbsa.post(new URL("/CotizadorPropuesta/CotizarPropuesta/", config.ABSA_BASE_URL), {
      cookieJar: jar,
      body: body.toString(),
      headers: {
        ...session.extraHeaders,
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        "x-requested-with": "XMLHttpRequest",
      },
      throwHttpErrors: false,
      timeout: { request: 120_000 },
    });
    console.log(`   status ${res.statusCode} en ${((Date.now() - t0) / 1000).toFixed(1)}s, ${res.body.length} bytes`);
    console.log(`   body: ${res.body.slice(0, 300)}`);
    write(`debug-propuesta-${id}.html`, res.body);
  }

  console.log(`\nCotizacion ${nro} -- abrila en el portal para comparar.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
