/**
 * Matching de versiones contra el catalogo de ABSA net.
 *
 * El problema real: la cedula (o el formulario) dice la version en el lenguaje
 * de la marca ("TRACKER 1.2T AT PREMIER") y ABSA la tiene escrita a su manera
 * ("CHEVROLET - CHEVROLET - TRACKER 1.2 TURBO AT6 PREMIER"). Nunca son iguales
 * caracter por caracter, asi que hay que elegir la MAS PARECIDA.
 *
 * Antes el resolver se quedaba con el primer candidato de `/Combo/GetVehiculos`
 * que tuviera el año pedido. Confirmado con una captura real (ver
 * docs/absa-endpoints.md seccion 3.1): ese combo NO viene ordenado por
 * relevancia sino por InfoAuto descendente (el codigo mas nuevo primero), asi
 * que "el primero" era en la practica "la version mas nueva del modelo", que
 * casi nunca es la del cliente.
 *
 * Este modulo es puro (no toca la red) a proposito: es la parte que conviene
 * testear contra las descripciones reales del catalogo sin depender de una
 * sesion de ABSA.
 */
import type { VehiculoInput } from "./types.js";

/** Item crudo del combo de ABSA: `value` = codigo InfoAuto, `text` = descripcion. */
export interface CandidatoCatalogo {
  value: string;
  text: string;
}

export interface CandidatoPuntuado extends CandidatoCatalogo {
  /** Puntaje crudo (puede ser negativo). Sirve para ordenar, no para mostrar. */
  score: number;
  /** `score` normalizado a 0..100 contra el maximo posible de ESA busqueda. Esto es lo que se muestra. */
  similitud: number;
  /** Rasgos pedidos que el candidato tiene (para explicar por que gano). */
  coincidencias: string[];
  /** Rasgos pedidos que al candidato le faltan (para explicar por que perdio). */
  faltantes: string[];
}

type Transmision = "AT" | "CVT" | "MT";

interface Rasgos {
  /** Cilindrada normalizada, ej. "1.2". */
  cilindrada?: string;
  transmision?: Transmision;
  turbo: boolean;
  /** El resto de las palabras (marca, modelo, nivel de equipamiento), sin repetidos. */
  palabras: string[];
}

/**
 * Pesos del matching. La cilindrada pesa mucho mas que el equipamiento a
 * proposito: cotizar una 1.8 cuando el auto es 1.2 da una prima mal, mientras
 * que confundir PREMIER con PREMIER PLUS es un desvio menor.
 */
const PESOS = {
  cilindradaIgual: 40,
  cilindradaDistinta: -60,
  cilindradaAusente: -8,
  transmisionIgual: 18,
  /** AT vs CVT: las dos son automaticas, no es un error grave. */
  transmisionParcial: 4,
  transmisionDistinta: -25,
  transmisionAusente: -5,
  turboIgual: 12,
  turboFaltante: -15,
  turboSobrante: -6,
  palabraIgual: 12,
  palabraParcial: 6,
  palabraFaltante: -10,
  /** Penalidad chica por palabra de mas: entre dos que matchean todo, gana la mas ajustada. */
  palabraSobrante: -2,
} as const;

/**
 * Marcas diacriticas de la forma NFD (U+0300..U+036F): se sacan para que
 * "ALLURÉ" y "ALLURE" sean la misma palabra. Se arma con fromCharCode para no
 * meter escapes unicode ilegibles en el medio de la cadena de replaces.
 */
const DIACRITICOS = new RegExp(`[${String.fromCharCode(0x300)}-${String.fromCharCode(0x36f)}]`, "g");

const CILINDRADA = /^\d\.\d$/;
const TURBO = /^(TURBO|TURBODIESEL|TB|TBI)$/;
const TRANSMISIONES: Array<[RegExp, Transmision]> = [
  [/^\d?AT\d?$/, "AT"],
  [/^AUT(O|OMATICA|OMATICO)?$/, "AT"],
  [/^(TIPTRONIC|TRONIC|STRONIC|DSG|DCT|PDK|MULTITRONIC)$/, "AT"],
  [/^(CVT|XTRONIC|MULTIDRIVE)$/, "CVT"],
  [/^\d?MT\d?$/, "MT"],
  [/^(MEC|MECANICA|MANUAL)$/, "MT"],
];

/**
 * Deja el texto en la forma canonica con la que se comparan pedido y catalogo.
 * Las sustituciones no son cosmeticas: son las equivalencias reales entre como
 * escribe la marca y como escribe ABSA (`1.2T` = `1.2 TURBO`, `A/T` = `AT`), y
 * el descarte del año de linea (`L/21`), que no es parte de la version.
 */
export function normalizarDescripcion(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(DIACRITICOS, "")
    .toUpperCase()
    .replace(/(\d),(\d)/g, "$1.$2")
    .replace(/\bA\s*\/\s*T\b/g, " AT ")
    .replace(/\bM\s*\/\s*T\b/g, " MT ")
    .replace(/\bL\s*\/\s*\d{2,4}\b/g, " ")
    .replace(/(\d\.\d)\s*T(?![A-Z0-9])/g, "$1 TURBO")
    .replace(/(\d\.\d)(?=[A-Z])/g, "$1 ")
    // ABSA separa la letra del numero en los modelos que se llaman asi:
    // escribe "C 3", "C 4 LOUNGE", "C 5 AIRCROSS", y el formulario manda "C3".
    // Como `/Combo/GetVehiculos` matchea substrings, "C3" no aparece en
    // ninguna descripcion y la busqueda vuelve vacia. Se aplica de los dos
    // lados (pedido y catalogo), asi que si alguna marca SI lo escribe junto
    // los dos quedan igual y el matching no se altera.
    .replace(/\b([A-Z])(\d)\b/g, "$1 $2")
    .replace(/[^A-Z0-9.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function clasificarTransmision(token: string): Transmision | undefined {
  for (const [patron, transmision] of TRANSMISIONES) {
    if (patron.test(token)) return transmision;
  }
  return undefined;
}

/** Un token que ya habla de la version y no del nombre del modelo (corta la busqueda amplia). */
function esTokenDeVersion(token: string): boolean {
  return CILINDRADA.test(token) || TURBO.test(token) || clasificarTransmision(token) !== undefined;
}

function extraerRasgos(texto: string): Rasgos {
  const rasgos: Rasgos = { turbo: false, palabras: [] };
  const vistas = new Set<string>();

  for (const crudo of normalizarDescripcion(texto).split(" ")) {
    const token = crudo.replace(/^\.+|\.+$/g, "");
    if (!token) continue;

    if (CILINDRADA.test(token)) {
      rasgos.cilindrada ??= token;
      continue;
    }
    if (TURBO.test(token)) {
      rasgos.turbo = true;
      continue;
    }
    const transmision = clasificarTransmision(token);
    if (transmision) {
      rasgos.transmision ??= transmision;
      continue;
    }
    // ABSA repite la marca en el texto del combo ("FIAT - FIAT - ARGO ..."):
    // sin deduplicar, la marca contaria doble en el puntaje.
    if (vistas.has(token)) continue;
    vistas.add(token);
    rasgos.palabras.push(token);
  }

  return rasgos;
}

/**
 * El "L/25" del final de las descripciones de ABSA: el año de linea, o sea
 * desde que modelo rige esa version ("TRACKER 1.2 TURBO PREMIER AT6 L/25").
 * No es parte de la version -- la misma version aparece varias veces, una por
 * linea -- pero sirve para desempatar (ver `desvioDeLinea`).
 */
function anioDeLinea(texto: string): number | undefined {
  const m = texto.toUpperCase().match(/\bL\s*\/\s*(\d{2,4})\b/);
  if (!m) return undefined;
  const n = Number(m[1]);
  return n < 100 ? 2000 + n : n;
}

/**
 * Desempate entre versiones que puntuan igual porque solo se diferencian en el
 * año de linea (pasa siempre: "... PREMIER AT6", "... PREMIER AT6 L/22" y
 * "... PREMIER AT6 L/25" son la misma version en tres lineas distintas).
 *
 * Orden: primero la linea que ya estaba vigente para el año del auto (la mas
 * cercana), despues la version sin año de linea (la original del modelo), y al
 * final las lineas posteriores al auto, que no pueden ser la suya. El filtro
 * duro lo sigue haciendo `GetAniosVehiculo`; esto evita gastar requests
 * probando lineas que no van y elegir mal cuando dos lineas cubren el año.
 */
function desvioDeLinea(texto: string, anio: number): number {
  if (!anio) return 0;
  const linea = anioDeLinea(texto);
  if (linea === undefined) return 100;
  return linea <= anio ? anio - linea : 1000 + (linea - anio);
}

/** PRECISION vs PRECISIO, CONECTIVIDAD vs CONECTIVI.: ABSA trunca las descripciones largas. */
function esLaMismaPalabra(a: string, b: string): boolean {
  return a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a));
}

function esAutomatica(t: Transmision): boolean {
  return t === "AT" || t === "CVT";
}

function puntuar(pedido: Rasgos, candidato: Rasgos) {
  let score = 0;
  const coincidencias: string[] = [];
  const faltantes: string[] = [];

  if (pedido.cilindrada) {
    if (!candidato.cilindrada) {
      score += PESOS.cilindradaAusente;
      faltantes.push(pedido.cilindrada);
    } else if (candidato.cilindrada === pedido.cilindrada) {
      score += PESOS.cilindradaIgual;
      coincidencias.push(pedido.cilindrada);
    } else {
      score += PESOS.cilindradaDistinta;
      faltantes.push(`${pedido.cilindrada} (es ${candidato.cilindrada})`);
    }
  }

  if (pedido.transmision) {
    if (!candidato.transmision) {
      score += PESOS.transmisionAusente;
      faltantes.push(pedido.transmision);
    } else if (candidato.transmision === pedido.transmision) {
      score += PESOS.transmisionIgual;
      coincidencias.push(pedido.transmision);
    } else if (esAutomatica(pedido.transmision) && esAutomatica(candidato.transmision)) {
      score += PESOS.transmisionParcial;
      coincidencias.push(candidato.transmision);
    } else {
      score += PESOS.transmisionDistinta;
      faltantes.push(`${pedido.transmision} (es ${candidato.transmision})`);
    }
  }

  if (pedido.turbo && candidato.turbo) {
    score += PESOS.turboIgual;
    coincidencias.push("TURBO");
  } else if (pedido.turbo) {
    score += PESOS.turboFaltante;
    faltantes.push("TURBO");
  } else if (candidato.turbo) {
    score += PESOS.turboSobrante;
  }

  const sobrantes = new Set(candidato.palabras);
  for (const palabra of pedido.palabras) {
    if (sobrantes.delete(palabra)) {
      score += PESOS.palabraIgual;
      coincidencias.push(palabra);
      continue;
    }
    const parcial = [...sobrantes].find((otra) => esLaMismaPalabra(palabra, otra));
    if (parcial) {
      sobrantes.delete(parcial);
      score += PESOS.palabraParcial;
      coincidencias.push(parcial);
      continue;
    }
    score += PESOS.palabraFaltante;
    faltantes.push(palabra);
  }
  score += sobrantes.size * PESOS.palabraSobrante;

  return { score, coincidencias, faltantes };
}

/** Lo que se busca: marca + modelo + version, todo junto y en texto libre. */
export function textoBuscado(vehiculo: VehiculoInput): string {
  return [vehiculo.marca, vehiculo.modelo, vehiculo.version].filter(Boolean).join(" ").trim();
}

/**
 * Consultas para `/Combo/GetVehiculos`, de mas amplia a mas especifica.
 *
 * Hacen falta las dos. La amplia (marca + nombre del modelo, cortando en el
 * primer token de version) es la que da recall, pero ABSA corta el combo (35
 * items en la captura real, mezclando ademas otros modelos que matchean por
 * substring), asi que si el modelo tiene muchas versiones la correcta puede
 * quedar afuera. La refinada agrega los terminos de version: el buscador de
 * ABSA es un AND de substrings sobre la descripcion, asi que
 * "TRACKER 1.2 TURBO AT PREMIER" matchea "TRACKER 1.2 TURBO AT6 PREMIER" y la
 * trae aunque la amplia la haya dejado afuera. Si la refinada no matchea nada
 * no pasa nada: los resultados se unen, no se filtran.
 */
export function consultasDeBusqueda(vehiculo: VehiculoInput): string[] {
  const marca = normalizarDescripcion(vehiculo.marca);
  const modelo = sinRuidoDeConsulta(normalizarDescripcion(vehiculo.modelo));
  const version = sinRuidoDeConsulta(normalizarDescripcion(vehiculo.version ?? ""));

  const tokens = modelo.split(" ").filter(Boolean);
  const corte = tokens.findIndex(esTokenDeVersion);
  const modeloBase = (corte <= 0 ? tokens : tokens.slice(0, corte)).join(" ");

  const amplia = `${marca} ${modeloBase}`.replace(/\s+/g, " ").trim();
  const refinada = `${marca} ${modelo} ${version}`.replace(/\s+/g, " ").trim();
  return refinada === amplia ? [amplia] : [amplia, refinada];
}

/**
 * Palabras que el formulario escribe y ABSA no tiene en NINGUNA descripcion.
 * Como `/Combo/GetVehiculos` es un AND de substrings, una sola de estas vuelve
 * la consulta vacia aunque el auto exista. Casos reales de produccion:
 *
 *   "RENAULT NUEVO MASTER" -> 0    "RENAULT MASTER"      -> 40
 *   "CHEVROLET AGILE LS 5P" -> 0   "CHEVROLET AGILE LS"  -> 3
 *
 * Solo se sacan de la CONSULTA. El texto pedido completo se sigue usando para
 * puntuar (`rankearCandidatos`), asi que no se pierde precision al elegir: lo
 * que aca sobra es lo que impide que ABSA devuelva candidatos.
 */
function sinRuidoDeConsulta(texto: string): string {
  return (
    texto
      // Puertas: el form manda "5P" o "SEDAN 5 PUERTAS", ABSA escribe "5 P.",
      // "3 PTAS" o directamente nada. Se saca el numero JUNTO con la palabra:
      // dejar el "5" suelto es igual de fatal para un AND de substrings.
      // El \d es de un solo digito para no comerse la cilindrada ("1.6 P...").
      .replace(/\b\d\s*(PUERTAS|PTAS|P)\b/g, " ")
      .replace(/\bNUEV[AO]\b/g, " ") // "NUEVO MASTER", "NUEVA SAVEIRO": marketing, ABSA no lo escribe
      .replace(/\bAM\d{2}\b/g, " ") // año de modelo ("AM18"), como el "L/21" que ya descarta normalizarDescripcion
      .replace(/\s+/g, " ")
      .trim()
  );
}

/**
 * Consultas de ultimo recurso, cuando las de `consultasDeBusqueda` no
 * devolvieron NADA y el lead se perderia como "catalogo no resuelto".
 *
 * Van de menos a mas amplia y terminan en la marca sola, que siempre trae algo
 * (CHEVROLET devuelve 535 items, CITROEN 352 — ABSA no corta esas listas). Con
 * eso el ranking local, que es puro y no cuesta requests, elige la version mas
 * parecida. Es preferible cotizar la version que mejor matchea —y dejar el
 * warning con el parecido— antes que no cotizar el lead.
 */
export function consultasDeRescate(vehiculo: VehiculoInput): string[] {
  const marca = normalizarDescripcion(vehiculo.marca);
  if (!marca) return [];

  const primero = tokensDeModelo(vehiculo).join(" ");
  const ya = new Set(consultasDeBusqueda(vehiculo));
  return [`${marca} ${primero}`.trim(), marca].filter((q, i, todas) => q && todas.indexOf(q) === i && !ya.has(q));
}

/**
 * Los tokens que identifican al MODELO, sin nada de version: "AGILE",
 * "MASTER", "C 3". Cuando el modelo arranca con una letra sola se lleva
 * tambien el numero, porque "C" solo no identifica nada (ver
 * normalizarDescripcion: ABSA escribe "C 3", "C 4 LOUNGE").
 */
export function tokensDeModelo(vehiculo: VehiculoInput): string[] {
  const tokens = sinRuidoDeConsulta(normalizarDescripcion(vehiculo.modelo)).split(" ").filter(Boolean);
  return tokens.slice(0, tokens[0] && /^[A-Z]$/.test(tokens[0]) ? 2 : 1);
}

/**
 * Si el candidato es del modelo que se pidio.
 *
 * Hace falta porque las consultas amplias (sobre todo el rescate por marca
 * sola) traen el catalogo entero de la marca, y el ranking por parecido puede
 * coronar a un pariente de OTRO modelo: caso real, para un "C3 VTI 115 FEEL"
 * ganaba un "C-ELYSEE VTI 115 FEEL" — comparte todo menos lo unico que no se
 * negocia. La regla del negocio es que marca, modelo y año tienen que ser
 * exactos y solo la version se elige por parecido, asi que el modelo se filtra
 * antes de rankear en vez de dejarlo competir por puntaje.
 *
 * Compara por TOKEN y no por substring a proposito: "ARGO" no puede matchear
 * "UNO CARGO" ni "DUCATO MAXICARGO", que es justo lo que ABSA cuela cuando
 * busca por substring.
 */
export function esDelModeloPedido(candidato: CandidatoCatalogo, vehiculo: VehiculoInput): boolean {
  const pedidos = tokensDeModelo(vehiculo);
  if (pedidos.length === 0) return true;
  const tokens = new Set(normalizarDescripcion(candidato.text).split(" "));
  return pedidos.every((t) => tokens.has(t));
}

/**
 * Si lo que se pidio dice algo de la version (cilindrada, transmision, turbo o
 * palabras mas alla del nombre del modelo). Cuando NO dice nada, cualquier
 * ranking seria puro ruido: no hay con que distinguir una 1.2 TURBO AT6 de una
 * 1.8 LTZ, y la eleccion es necesariamente arbitraria. Vale la pena saberlo
 * para no mostrar un porcentaje de parecido que no significa nada.
 */
export function hayVersionEnLaBusqueda(vehiculo: VehiculoInput): boolean {
  const pedido = extraerRasgos(textoBuscado(vehiculo));
  const soloMarcaYModelo = extraerRasgos(consultasDeBusqueda(vehiculo)[0]!);
  return (
    pedido.cilindrada !== undefined ||
    pedido.transmision !== undefined ||
    pedido.turbo ||
    pedido.palabras.length > soloMarcaYModelo.palabras.length
  );
}

/**
 * Ordena los candidatos del catalogo por parecido con lo pedido, del mas
 * parecido al menos. Empates: se respeta el orden en que los devolvio ABSA
 * (InfoAuto descendente = version mas nueva primero), que es el criterio que
 * habia antes y sigue siendo un desempate razonable.
 *
 * Si no se pidio ninguna version, no se ordena nada: quedan como los mando
 * ABSA y con `similitud` en 0, que es la forma honesta de decir "no habia con
 * que elegir" (ver `hayVersionEnLaBusqueda`).
 */
export function rankearCandidatos(candidatos: CandidatoCatalogo[], vehiculo: VehiculoInput): CandidatoPuntuado[] {
  if (!hayVersionEnLaBusqueda(vehiculo)) {
    return candidatos.map((c) => ({ ...c, score: 0, similitud: 0, coincidencias: [], faltantes: [] }));
  }

  const pedido = extraerRasgos(textoBuscado(vehiculo));
  // Techo de puntaje: lo que sacaria el candidato perfecto para ESTA busqueda.
  // Sin esto un "106" no dice nada; contra el techo se lee como "100% de lo pedido".
  const maximo = puntuar(pedido, pedido).score;

  return candidatos
    .map((candidato) => {
      const { score, coincidencias, faltantes } = puntuar(pedido, extraerRasgos(candidato.text));
      return {
        ...candidato,
        score,
        similitud: maximo > 0 ? Math.min(100, Math.max(0, Math.round((score / maximo) * 100))) : 0,
        coincidencias,
        faltantes,
      };
    })
    .sort(
      (a, b) => b.score - a.score || desvioDeLinea(a.text, vehiculo.anio) - desvioDeLinea(b.text, vehiculo.anio),
    );
}
