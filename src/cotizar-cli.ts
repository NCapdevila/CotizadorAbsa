/**
 * Cotizacion real de punta a punta contra ABSA net, desde la linea de comandos.
 *
 * Hace el recorrido completo con datos humanos (marca/modelo/anio/CP), sin
 * pedir ningun ID interno de ABSA:
 *
 *   login -> GET /Cotizador/NuevaCotizacion (id_Entity) -> resolucion del
 *   vehiculo contra el catalogo real -> POST de cotizacion -> una request por
 *   aseguradora -> resultado normalizado + PDF en disco.
 *
 * OJO: le pega a ABSA net REAL con las credenciales de .env y deja una
 * cotizacion registrada en la cuenta. Usar datos de prueba.
 *
 * Uso:
 *   npm run cotizar -- --marca FIAT --modelo ARGO --anio 2022 --cp 1425 --sexo M --estadocivil 2 --nacimiento 1990-01-15
 *
 * ABSA exige sexo, estado civil y fecha de nacimiento: sin esos tres rechaza
 * la cotizacion con un 400. El documento NO lo exige (--dni es opcional). Ver
 * USAGE abajo para el resto de las opciones.
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { SessionManager } from "./session/sessionManager.js";
import { SessionStore } from "./session/sessionStore.js";
import { HttpFormAuthStrategy } from "./session/authStrategies.js";
import { QuoteClient } from "./quote/quoteClient.js";
import { AbsaHttpVehicleCatalogResolver } from "./quote/absaCatalogClient.js";
import { buildCotizacionPdf } from "./integrations/hubspot/quotePdf.js";
import type { CotizacionInput } from "./quote/types.js";
import { parseArgs } from "./cliArgs.js";
import { loadComercialTemplate } from "./quote/absaTemplate.js";
import { descripcionCotizacion } from "./quote/mapper.js";


const USAGE = `
Uso:
  npm run cotizar -- --marca FIAT --modelo ARGO --anio 2022 --cp 1425 --sexo M --estadocivil 2 --nacimiento 1990-01-15

Requeridos:
  --marca      Marca del vehiculo (texto libre, ej. FIAT)
  --modelo     Modelo del vehiculo (texto libre, ej. ARGO)
  --anio       Anio del vehiculo (ej. 2022)
  --cp         Codigo postal del riesgo (ej. 1425) -- resuelve la localidad
  --sexo       M | F                                (ABSA lo exige)
  --estadocivil  1=Soltero 2=Casado 3=Divorciado
                 4=Viudo 6=No corresponde 7=Concubino   (ABSA lo exige)
  --nacimiento   Fecha de nacimiento YYYY-MM-DD     (ABSA lo exige)

Version del vehiculo (para no cotizar cualquier version del modelo):
  --version "<texto>"        Version tal cual la dice la cedula, ej. "1.2 TURBO AT PREMIER".
                             Se compara contra las descripciones de ABSA y se
                             elige la MAS PARECIDA (no la primera de la lista).
                             Tambien se puede escribir todo junto en --modelo.
  --infoauto <codigo>        Clava el vehiculo exacto por codigo InfoAuto y
                             saltea la busqueda. Los codigos salen de:
                               npm run versiones -- --marca X --modelo Y --anio Z

Opcionales:
  --dni <numero>             Documento del asegurado. ABSA cotiza sin el; sirve
                             para que la cotizacion quede identificada.
  --patente <patente>        Patente del vehiculo. Solo se usa para nombrar la
                             cotizacion en el listado de ABSA.
  --nombre --apellido        Datos del asegurado (ABSA no los exige para cotizar)
  --suma <pesos>             Suma asegurada; si se omite se usa la que sugiere ABSA
  --uso <tipo>               particular (default) | comercial | transporte
  --provincia <id>           ID numerico de provincia (default 1, el de la captura)
  --salida <dir>             Donde dejar el JSON y el PDF (default ./salida)
  --descripcion "<texto>"    Nombre con el que se guarda la cotizacion en ABSA
                             (default: vehiculo - patente - titular - documento)
  --sin-guardar              Cotiza pero NO guarda en ABSA (queda solo local)
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // sexo / estadocivil / nacimiento son obligatorios porque ABSA los valida
  // del lado del servidor (400 "Debe seleccionar un sexo."). El documento no:
  // ABSA cotiza sin el, asi que --dni es opcional.
  const faltantes = ["marca", "modelo", "anio", "cp", "sexo", "estadocivil", "nacimiento"].filter((k) => !args[k]);
  if (faltantes.length > 0) {
    console.error(`Faltan argumentos requeridos: ${faltantes.join(", ")}`);
    console.error(USAGE);
    process.exit(2);
  }

  const anio = Number(args["anio"]);
  if (!Number.isInteger(anio)) {
    console.error(`--anio invalido: ${args["anio"]}`);
    process.exit(2);
  }

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
      sexo: args["sexo"]!.toUpperCase() === "F" ? "F" : "M",
      estadoCivil: Number(args["estadocivil"]) as CotizacionInput["asegurado"]["estadoCivil"],
      codigoPostal: args["cp"],
      // OJO: ABSA espera un ID numerico aca, no el nombre de la provincia.
      // El default (1) es el unico valor observado en una captura real; si el
      // riesgo esta en otra provincia hay que pasar su ID con --provincia.
      provincia: args["provincia"] ?? "1",
    },
    objetoAsegurado: {
      tipo: "vehiculo",
      vehiculo: {
        marca: args["marca"]!,
        modelo: args["modelo"]!,
        anio,
        version: args["version"],
        codigoCatalogo: args["infoauto"],
        patente: args["patente"],
        usoTipo: args["uso"] ?? "particular",
      },
    },
    cobertura: {
      tipo: "todas",
      sumaAsegurada: args["suma"] ? Number(args["suma"]) : undefined,
    },
  };

  const t0 = Date.now();
  console.log(`\nCotizando ${input.objetoAsegurado.vehiculo!.marca} ${input.objetoAsegurado.vehiculo!.modelo} ${anio} (CP ${args["cp"]})`);
  console.log("Esto tarda unos minutos: hay un piso de tiempo entre requests para no generar carga anomala en ABSA.\n");

  console.log("[1/3] Resolviendo el vehiculo contra el catalogo de ABSA...");
  input.absa = await resolver.resolve(input.objetoAsegurado.vehiculo!, args["cp"]);
  // Que version se cotizo es LA decision del cotizador: tiene que verse aca y
  // no solo en el log, junto con que tan segura fue la eleccion.
  const similitud = input.absa.similitudVersion;
  const comoSeEligio = args["infoauto"]
    ? "   [InfoAuto clavado con --infoauto]"
    : similitud === undefined
      ? "   [sin --version: se tomo la primera del catalogo, puede no ser la del cliente]"
      : `   [${similitud}% de parecido a lo pedido]`;
  console.log(`      -> ${input.absa.descripcion ?? "(sin descripcion)"}${comoSeEligio}`);

  const alternativas = input.absa.alternativas ?? [];
  if (alternativas.length > 0 && !args["infoauto"]) {
    console.log(`      -> otras versiones del catalogo (para clavar otra: --infoauto <codigo>):`);
    for (const alt of alternativas) {
      const parecido = similitud === undefined ? "    " : `${String(alt.similitud).padStart(3)}%`;
      console.log(`         ${parecido}  ${String(alt.infoAuto).padEnd(8)} ${alt.descripcion}`);
    }
  }
  if (similitud !== undefined && similitud < 60) {
    console.log(`      -> OJO: el parecido es bajo. Ver la lista completa con "npm run versiones".`);
  }
  console.log(`      -> infoAuto=${input.absa.infoAuto} idVehiculo=${input.absa.idVehiculo} idLocalidad=${input.absa.idLocalidad}`);
  console.log(`      -> id_Entity asignado por ABSA: ${input.absa.idEntity}`);
  if (input.absa.sumaAseguradaSugerida) {
    console.log(`      -> suma asegurada sugerida: ${input.absa.sumaAseguradaSugerida.toLocaleString("es-AR")}`);
  }

  // Se listan a proposito: una exclusion mal configurada
  // (ABSA_ASEGURADORAS_EXCLUIDAS) no tiene ningun otro sintoma visible que la
  // compañia que creias sacada apareciendo en el resultado.
  const aCotizar = loadComercialTemplate().aseguradoras;
  console.log(`\n[2/3] Cotizando contra ${aCotizar.length} aseguradoras: ${aCotizar.map((a) => a.nombre).join(", ")}`);
  const result = await quoteClient.cotizar(input);

  console.log(`\n[3/3] Listo en ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  console.log(`\nNumero de cotizacion ABSA: ${result.numeroCotizacion}`);
  console.log(`Opciones obtenidas: ${result.opciones.length}\n`);

  const fmt = new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 });
  for (const o of [...result.opciones].sort((a, b) => a.premio - b.premio)) {
    console.log(`   ${fmt.format(o.premio).padStart(14)}   ${o.plan}`);
  }

  const fallos = (result.rawAbsaResponse as { fallos?: string[] })?.fallos ?? [];
  if (fallos.length > 0) {
    console.log(`\nAseguradoras sin cotizacion (${fallos.length}):`);
    for (const f of fallos) console.log(`   - ${f}`);
  }

  // El resultado tiene datos del asegurado: mismo trato que .queue/ (gitignored).
  const outDir = args["salida"] ?? "salida";
  fs.mkdirSync(outDir, { recursive: true });
  const base = `cotizacion-${result.numeroCotizacion ?? Date.now()}`;
  const jsonPath = path.join(outDir, `${base}.json`);
  const pdfPath = path.join(outDir, `${base}.pdf`);

  fs.writeFileSync(jsonPath, JSON.stringify({ input, result }, null, 2), { mode: 0o600 });
  fs.writeFileSync(pdfPath, await buildCotizacionPdf(input, result), { mode: 0o600 });

  console.log(`\nGuardado local:`);
  console.log(`   ${jsonPath}`);
  console.log(`   ${pdfPath}`);

  // Guardar en ABSA es lo que hace que la cotizacion quede en el listado y se
  // pueda recuperar despues; sin esto queda solo como una consulta efimera.
  if (args["sin-guardar"]) {
    console.log("\n--sin-guardar: NO se guardo en ABSA net (queda solo el archivo local).\n");
    return;
  }
  if (!result.numeroCotizacion) {
    console.log("\nNo se guardo en ABSA: la cotizacion no devolvio numero.\n");
    return;
  }

  const descripcion = args["descripcion"] ?? descripcionCotizacion(input);
  console.log(`\nGuardando en ABSA net como: "${descripcion}"`);
  await quoteClient.guardarCotizacion(input.absa!.idEntity, result.numeroCotizacion, descripcion);
  console.log(`Cotizacion ${result.numeroCotizacion} guardada en ABSA net bajo tu usuario.\n`);
}

main().catch((err) => {
  logger.error({ err }, "Fallo la cotizacion");
  console.error(`\nFALLO: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
