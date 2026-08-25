/**
 * Matching de productores contra el catalogo de ABSA net.
 *
 * El problema real: ABSA escribe los productores a su manera
 * ("ARDAMA 2020 S.A.", "1989 MOTORS, CONCESIONARIA", "WOSCOFF, GABRIEL") y el
 * formulario los va a mandar como los escriba el negocio ("Ardama",
 * "1989 Motors"). Nunca son iguales caracter por caracter.
 *
 * OJO con el alcance: en el flujo de cotizacion NO se elige productor por
 * parecido. La lista del formulario es cerrada y se mapea a mano a IDs de ABSA
 * en config/absa-productores.json (ver ./productoresConfig.ts) — cotizar con el
 * productor equivocado significa cotizar con OTRO acuerdo comercial, o sea
 * precios mal sin ningun error visible. Este modulo se usa para:
 *
 *   1. `npm run productores` — buscar en el catalogo real de ABSA para armar
 *      ese mapeo (ahi si, un humano mira los porcentajes y decide).
 *   2. El mensaje de error cuando el formulario manda un valor que no esta
 *      mapeado: "quisiste decir X?" en vez de un "no encontrado" pelado.
 *
 * Puro (no toca la red) a proposito, igual que ./vehicleVersionMatch.ts.
 */

/** Item crudo del combo de ABSA: `value` = id del productor, `text` = razon social. */
export interface CandidatoProductor {
  value: string;
  text: string;
}

export interface ProductorPuntuado extends CandidatoProductor {
  /** Puntaje crudo, con las penalidades. Sirve para ordenar, no para mostrar. */
  score: number;
  /**
   * Cuanto de lo pedido tiene el candidato, 0..100. Es cobertura pura: las
   * palabras que faltan valen cero, no restan, y las de mas no descuentan
   * (para eso esta `score`). Asi "ardama" contra "ARDAMA 2020 S.A." da 100 y
   * no un 80 que parece dudoso cuando es obviamente el mismo.
   */
  similitud: number;
  /** Palabras pedidas que el candidato no tiene (para explicar por que perdio). */
  faltantes: string[];
}

const DIACRITICOS = new RegExp(`[${String.fromCharCode(0x300)}-${String.fromCharCode(0x36f)}]`, "g");

/**
 * Formas societarias y descriptores que ABSA agrega y el formulario no
 * escribe. Sacarlos evita que "ARDAMA" contra "ARDAMA 2020 S.A." pierda
 * puntos por dos palabras que no aportan nada a la identidad.
 *
 * "CONCESIONARIA" entra en la lista porque ABSA se lo pone a casi todas las
 * concesionarias ("1989 MOTORS, CONCESIONARIA"): si contara, todas se
 * parecerian un poco entre si y los porcentajes dejarian de discriminar.
 */
const RUIDO = new Set([
  "SA", "S.A", "SRL", "S.R.L", "SAS", "S.A.S", "SH", "S.H", "SCA", "SC",
  "SOCIEDAD", "ANONIMA", "LTDA", "CIA", "COMPANIA", "Y", "DE", "DEL", "LA", "EL", "LOS", "LAS",
  "CONCESIONARIA", "CONCESIONARIO",
]);

const PESOS = {
  palabraIgual: 10,
  /** Prefijo compartido: "AUTOMOTOR" vs "AUTOMOTORES", o una razon social truncada. */
  palabraParcial: 6,
  palabraFaltante: -12,
  /** Penalidad chica por palabra de mas: entre dos que matchean todo, gana el nombre mas ajustado. */
  palabraSobrante: -2,
} as const;

/**
 * Deja el texto en la forma canonica con la que se comparan pedido y catalogo.
 * La coma es significativa en ABSA ("WOSCOFF, GABRIEL" = apellido, nombre)
 * pero solo como separador: para comparar da igual el orden, asi que se trata
 * como un espacio mas.
 */
export function normalizarProductor(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(DIACRITICOS, "")
    .toUpperCase()
    .replace(/[^A-Z0-9.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Palabras significativas del nombre, sin formas societarias ni repetidos. */
export function palabrasDeProductor(texto: string): string[] {
  const vistas = new Set<string>();
  const palabras: string[] = [];
  for (const crudo of normalizarProductor(texto).split(" ")) {
    const token = crudo.replace(/\.+$/g, "");
    if (!token || RUIDO.has(token)) continue;
    if (vistas.has(token)) continue;
    vistas.add(token);
    palabras.push(token);
  }
  return palabras;
}

/** Razones sociales truncadas o con plural: "AUTOMOTOR" vs "AUTOMOTORES". */
function esLaMismaPalabra(a: string, b: string): boolean {
  return a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a));
}

function puntuar(pedido: string[], candidato: string[]) {
  let cubierto = 0;
  let penalidad = 0;
  const faltantes: string[] = [];
  const sobrantes = new Set(candidato);

  for (const palabra of pedido) {
    if (sobrantes.delete(palabra)) {
      cubierto += PESOS.palabraIgual;
      continue;
    }
    const parcial = [...sobrantes].find((otra) => esLaMismaPalabra(palabra, otra));
    if (parcial) {
      sobrantes.delete(parcial);
      cubierto += PESOS.palabraParcial;
      continue;
    }
    penalidad += PESOS.palabraFaltante;
    faltantes.push(palabra);
  }
  penalidad += sobrantes.size * PESOS.palabraSobrante;

  const total = pedido.length * PESOS.palabraIgual;
  return { score: cubierto + penalidad, cobertura: total > 0 ? cubierto / total : 0, faltantes };
}

/**
 * Ordena los candidatos por parecido con lo pedido, del mas parecido al menos.
 * Empates: se respeta el orden en que los devolvio ABSA.
 */
export function rankearProductores(candidatos: CandidatoProductor[], consulta: string): ProductorPuntuado[] {
  const pedido = palabrasDeProductor(consulta);

  return candidatos
    .map((candidato) => {
      const { score, cobertura, faltantes } = puntuar(pedido, palabrasDeProductor(candidato.text));
      return { ...candidato, score, similitud: Math.round(cobertura * 100), faltantes };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * Consultas para `/Combo/GetProductoresIncremental`, de mas especifica a menos.
 *
 * El buscador de ABSA matchea por substring sobre la razon social, asi que una
 * consulta de varias palabras es fragil: "WOSCOFF GABRIEL" NO matchea
 * "WOSCOFF, GABRIEL" (esta la coma en el medio) y "AUTOS XANGO" no matchea
 * "XANGO AUTOS". Por eso, si el nombre entero no trae nada, se prueba palabra
 * por palabra empezando por la mas larga, que es casi siempre la mas
 * distintiva ("CONCESIONARIA" y las formas societarias ya salieron en
 * `palabrasDeProductor`).
 *
 * El ranking despues se hace localmente contra el nombre COMPLETO, asi que una
 * consulta amplia no ensucia: solo agrega candidatos para puntuar.
 */
export function consultasDeProductor(nombre: string, maximo = 3): string[] {
  const palabras = palabrasDeProductor(nombre);
  if (palabras.length === 0) return [];

  const porLargo = [...palabras].sort((a, b) => b.length - a.length);
  const consultas = [palabras.join(" "), ...porLargo];

  // El select2 de ABSA no busca con menos de 3 caracteres; abajo de eso el
  // endpoint devuelve vacio y la request se desperdicia.
  return [...new Set(consultas)].filter((c) => c.length >= 3).slice(0, maximo);
}
