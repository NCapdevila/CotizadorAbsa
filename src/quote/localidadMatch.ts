/**
 * Elegir la localidad correcta entre las que comparten un codigo postal.
 *
 * El problema real: un CP argentino cubre muchas localidades (el 1849 devuelve
 * varias, el 5000 devuelve 53) y ABSA las lista todas. Quedarse con la primera
 * —que es la primera alfabeticamente, no la mas probable— significa cotizar
 * "ARGUELLO (NORTE)" cuando el cliente vive en Claypole. La localidad entra en
 * el calculo de la prima, asi que no es un detalle cosmetico: es la diferencia
 * entre una cotizacion util y una que despues no cierra.
 *
 * Por eso, cuando el formulario manda la localidad, se elige la MAS PARECIDA
 * en vez de la primera. Si no la manda, o si no se parece a ninguna, se cae a
 * la primera y se avisa, que es el comportamiento de antes.
 *
 * Modulo puro (no toca la red) a proposito, igual que ./vehicleVersionMatch.ts:
 * es la parte que conviene testear contra los textos reales del combo sin
 * depender de una sesion de ABSA.
 *
 * NOTA: no se reusa ./productorMatch.ts aunque el problema se parezca. Ese
 * descarta palabras de ruido societario ("DE", "DEL", "LA", "LOS"), que en
 * razones sociales sobran pero en nombres de localidad son el nombre:
 * "LA PLATA", "DEL VISO", "LOS POLVORINES".
 */

/** Item crudo del combo de ABSA: `text` = "(1849) CLAYPOLE (Buenos Aires)". */
export interface CandidatoLocalidad {
  value: string;
  text: string;
}

export interface LocalidadPuntuada extends CandidatoLocalidad {
  /** Puntaje crudo, para ordenar. */
  score: number;
  /** Cuanto de lo pedido aparece en el candidato, 0..100. Es lo que se muestra. */
  similitud: number;
  /** El nombre limpio, sin el CP ni la provincia. */
  nombre: string;
}

const DIACRITICOS = new RegExp(`[${String.fromCharCode(0x300)}-${String.fromCharCode(0x36f)}]`, "g");

/**
 * El nombre de la localidad, sin el `(1849)` del principio ni el
 * `(Buenos Aires)` del final con que ABSA arma el texto del combo.
 *
 * Los parentesis del medio SI se dejan: son parte del nombre en varios casos
 * reales ("ARGUELLO (NORTE)", "CAPITAL FEDERAL").
 */
export function nombreDeLocalidad(text: string): string {
  return text
    .replace(/^\s*\(\s*\w+\s*\)\s*/, "")
    .replace(/\s*\([^()]*\)\s*$/, "")
    .trim();
}

/** Forma canonica para comparar: sin acentos, en mayusculas y sin puntuacion. */
export function normalizarLocalidad(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(DIACRITICOS, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function palabras(texto: string): string[] {
  return normalizarLocalidad(texto).split(" ").filter(Boolean);
}

/** ABSA abrevia y trunca ("BRIO" por "BARRIO", "CLAYPOL"): un prefijo largo alcanza. */
function esLaMismaPalabra(a: string, b: string): boolean {
  return a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a));
}

const PESOS = {
  palabraIgual: 10,
  palabraParcial: 6,
  palabraFaltante: -10,
  /** Penalidad chica por palabra de mas: entre dos que matchean todo, gana la mas ajustada ("CLAYPOLE" antes que "CLAYPOLE NORTE"). */
  palabraSobrante: -1,
} as const;

/**
 * Ordena las localidades del combo por parecido con la que se pidio, de mas a
 * menos. Sin localidad pedida devuelve el orden original de ABSA con
 * `similitud` en 0, que es la forma honesta de decir "no habia con que elegir".
 */
export function rankearLocalidades(candidatos: CandidatoLocalidad[], pedida: string | undefined): LocalidadPuntuada[] {
  const buscadas = palabras(pedida ?? "");
  if (buscadas.length === 0) {
    return candidatos.map((c) => ({ ...c, score: 0, similitud: 0, nombre: nombreDeLocalidad(c.text) }));
  }

  return candidatos
    .map((candidato) => {
      const nombre = nombreDeLocalidad(candidato.text);
      const sobrantes = new Set(palabras(nombre));
      let score = 0;
      let encontradas = 0;

      for (const palabra of buscadas) {
        if (sobrantes.delete(palabra)) {
          score += PESOS.palabraIgual;
          encontradas++;
          continue;
        }
        const parcial = [...sobrantes].find((otra) => esLaMismaPalabra(palabra, otra));
        if (parcial) {
          sobrantes.delete(parcial);
          score += PESOS.palabraParcial;
          encontradas++;
          continue;
        }
        score += PESOS.palabraFaltante;
      }
      score += sobrantes.size * PESOS.palabraSobrante;

      return {
        ...candidato,
        nombre,
        score,
        similitud: Math.round((encontradas / buscadas.length) * 100),
      };
    })
    .sort((a, b) => b.score - a.score);
}
