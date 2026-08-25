/**
 * Busca productores en el catalogo real de ABSA net y verifica el mapeo del
 * formulario (config/absa-productores.json).
 *
 * Para que existe: la lista de productores del formulario es cerrada, y cada
 * opcion tiene que apuntar al `id_Productor` correcto de ABSA. Errarle no da
 * error: cotiza con el acuerdo comercial de otro, o sea precios mal sin
 * ningun sintoma. Esto es lo que permite armar y revisar ese mapeo con datos
 * reales en vez de a ojo:
 *
 *   npm run productores -- --buscar ardama          # id + razon social en ABSA
 *   npm run productores -- --id 6856                # que ofrece ese productor
 *   npm run productores -- --mapear lista.txt       # mapea toda la lista del form de una
 *   npm run productores -- --verificar              # revisa TODO el mapeo
 *
 * Es de solo lectura: login + unos GETs. NO crea cotizaciones ni deja nada
 * guardado en la cuenta.
 */
import fs from "node:fs";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { SessionManager } from "./session/sessionManager.js";
import { SessionStore } from "./session/sessionStore.js";
import { HttpFormAuthStrategy } from "./session/authStrategies.js";
import { AbsaComercialConfigClient, elegirConfiguracion } from "./quote/absaComercialClient.js";
import { loadComercialTemplate } from "./quote/absaTemplate.js";
import { buscarProductorMapeado, loadProductoresConfig, type ProductorMapeado } from "./quote/productoresConfig.js";
import { consultasDeProductor, rankearProductores, type ProductorPuntuado } from "./quote/productorMatch.js";
import { parseArgs } from "./cliArgs.js";

const USAGE = `
Uso:
  npm run productores -- --buscar "ardama"
  npm run productores -- --id 6856
  npm run productores -- --mapear lista-del-formulario.txt
  npm run productores -- --verificar

Modos (uno por corrida):
  --buscar "<texto>"   Busca en el catalogo de ABSA y ordena por parecido.
                       Imprime la entrada lista para pegar en el mapeo.
  --id <idProductor>   Muestra que ofrece ESE productor: configuraciones,
                       comisiones, aseguradoras habilitadas y los campos
                       comerciales con sus opciones validas.
  --mapear <archivo>   Busca de una TODA la lista de opciones del formulario
                       (un nombre por linea; se ignoran vacias y las que
                       arrancan con #) y escribe un borrador del mapeo.
                       Los que no matchean claro NO se mapean: quedan en
                       "_pendientes" para resolver a mano.
  --nombres "a, b, c"  Igual que --mapear pero con la lista escrita a mano.
  --verificar          Recorre config/absa-productores.json y chequea contra
                       ABSA que cada entrada exista y sea cotizable.

Opcionales:
  --campos             Con --id, ademas lista todos los campos comerciales y
                       sus opciones (es larga: sirve para llenar "campos").
  --salida <archivo>   Con --mapear/--nombres: donde escribir el borrador
                       (default: config/absa-productores.draft.json).
  --pisar              Permite sobreescribir el archivo de --salida si existe.
  --minimo <0-100>     Parecido minimo para mapear solo (default 70). Con
                       --minimo 100 solo entran los que matchean exacto y todo
                       lo demas queda en "_pendientes".
  --cotizacion <nro>   Numero de una cotizacion que YA exista en la cuenta, de
                       donde sacar el combo completo de productores. Sin esto
                       se pide una cotizacion nueva, que deja una entidad vacia
                       en la cuenta. El combo se cachea 24h en .session/, asi
                       que pasa una vez por dia como mucho.
`;

/**
 * Debajo de este parecido no se mapea solo: el nombre queda en "_pendientes"
 * con los candidatos, para que lo resuelva una persona.
 *
 * Es deliberadamente conservador. Un id de productor equivocado no falla:
 * cotiza con el acuerdo comercial de otro y los precios salen mal sin ningun
 * sintoma. Revisar de mas cuesta minutos; revisar de menos, cotizaciones.
 */
const SIMILITUD_PARA_MAPEAR_SOLO = 70;

function crearCliente() {
  const sessionManager = new SessionManager({
    credentials: { user: config.ABSA_USER, password: config.ABSA_PASSWORD },
    authStrategy: new HttpFormAuthStrategy(),
    store: new SessionStore(config.ABSA_SESSION_STORE_PATH),
  });
  return new AbsaComercialConfigClient(sessionManager);
}

/**
 * De donde salen los candidatos a productor.
 *
 * Se prefiere el combo completo del cotizador (1036 en esta cuenta) y no la
 * busqueda incremental, porque la busqueda **se saltea productores que
 * existen**: "woscoff" o "ballesteros" no devuelven nada aunque estan en el
 * combo (verificado contra produccion el 2026-08-25). Con el combo entero, el
 * parecido se calcula localmente y no hay recall que perder.
 *
 * La busqueda incremental queda como respaldo para las cuentas donde el combo
 * no viene renderizado en la pagina.
 */
async function candidatos(
  cliente: AbsaComercialConfigClient,
  texto: string,
  nroCotizacionReferencia: string | undefined,
): Promise<{ items: Awaited<ReturnType<AbsaComercialConfigClient["buscarProductores"]>>; fuente: string }> {
  const catalogo = await cliente.catalogoDeProductores(nroCotizacionReferencia);
  if (catalogo.length > 0) return { items: catalogo, fuente: `combo del cotizador (${catalogo.length} productores)` };

  const items = await cliente.buscarProductores(texto);
  return { items, fuente: "busqueda incremental (el combo no vino en la pagina)" };
}

async function buscar(cliente: AbsaComercialConfigClient, texto: string, nroCotizacion: string | undefined) {
  console.log(`\nBuscando "${texto}" en el catalogo de productores de ABSA net...`);
  const { items, fuente } = await candidatos(cliente, texto, nroCotizacion);
  console.log(`Fuente: ${fuente}\n`);
  if (items.length === 0) {
    console.log("ABSA no devolvio ningun productor.\n");
    return;
  }

  const ranking = rankearProductores(items, texto).filter((c) => c.similitud > 0);
  if (ranking.length === 0) {
    console.log(`Ningun productor se parece a "${texto}".\n`);
    return;
  }
  console.log(`${"PARECIDO".padStart(8)}  ${"ID".padEnd(8)} PRODUCTOR EN ABSA`);
  for (const c of ranking.slice(0, 15)) {
    console.log(`${String(c.similitud).padStart(7)}%  ${c.value.padEnd(8)} ${c.text.trim()}`);
  }
  if (ranking.length > 15) console.log(`\n... y ${ranking.length - 15} mas.`);

  const mejor = ranking[0]!;
  console.log(`\nEntrada para config/absa-productores.json (la clave es el valor que manda el formulario):`);
  console.log(
    `  "${texto.toLowerCase()}": { "idProductor": ${mejor.value}, "nombre": ${JSON.stringify(mejor.text.trim())} }`,
  );
  console.log(`\nAntes de darlo por bueno, ver que ofrece:\n  npm run productores -- --id ${mejor.value}\n`);
}

async function detalle(cliente: AbsaComercialConfigClient, idProductor: number, mostrarCampos: boolean) {
  const { idOrganizador } = loadComercialTemplate();
  console.log(`\nPidiendo a ABSA la config comercial del productor ${idProductor}...\n`);
  const cfg = await cliente.detalleDeProductor(idOrganizador, idProductor);

  console.log(`Configuraciones (Comercial.id_Configuracion):`);
  if (cfg.configuraciones.length === 0) {
    console.log(`   (ninguna) -- este productor NO puede cotizar autos con esta cuenta.`);
  }
  for (const c of cfg.configuraciones) console.log(`   ${c.value.padEnd(8)} ${c.text}`);
  if (cfg.configuraciones.length > 1) {
    console.log(`   OJO: hay mas de una. La entrada del mapeo tiene que decir cual, con "idConfiguracion".`);
  }

  console.log(`\nComision: ${cfg.comisionPrincipal}% por default (opciones: ${cfg.comisiones.join(", ") || "-"}), comisionOrg ${cfg.comisionOrg}`);

  console.log(`\nAseguradoras habilitadas (${cfg.condiciones.aseguradoras.length}):`);
  for (const a of cfg.condiciones.aseguradoras) console.log(`   ${String(a.id).padEnd(5)} ${a.nombre}`);

  // Las rebajas son EL dato que hay que mirar: ABSA las devuelve en el default
  // del formulario (casi siempre 0) y el productor las sube a mano hasta el
  // tope que le permite su acuerdo. Sin override, se cotiza con el default.
  // `Item.RebajasComerciales[0].Id_Aseguradora` matchea "rebaja" pero es a QUE
  // aseguradora corresponde la rebaja de al lado, no un valor para elegir.
  const rebajas = Object.entries(cfg.condiciones.campos).filter(
    ([campo]) => /rebaja/i.test(campo) && !/id_aseguradora/i.test(campo),
  );
  if (rebajas.length > 0) {
    console.log(`\nRebajas (default de ABSA -> opciones disponibles):`);
    for (const [campo, valor] of rebajas) {
      const opciones = cfg.condiciones.opciones[campo]?.map((o) => o.value).join(", ") ?? "(campo libre)";
      console.log(`   ${campo.padEnd(46)} ${String(valor).padStart(4)}   [${opciones}]`);
    }
    console.log(
      `\n   Para cotizar con la rebaja que corresponde, agregar a la entrada del mapeo:\n` +
        `     "campos": { ${rebajas.map(([campo]) => `"${campo}": <valor>`).join(", ")} }`,
    );
  }

  if (mostrarCampos) {
    console.log(`\nTodos los campos comerciales de este productor:`);
    for (const [campo, valor] of Object.entries(cfg.condiciones.campos)) {
      const opciones = cfg.condiciones.opciones[campo];
      const detalleOpciones = opciones ? `   [${opciones.map((o) => o.value).join(", ")}]` : "";
      console.log(`   ${campo.padEnd(46)} = ${String(valor).padEnd(10)}${detalleOpciones}`);
    }
  } else {
    console.log(`\n(--campos lista los ${Object.keys(cfg.condiciones.campos).length} campos comerciales con sus opciones)`);
  }
  console.log();
}

/** Piso de tiempo entre busquedas: el mismo criterio conservador que el resto del cliente. */
function esperar(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Un export de planilla pasado por UTF-8 mal leido: "BURGUEÑO" -> "BurgueÃ±O",
 * "OLAVARRÍA" -> "OlavarrÃ­a". Se arregla releyendo los bytes como UTF-8.
 *
 * Sin esto, esos nombres se rompen en el matching (la "Ã±" queda como dos
 * caracteres sueltos) y caen en pendientes por un problema de encoding, no de
 * datos. Solo se toca el texto que tiene la firma del problema, y si la
 * relectura no mejora nada se deja como estaba.
 */
function repararMojibake(texto: string): string {
  // La firma es una "Ã"/"Â" (U+00C3/U+00C2) seguida de un byte de continuacion
  // UTF-8 (U+0080..U+00BF), que en texto normal no aparece nunca.
  if (!/[\u00C2\u00C3][\u0080-\u00BF]/.test(texto)) return texto;
  const reparado = Buffer.from(texto, "latin1").toString("utf8");
  // U+FFFD = lo releido no era UTF-8, o sea que el original estaba bien.
  return reparado.includes("\uFFFD") ? texto : reparado;
}

/**
 * Los nombres de las opciones del formulario. Acepta las dos formas en las que
 * llega la lista:
 *
 * - Texto: un nombre por linea, ignorando vacias y las que arrancan con `#`.
 * - JSON exportado de la planilla: un array de strings, o de objetos
 *   (`{"Productores": "...", "Activos": "SI"}`). Tolera que le falten los
 *   corchetes de afuera, que es como los exporta Google Sheets. Las filas
 *   marcadas como inactivas se saltean.
 */
function leerLista(archivo: string): string[] {
  if (!fs.existsSync(archivo)) {
    throw new Error(`No existe el archivo "${archivo}". Tiene que ser un nombre por linea, o un JSON exportado de la planilla.`);
  }

  const contenido = repararMojibake(fs.readFileSync(archivo, "utf8")).trim();
  if (!contenido.startsWith("[") && !contenido.startsWith("{")) {
    return contenido
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"));
  }

  const filas = JSON.parse(contenido.startsWith("[") ? contenido : `[${contenido}]`) as unknown[];
  const nombres: string[] = [];
  for (const fila of filas) {
    if (typeof fila === "string") {
      if (fila.trim()) nombres.push(fila.trim());
      continue;
    }
    if (!fila || typeof fila !== "object") continue;

    const campos = fila as Record<string, unknown>;
    const activo = campos["Activos"] ?? campos["activos"] ?? campos["Activo"] ?? campos["activo"];
    if (typeof activo === "string" && /^(no|false|0)$/i.test(activo.trim())) continue;
    if (activo === false) continue;

    // La primera columna de texto que no sea la de activo/inactivo: sirve
    // igual si la planilla la titula "Productores", "Nombre" o cualquier cosa.
    const nombre = Object.entries(campos).find(
      ([clave, valor]) => typeof valor === "string" && valor.trim() && !/^activos?$/i.test(clave),
    )?.[1] as string | undefined;
    if (nombre) nombres.push(nombre.trim());
  }
  return nombres;
}

interface Pendiente {
  form: string;
  motivo: string;
  candidatos: string[];
}

/**
 * Ranking de un nombre contra el catalogo ya traido (sin red).
 *
 * Si el catalogo vino vacio (cuenta sin combo precargado) cae a la busqueda
 * incremental, probando consultas de mas especifica a menos: el buscador de
 * ABSA matchea por substring, asi que "WOSCOFF GABRIEL" no encuentra
 * "WOSCOFF, GABRIEL" (esta la coma) y hay que probar palabra por palabra.
 */
async function rankearNombre(
  cliente: AbsaComercialConfigClient,
  catalogo: ProductorPuntuado[] | null,
  nombre: string,
  pausaMs: number,
): Promise<ProductorPuntuado[]> {
  if (catalogo) return rankearProductores(catalogo, nombre);

  const porId = new Map<string, { value: string; text: string }>();
  for (const consulta of consultasDeProductor(nombre)) {
    for (const item of await cliente.buscarProductores(consulta)) {
      if (!porId.has(item.value)) porId.set(item.value, item);
    }
    const ranking = rankearProductores([...porId.values()], nombre);
    if (ranking[0]?.similitud === 100) return ranking;
    await esperar(pausaMs);
  }
  return rankearProductores([...porId.values()], nombre);
}

/**
 * Mapea de una toda la lista de opciones del formulario contra el catalogo de
 * ABSA y escribe un borrador del mapeo.
 *
 * Lo que NO hace, a proposito: mapear lo dudoso. Un nombre que no matchea con
 * claridad queda en "_pendientes" (que el loader ignora) en vez de entrar al
 * mapeo con el id del parecido mas cercano — porque un id equivocado no da
 * error, da precios de otro acuerdo comercial.
 */
async function mapear(
  cliente: AbsaComercialConfigClient,
  nombres: string[],
  salida: string,
  pisar: boolean,
  nroCotizacion: string | undefined,
  minimo: number,
) {
  if (fs.existsSync(salida) && !pisar) {
    throw new Error(
      `"${salida}" ya existe y no se pisa solo (podria ser el mapeo bueno). ` +
        "Usar --salida con otra ruta, o --pisar si es lo que queres.",
    );
  }

  const mapeoActual = loadProductoresConfig();
  const pausaMs = config.ABSA_MIN_REQUEST_INTERVAL_MS;
  const productores: Record<string, Omit<ProductorMapeado, "clave">> = {};
  const pendientes: Pendiente[] = [];
  const filas: string[] = [];

  console.log(`\nMapeando ${nombres.length} opcion(es) del formulario contra el catalogo de ABSA net.`);
  const catalogoCrudo = await cliente.catalogoDeProductores(nroCotizacion);
  // Con el combo entero, el resto es matching local: ni una request mas, ni
  // esperas entre nombre y nombre.
  const catalogo = catalogoCrudo.length > 0 ? rankearProductores(catalogoCrudo, "") : null;
  console.log(
    catalogo
      ? `Fuente: el combo del cotizador, ${catalogoCrudo.length} productores. El match es local.\n`
      : `Fuente: busqueda incremental (el combo no vino en la pagina). Hay un piso de ${pausaMs}ms entre busquedas.\n`,
  );

  for (const [i, nombre] of nombres.entries()) {
    const progreso = `[${String(i + 1).padStart(String(nombres.length).length)}/${nombres.length}]`;

    // Lo que ya esta mapeado se respeta tal cual y no se vuelve a buscar: el
    // mapeo existente puede tener ajustes hechos a mano (rebajas, configuracion).
    // Match exacto a proposito: `resolverProductor` caeria al productor por
    // defecto y marcaria como "ya mapeado" a toda la lista.
    const yaMapeado = mapeoActual ? buscarProductorMapeado(nombre) : undefined;
    if (yaMapeado) {
      const { clave, ...entrada } = yaMapeado;
      productores[clave] = entrada;
      filas.push(`  YA     ${nombre.padEnd(38)} ${String(entrada.idProductor).padEnd(8)} ${entrada.nombre ?? ""}`);
      console.log(`${progreso} ${nombre} -> ya estaba mapeado (${entrada.idProductor})`);
      continue;
    }

    const ranking = await rankearNombre(cliente, catalogo, nombre, pausaMs);
    const mejor = ranking[0];
    // Los de 0% no son candidatos, son los primeros de una lista ordenada:
    // mostrarlos como sugerencia confunde mas de lo que ayuda.
    const candidatos = ranking
      .filter((c) => c.similitud > 0)
      .slice(0, 3)
      .map((c) => `${c.value} ${c.text.trim()} (${c.similitud}%)`);
    // Empate por `score` y no por `similitud`: dos candidatos pueden tener el
    // 100% de lo pedido y no estar empatados en absoluto. "Cassano" cubre igual
    // a "CASSANO" que a "CASSANO_AXR", pero el primero es exacto y el segundo
    // tiene una palabra de mas — y el `score` ya penaliza eso. Comparando
    // similitud, el match exacto quedaba marcado como ambiguo y sin mapear.
    const empatado = ranking.length > 1 && ranking[1]!.score === mejor?.score;

    if (!mejor || mejor.similitud < minimo) {
      pendientes.push({
        form: nombre,
        motivo:
          candidatos.length === 0
            ? "ningun productor de ABSA se parece a este nombre"
            : `el mejor parecido es ${mejor!.similitud}%`,
        candidatos,
      });
      filas.push(`  FALTA  ${nombre.padEnd(38)} ${"-".padEnd(8)} ${candidatos[0] ?? "(nada parecido)"}`);
      console.log(`${progreso} ${nombre} -> SIN MATCH CLARO`);
      continue;
    }

    if (empatado) {
      pendientes.push({ form: nombre, motivo: "hay mas de un candidato con el mismo parecido", candidatos });
      filas.push(`  FALTA  ${nombre.padEnd(38)} ${"-".padEnd(8)} empate: ${candidatos.join(" | ")}`);
      console.log(`${progreso} ${nombre} -> EMPATE entre ${ranking[0]!.value} y ${ranking[1]!.value}`);
      continue;
    }

    // Sin `alias: []`: es ruido en un archivo que despues se edita a mano.
    productores[nombre] = { idProductor: Number(mejor.value), nombre: mejor.text.trim() } as Omit<
      ProductorMapeado,
      "clave"
    >;
    const marca = mejor.similitud === 100 ? "OK   " : "MIRAR";
    filas.push(`  ${marca}  ${nombre.padEnd(38)} ${mejor.value.padEnd(8)} ${mejor.text.trim()} (${mejor.similitud}%)`);
    console.log(`${progreso} ${nombre} -> ${mejor.value} ${mejor.text.trim()} (${mejor.similitud}%)`);
    if (!catalogo) await esperar(pausaMs);
  }

  // De mas a menos prometedor: con una lista larga, lo que hay que revisar
  // primero son los que quedaron cerca, no los que no matchearon nada.
  const parecidoDe = (p: Pendiente) => Number(p.motivo.match(/(\d+)%/)?.[1] ?? -1);
  pendientes.sort((a, b) => parecidoDe(b) - parecidoDe(a));

  const borrador = {
    _comentario:
      `Borrador generado con \`npm run productores -- --mapear\` el ${new Date().toISOString()}. ` +
      "Revisar las lineas MIRAR y resolver _pendientes antes de usarlo como config/absa-productores.json. " +
      "Las rebajas (\"campos\") NO se completan solas: ver `npm run productores -- --id <id>`.",
    ...(mapeoActual?.defecto ? { defecto: mapeoActual.defecto } : {}),
    productores,
    ...(pendientes.length > 0 ? { _pendientes: pendientes } : {}),
  };
  fs.writeFileSync(salida, `${JSON.stringify(borrador, null, 2)}\n`, { mode: 0o600 });

  console.log(`\nResumen:\n`);
  console.log(`  ESTADO  ${"OPCION DEL FORMULARIO".padEnd(38)} ${"ID".padEnd(8)} PRODUCTOR EN ABSA`);
  for (const fila of filas) console.log(fila);

  console.log(`\n  OK    = 100% de parecido, se mapeo solo`);
  console.log(`  MIRAR = se mapeo pero no es identico: confirmar que sea el productor correcto`);
  console.log(`  YA    = ya estaba en ${config.ABSA_PRODUCTORES_PATH}, se copio tal cual`);
  console.log(`  FALTA = no se mapeo, quedo en "_pendientes"`);

  console.log(`\nBorrador escrito en ${salida} (${Object.keys(productores).length} mapeados, ${pendientes.length} pendientes).`);
  if (pendientes.length > 0) {
    console.log(`\nPendientes (resolver a mano con --buscar, o pegando el id):`);
    for (const p of pendientes) {
      console.log(`  "${p.form}": ${p.motivo}`);
      for (const c of p.candidatos) console.log(`      ${c}`);
    }
  }
  console.log(
    `\nDespues: revisar, agregar las rebajas ("campos"), renombrar a ${config.ABSA_PRODUCTORES_PATH} ` +
      `y correr\n  npm run productores -- --verificar\n`,
  );
}

async function verificar(cliente: AbsaComercialConfigClient) {
  const mapeo = loadProductoresConfig();
  if (!mapeo) {
    console.log(`\nNo hay mapeo que verificar: falta ${config.ABSA_PRODUCTORES_PATH}.`);
    console.log(`(sin ese archivo, todo cotiza con el productor de ${config.ABSA_COMERCIAL_TEMPLATE_PATH})\n`);
    return;
  }

  const { idOrganizador } = loadComercialTemplate();
  const entradas = Object.entries(mapeo.productores);
  console.log(`\nVerificando ${entradas.length} entrada(s) de ${config.ABSA_PRODUCTORES_PATH} contra ABSA net...\n`);

  let conProblemas = 0;
  let primera = true;
  for (const [clave, entrada] of entradas) {
    // Son 3 requests por entrada: con un mapeo largo, sin este piso de tiempo
    // seria una rafaga contra ABSA.
    if (!primera) await esperar(config.ABSA_MIN_REQUEST_INTERVAL_MS);
    primera = false;

    const etiqueta = `${clave} -> ${entrada.idProductor}${entrada.nombre ? ` (${entrada.nombre})` : ""}`;
    try {
      const cfg = await cliente.detalleDeProductor(idOrganizador, entrada.idProductor);
      const idConfiguracion = elegirConfiguracion({ ...entrada, clave }, cfg.configuraciones);
      console.log(
        `   OK    ${etiqueta}: configuracion ${idConfiguracion}, comision ${entrada.comision ?? cfg.comisionPrincipal}%, ` +
          `${cfg.condiciones.aseguradoras.length} aseguradoras`,
      );

      // Un override que no es una opcion valida se manda igual pero casi
      // siempre significa que se copio de otro productor.
      for (const [campo, valor] of Object.entries(entrada.campos ?? {})) {
        const opciones = cfg.condiciones.opciones[campo];
        if (opciones && opciones.length > 0 && !opciones.some((o) => o.value === String(valor))) {
          console.log(
            `   AVISO ${clave}: campos["${campo}"]=${valor} no es una opcion de este productor ` +
              `(validas: ${opciones.map((o) => o.value).join(", ")})`,
          );
          conProblemas++;
        }
      }
    } catch (err) {
      conProblemas++;
      console.log(`   FALLA ${etiqueta}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(
    conProblemas === 0
      ? `\nTodas las entradas cotizan.\n`
      : `\n${conProblemas} entrada(s) con problemas: revisar antes de que un lead caiga ahi.\n`,
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cliente = crearCliente();
  const nroCotizacion = args["cotizacion"];

  if (args["buscar"]) return buscar(cliente, args["buscar"], nroCotizacion);
  if (args["id"]) {
    const idProductor = Number(args["id"]);
    if (!Number.isInteger(idProductor)) {
      console.error(`--id invalido: ${args["id"]}`);
      process.exit(2);
    }
    return detalle(cliente, idProductor, Boolean(args["campos"]));
  }
  const nombres = args["mapear"]
    ? leerLista(args["mapear"])
    : args["nombres"]
      ? args["nombres"].split(",").map((n) => n.trim()).filter(Boolean)
      : null;
  if (nombres) {
    if (nombres.length === 0) {
      console.error("La lista de productores vino vacia.");
      process.exit(2);
    }
    const minimo = args["minimo"] ? Number(args["minimo"]) : SIMILITUD_PARA_MAPEAR_SOLO;
    if (!Number.isFinite(minimo) || minimo < 0 || minimo > 100) {
      console.error(`--minimo invalido: ${args["minimo"]} (tiene que ser un numero de 0 a 100)`);
      process.exit(2);
    }
    return mapear(
      cliente,
      nombres,
      args["salida"] ?? "config/absa-productores.draft.json",
      Boolean(args["pisar"]),
      nroCotizacion,
      minimo,
    );
  }

  if (args["verificar"]) return verificar(cliente);

  console.error(USAGE);
  process.exit(2);
}

main().catch((err) => {
  logger.error({ err }, "Fallo el listado de productores");
  console.error(`\nFALLO: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
