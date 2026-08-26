/**
 * Compara, para UN productor, cotizar con los campos que ABSA renderiza para el
 * (como hace el portal) vs. pisandolos con los del archivo de ardama (lo que
 * hace hoy el codigo). Temporal.
 *
 *   npx tsx discovery/debug-productor.ts --idproductor 11556 --modo absa|archivo
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "../src/config.js";
import { SessionManager } from "../src/session/sessionManager.js";
import { SessionStore } from "../src/session/sessionStore.js";
import { HttpFormAuthStrategy } from "../src/session/authStrategies.js";
import { httpAbsa } from "../src/session/httpAbsa.js";
import { extractRequestVerificationToken } from "../src/session/csrf.js";
import { AbsaHttpVehicleCatalogResolver } from "../src/quote/absaCatalogClient.js";
import { AbsaComercialConfigClient } from "../src/quote/absaComercialClient.js";
import { loadComercialTemplate, armarTemplateComercial } from "../src/quote/absaTemplate.js";
import { toAbsaCotizarPayload, toAbsaPropuestaPayload } from "../src/quote/mapper.js";
import { parseArgs } from "../src/cliArgs.js";
import type { CotizacionInput } from "../src/quote/types.js";

const OUT = path.resolve("discovery/output");
const ID_RIESGO_AUTO = 9;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const idProductor = Number(args["idproductor"] ?? 11556);
  const modo = args["modo"] ?? "absa"; // absa = solo campos del productor; archivo = pisados con ardama
  const objetivo = (args["aseguradoras"] ?? "71").split(",").map(Number).filter(Number.isFinite);

  const sm = new SessionManager({
    credentials: { user: config.ABSA_USER, password: config.ABSA_PASSWORD },
    authStrategy: new HttpFormAuthStrategy(),
    store: new SessionStore(config.ABSA_SESSION_STORE_PATH),
  });
  const resolver = new AbsaHttpVehicleCatalogResolver(sm);
  const comercial = new AbsaComercialConfigClient(sm);
  const base = loadComercialTemplate();

  const input: CotizacionInput = {
    ramo: "automotor",
    asegurado: {
      nombre: "", apellido: "", documentoTipo: "DNI",
      documentoNumero: args["dni"] ?? "22220405",
      fechaNacimiento: args["nacimiento"] ?? "1971-05-10",
      sexo: "M", estadoCivil: 2,
      codigoPostal: args["cp"] ?? "5019",
      provincia: args["provincia"] ?? "4",
    },
    objetoAsegurado: {
      tipo: "vehiculo",
      vehiculo: {
        marca: args["marca"] ?? "FORD", modelo: args["modelo"] ?? "RANGER",
        anio: Number(args["anio"] ?? 2016),
        codigoCatalogo: args["infoauto"] ?? "180629",
        usoTipo: "particular",
      },
    },
    cobertura: { tipo: "todas" },
  };

  console.log(`[1] Resolviendo vehiculo...`);
  input.absa = await resolver.resolve(input.objetoAsegurado.vehiculo!, input.asegurado.codigoPostal);
  console.log(`   ${input.absa.descripcion} infoAuto=${input.absa.infoAuto} idEntity=${input.absa.idEntity}`);

  console.log(`[2] Config comercial del productor ${idProductor} (modo=${modo})...`);
  const cfg = await comercial.detalleDeProductor(base.idOrganizador, idProductor);
  const template = armarTemplateComercial({
    base,
    idProductor,
    idConfiguracion: Number(cfg.configuraciones[0]?.value ?? base.idConfiguracion),
    comision: cfg.comisionPrincipal,
    condiciones: cfg.condiciones,
    overrides:
      modo === "archivo"
        ? { "Comercial.ConfigCotizacion.ComisionOrg": cfg.comisionOrg, ...base.camposPorAseguradora }
        : { "Comercial.ConfigCotizacion.ComisionOrg": cfg.comisionOrg, "Comercial.RebajaMercantil": 20 },
  });
  console.log(`   idConfiguracion=${template.idConfiguracion} comision=${template.comision}`);
  console.log(`   aseguradoras: ${template.aseguradoras.map((a) => `${a.id}:${a.nombre}`).join(", ")}`);
  console.log(`   campos enviados: ${Object.keys(template.camposPorAseguradora).length}`);

  const session = await sm.getSession();
  const jar = SessionManager.jarFromArtifact(session);
  const idEntity = input.absa.idEntity;

  const page = await httpAbsa.get(new URL(`/AutoCotizador/Cotizar/${idEntity}?accion=1`, config.ABSA_BASE_URL), {
    cookieJar: jar, headers: session.extraHeaders, throwHttpErrors: false, timeout: { request: 30_000 },
  });
  const csrf = extractRequestVerificationToken(page.body);

  const payload = toAbsaCotizarPayload(input, template, csrf);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, `debug-payload-${idProductor}-${modo}.json`),
    JSON.stringify(Object.fromEntries(payload.entries()), null, 2), "utf8");

  console.log(`[3] POST /AutoCotizador/Cotizar ...`);
  const cot = await httpAbsa.post(new URL(`/AutoCotizador/Cotizar/${idEntity}?Length=13`, config.ABSA_BASE_URL), {
    cookieJar: jar, body: payload.toString(),
    headers: { ...session.extraHeaders, "content-type": "application/x-www-form-urlencoded; charset=UTF-8", "x-requested-with": "XMLHttpRequest" },
    throwHttpErrors: false, timeout: { request: 40_000 },
  });
  console.log(`   status ${cot.statusCode}`);
  if (cot.statusCode !== 200) {
    console.log(`   body: ${cot.body.slice(0, 600)}`);
    return;
  }
  const nro = cot.body.match(/\bcotizar\(\s*'[^']*'\s*,\s*'[^']*'\s*,\s*'[^']*'\s*,\s*'(\d+)'/)?.[1];
  console.log(`   nroCotizacion = ${nro}`);
  if (!nro) return;

  for (const id of objetivo) {
    const nombre = template.aseguradoras.find((a) => a.id === id)?.nombre ?? String(id);
    const res = await httpAbsa.post(new URL("/CotizadorPropuesta/CotizarPropuesta/", config.ABSA_BASE_URL), {
      cookieJar: jar, body: toAbsaPropuestaPayload(ID_RIESGO_AUTO, id, nro).toString(),
      headers: { ...session.extraHeaders, "content-type": "application/x-www-form-urlencoded; charset=UTF-8", "x-requested-with": "XMLHttpRequest" },
      throwHttpErrors: false, timeout: { request: 120_000 },
    });
    const ok = res.body.includes("table-propuesta");
    console.log(`[4] ${nombre} (${id}): ${ok ? "COTIZO OK" : "FALLO"} -- ${res.body.length} bytes ${ok ? "" : res.body.slice(0, 120)}`);
    fs.writeFileSync(path.join(OUT, `debug-propuesta-${idProductor}-${modo}-${id}.html`), res.body, "utf8");
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
