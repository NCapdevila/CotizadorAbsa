/**
 * Canario: chequea que la integracion con ABSA net siga viva.
 *
 * Pensado para correr solo (cron diario) y avisar por exit code. Verifica, en
 * este orden, las tres cosas que se rompen en la practica:
 *
 *   1. Las credenciales y el login (lo que fallo el 2026-08-24: la sesion
 *      guardada tapaba unas credenciales invalidas hasta que se limpio).
 *   2. Que el catalogo siga respondiendo JSON con la forma esperada.
 *   3. Que el matcher siga encontrando el vehiculo de referencia.
 *
 * NO cotiza a proposito: cotizar tarda 3-4 minutos, deja una cotizacion
 * registrada en la cuenta del broker y le mete carga a ABSA. Esto son cuatro
 * GETs de solo lectura y termina en segundos, asi que se puede correr seguido
 * sin ensuciar nada.
 *
 * Lo que NO cubre: el parseo de las propuestas (esa parte solo se ejercita
 * cotizando de verdad). Para eso, de vez en cuando:
 *   npm run cotizar -- --marca CHEVROLET --modelo TRACKER --version "1.2T AT PREMIER" \
 *     --anio 2021 --cp 1425 --sexo M --estadocivil 2 --nacimiento 1990-01-15 --sin-guardar
 */
import { config } from "./config.js";
import { logger } from "./logger.js";
import { SessionManager } from "./session/sessionManager.js";
import { SessionStore } from "./session/sessionStore.js";
import { HttpFormAuthStrategy } from "./session/authStrategies.js";
import { AbsaHttpVehicleCatalogResolver } from "./quote/absaCatalogClient.js";
import type { VehiculoInput } from "./quote/types.js";

/**
 * Vehiculo de referencia: tiene que existir en el catalogo de ABSA y matchear
 * con parecido alto. Si un dia deja de encontrarse, o es que ABSA cambio el
 * catalogo/el endpoint, o que el matcher se rompio — en los dos casos hay que
 * mirarlo.
 */
const VEHICULO_DE_REFERENCIA: VehiculoInput = {
  marca: "CHEVROLET",
  modelo: "TRACKER",
  version: "1.2T AT PREMIER",
  anio: 2021,
};

/** Debajo de esto, el matcher no esta encontrando lo que deberia. */
const SIMILITUD_MINIMA = 80;

async function main() {
  const inicio = Date.now();
  const sessionManager = new SessionManager({
    credentials: { user: config.ABSA_USER, password: config.ABSA_PASSWORD },
    authStrategy: new HttpFormAuthStrategy(),
    store: new SessionStore(config.ABSA_SESSION_STORE_PATH),
  });
  const resolver = new AbsaHttpVehicleCatalogResolver(sessionManager);

  // Se fuerza un login nuevo: reusar la sesion persistida haria que el canario
  // pase aunque las credenciales esten mal, que es justo lo que queremos
  // detectar.
  await sessionManager.invalidateAndRelogin();

  const candidatos = await resolver.listarVersiones(VEHICULO_DE_REFERENCIA);
  if (candidatos.length === 0) {
    throw new Error(
      `El catalogo de ABSA no devolvio ninguna version para "${VEHICULO_DE_REFERENCIA.marca} ${VEHICULO_DE_REFERENCIA.modelo}".`,
    );
  }

  const mejor = candidatos[0]!;
  if (mejor.similitud < SIMILITUD_MINIMA) {
    throw new Error(
      `La mejor coincidencia quedo en ${mejor.similitud}% (minimo ${SIMILITUD_MINIMA}%): "${mejor.text.trim()}". ` +
        "Puede haber cambiado el catalogo de ABSA o el matcher de versiones.",
    );
  }

  const anios = await resolver.aniosDisponibles(mejor.value);
  if (!anios.includes(String(VEHICULO_DE_REFERENCIA.anio))) {
    throw new Error(
      `"${mejor.text.trim()}" (infoAuto ${mejor.value}) ya no cotiza para ${VEHICULO_DE_REFERENCIA.anio}. ` +
        `Anios disponibles: ${anios.slice(0, 8).join(", ")}.`,
    );
  }

  logger.info(
    {
      ms: Date.now() - inicio,
      candidatos: candidatos.length,
      elegido: mejor.text.trim(),
      similitud: mejor.similitud,
      infoAuto: mejor.value,
    },
    "SMOKE TEST OK: login, catalogo y matcher de versiones responden",
  );
  console.log(`OK — ${mejor.text.trim()} (${mejor.similitud}%) en ${((Date.now() - inicio) / 1000).toFixed(1)}s`);
}

main().catch((err) => {
  logger.error({ err }, "SMOKE TEST FALLIDO: revisar la integracion con ABSA net");
  console.error(`FALLO: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
