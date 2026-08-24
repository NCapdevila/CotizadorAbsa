/**
 * Lista las versiones que ABSA net tiene de un modelo, ordenadas por parecido
 * con lo que se pidio.
 *
 * Para que existe: la cedula dice una version ("TRACKER 1.2T AT PREMIER") y en
 * ABSA esta escrita distinto ("TRACKER 1.2 TURBO AT6 PREMIER"), a veces con
 * varias parecidas. `npm run cotizar` ya elige la mas parecida sola, pero
 * cuando hay dudas conviene mirar la lista real y clavar el codigo InfoAuto:
 *
 *   npm run versiones -- --marca CHEVROLET --modelo TRACKER --version "1.2 TURBO PREMIER AT"
 *   npm run cotizar   -- --infoauto 120588 ... (el resto de los datos)
 *
 * Es de solo lectura: login + 1-2 GETs al combo (mas uno por version si se
 * pasa --anio). NO crea cotizaciones ni deja nada guardado en la cuenta.
 */
import { config } from "./config.js";
import { logger } from "./logger.js";
import { SessionManager } from "./session/sessionManager.js";
import { SessionStore } from "./session/sessionStore.js";
import { HttpFormAuthStrategy } from "./session/authStrategies.js";
import { AbsaHttpVehicleCatalogResolver } from "./quote/absaCatalogClient.js";
import { parseArgs } from "./cliArgs.js";
import { hayVersionEnLaBusqueda } from "./quote/vehicleVersionMatch.js";
import type { VehiculoInput } from "./quote/types.js";

/** Cuantas versiones del tope de la lista se chequean contra GetAniosVehiculo (1 request cada una). */
const VERSIONES_A_VERIFICAR = 5;

const USAGE = `
Uso:
  npm run versiones -- --marca CHEVROLET --modelo TRACKER --version "1.2 TURBO AT PREMIER"

Requeridos:
  --marca      Marca del vehiculo (ej. CHEVROLET)
  --modelo     Modelo del vehiculo (ej. TRACKER). Se le puede escribir la
               version pegada: --modelo TRACKER 1.2T AT PREMIER

Opcionales:
  --version "<texto>"   Version segun la cedula; es lo que se usa para ordenar
  --anio <anio>         Chequea contra ABSA si las primeras 5 versiones cotizan
                        para ese año (una request por version)
  --todos               Muestra todos los candidatos (por default, los 15 mejores)
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const faltantes = ["marca", "modelo"].filter((k) => !args[k]);
  if (faltantes.length > 0) {
    console.error(`Faltan argumentos requeridos: ${faltantes.join(", ")}`);
    console.error(USAGE);
    process.exit(2);
  }

  const vehiculo: VehiculoInput = {
    marca: args["marca"]!,
    modelo: args["modelo"]!,
    anio: Number(args["anio"] ?? 0),
    version: args["version"],
  };

  const sessionManager = new SessionManager({
    credentials: { user: config.ABSA_USER, password: config.ABSA_PASSWORD },
    authStrategy: new HttpFormAuthStrategy(),
    store: new SessionStore(config.ABSA_SESSION_STORE_PATH),
  });
  const resolver = new AbsaHttpVehicleCatalogResolver(sessionManager);

  const buscado = [vehiculo.marca, vehiculo.modelo, vehiculo.version].filter(Boolean).join(" ");
  console.log(`\nBuscando "${buscado}" en el catalogo de ABSA net...\n`);

  const ranking = await resolver.listarVersiones(vehiculo);
  if (ranking.length === 0) {
    console.log("ABSA net no devolvio ninguna version para esa busqueda.\n");
    return;
  }

  // Sin version pedida no hay ranking posible: la lista sale como la manda
  // ABSA y la columna de parecido no se llena (ver hayVersionEnLaBusqueda).
  const rankeado = hayVersionEnLaBusqueda(vehiculo);
  const mostrar = args["todos"] ? ranking : ranking.slice(0, 15);

  // El año se chequea solo para las primeras: es una request por version y no
  // tiene sentido gastarlas en las que ya se ve que no son.
  const anio = vehiculo.anio;
  const cotizaElAnio = new Map<string, boolean>();
  if (anio) {
    for (const c of mostrar.slice(0, VERSIONES_A_VERIFICAR)) {
      cotizaElAnio.set(c.value, (await resolver.aniosDisponibles(c.value)).includes(String(anio)));
    }
  }

  const columnaAnio = anio ? `  ${String(anio).padEnd(6)}` : "";
  console.log(`${"PARECIDO".padStart(8)}  ${"INFOAUTO".padEnd(9)}${columnaAnio} VERSION EN ABSA`);
  for (const c of mostrar) {
    const falta = c.faltantes.length > 0 ? `   (le falta: ${c.faltantes.join(", ")})` : "";
    const parecido = rankeado ? `${String(c.similitud).padStart(7)}%` : "       -";
    const tieneAnio = cotizaElAnio.get(c.value);
    const anioTxt = anio ? `  ${(tieneAnio === undefined ? "?" : tieneAnio ? "si" : "NO").padEnd(6)}` : "";
    console.log(`${parecido}  ${c.value.padEnd(9)}${anioTxt} ${c.text.trim()}${falta}`);
  }
  if (anio) {
    console.log(`\n(la columna ${anio} dice si ESA version cotiza para ese año; "?" = no se verifico)`);
  }
  if (!rankeado) {
    console.log(`\n(sin --version no hay con que ordenar: esta es la lista tal cual la devuelve ABSA)`);
  }
  if (mostrar.length < ranking.length) {
    console.log(`\n... y ${ranking.length - mostrar.length} mas (usar --todos para verlas).`);
  }

  // Se sugiere la mejor que ADEMAS cotice para el año, que es la que
  // realmente sirve para copiar y pegar.
  const sugerida = mostrar.find((c) => cotizaElAnio.get(c.value)) ?? mostrar[0]!;
  console.log(
    `\nPara cotizar esa version exacta:\n  npm run cotizar -- --infoauto ${sugerida.value} ` +
      `--marca ${vehiculo.marca} --modelo ${vehiculo.modelo} --anio ${anio || "<anio>"} ` +
      `--cp <cp> --dni <dni> --sexo M --estadocivil 2 --nacimiento YYYY-MM-DD\n`,
  );
}

main().catch((err) => {
  logger.error({ err }, "Fallo el listado de versiones");
  console.error(`\nFALLO: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
