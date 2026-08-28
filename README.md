# absa-cotizador

Cliente **no oficial** para cotizar en [ABSA net](https://www.absanet.net) de
forma programática, reutilizando la sesión autenticada de un broker real.
Pensado para que el agente de Ninjo pueda pedir cotizaciones sin saber nada
de cookies, tokens, ni del formato interno del sitio de ABSA.

## Qué es esto (y qué no es)

ABSA net no expone una API pública. Esta integración funciona haciendo login
programático contra el sitio web, capturando la cookie/token de sesión que
entrega, y reutilizando esa sesión para invocar los mismos endpoints internos
que usa el frontend cuando arma una cotización (ingeniería inversa de
tráfico web autenticado).

Esto es **frágil por diseño**: cualquier cambio en el frontend de ABSA net
(nuevos campos, tokens CSRF que roten, cambios de endpoint, un rediseño)
puede romper la integración sin aviso previo. No es una API soportada por
ABSA ni tiene ningún SLA. Ver [Seguridad y cumplimiento](#seguridad-y-cumplimiento-antes-de-producción)
antes de llevar esto a producción.

## Stack elegido y por qué

**Node.js + TypeScript.**

- Se prevé exponer `cotizar()` como un microservicio HTTP liviano que el
  agente de Ninjo consuma (Fase 3) — Node es una opción natural para eso, sin
  el overhead de un framework web más pesado.
- **Playwright** es imprescindible para la Fase 0 (grabar HAR de una sesión
  real) y como fallback de login si resulta que ABSA net depende de JS
  pesado / 2FA / captcha para autenticar. Playwright tiene soporte de
  primera clase en TS/Node.
- **`got` + `tough-cookie`** dan un cliente HTTP con cookie jar persistente
  de forma nativa (`got` acepta un `CookieJar` de `tough-cookie` directo),
  que es exactamente lo que hace falta para "loguearse una vez, reusar la
  sesión en n requests".
- **Express** para el endpoint HTTP (Fase 3), **Vitest + nock** para tests
  con HTTP mockeado (Fase 6), **pino** para logging estructurado con
  redacción de campos sensibles (Fase 4), **zod** para validar env vars y el
  input del endpoint, **pdfkit** para generar el PDF comparativo que se
  adjunta al Deal de HubSpot (Fase 6).

Si en algún momento se prefiere correr esto como job/cron en vez de
servicio long-running, la lógica de `src/session` y `src/quote` es
igual de usable desde un script one-shot (`import { cotizar } from "./src/index.js"`)
— no depende de que el servidor Express esté levantado.

## Estado del proyecto

| Fase | Estado |
|---|---|
| 0 — Descubrimiento | **Cerrado con datos reales** (ver `docs/absa-endpoints.md`): login, catálogo de vehículos, creación de la cotización (`id_Entity`), guardado, impresión en PDF y URL de recotización, todo confirmado contra capturas con contenido y verificado en producción. Sigue pendiente lo menor: nombre exacto de la cookie y duración real de la sesión (sección 5). |
| 1 — Session Manager | Login **confirmado y real**: `GET /` (saca el token anti-forgery) → `POST /` con `Mail`/`Password`/`__RequestVerificationToken` → redirect a `/Home/Index` si funciona. `PlaywrightAuthStrategy` queda como fallback con los mismos selectores reales, por si aparece un challenge anti-bot que la estrategia HTTP no pueda resolver. |
| 2 — Quote Client | Implementado y **validado en producción**: `GET /AutoCotizador/Cotizar/{id}` (token CSRF) → `POST /AutoCotizador/Cotizar/{id}?Length=n` → `POST /CotizadorPropuesta/CotizarPropuesta/` una vez por aseguradora. El parser está probado contra HTML real (una corrida devolvió 69 opciones de 6 aseguradoras). Incluye elección de versión por parecido (`vehicleVersionMatch.ts`), guardado de la cotización y descarga del PDF de ABSA. |
| 3 — Interfaz | El servicio expone **solo** `GET /health` y `POST /webhooks/hubspot/absa`: el formulario es el único consumidor. Para cotizar a mano está el CLI (`npm run cotizar`), y `cotizar()` sigue siendo importable como librería. |
| 4 — Resiliencia | Logging estructurado, smoke test, alerta simple por tasa de error. |
| 5 — Seguridad/cumplimiento | Checklist abajo, sin resolver — **acción humana requerida**. |
| 6 — Integración HubSpot | **Probada end-to-end contra un Deal real**: webhook (`POST /webhooks/hubspot/absa`, con un `dealId` que ya creó el formulario) → cola en archivo → worker asíncrono → resuelve el vehículo contra el catálogo de ABSA → cotiza → guarda la cotización en ABSA → escribe el **Deal existente** (`absa_estado`, `absa_numero_cotizacion`, `absa_error_mensajes`, `cotizacion_absa`). El PDF adjunto existe pero está **apagado** (`HUBSPOT_ADJUNTAR_PDF=false`). Nunca crea Deals ni Contacts. Ver `docs/hubspot-integration.md`. |

**En criollo:** el pipeline está armado contra la forma **real** que
descubrimos del sitio (no son placeholders inventados): ABSA net es una app
ASP.NET MVC clásica, no una API JSON — cada cotización requiere sacar un
token anti-forgery de una página, mandar un form gigante (~140 campos, la
mayoría configuración comercial de cuenta del broker, no del cliente) y
después una request por aseguradora que devuelve HTML. Los tres gaps que
quedaban de la Fase 0 (login, catálogo de vehículos y muestras de HTML con
contenido) están cerrados y verificados contra producción; lo que sigue
abierto es menor y está en `docs/absa-endpoints.md` sección 7.

Lo que **no** arregla ninguna arquitectura: esto vive sobre una superficie no
oficial y se va a romper el día que ABSA cambie el frontend. Por eso el
`npm run smoke-test` conviene dejarlo corriendo a diario: es la diferencia
entre enterarte por un monitor o por un lead que no cotizó.

### Config comercial (`config/absa-comercial.json`)

Los ~30 campos de "rebaja/cláusula/tipo de póliza por aseguradora" que
ABSA net espera en cada cotización son **configuración de cuenta del
broker** (su acuerdo comercial con cada aseguradora), no datos de la
cotización individual. Viven separados de `CotizacionInput` en
`config/absa-comercial.json` (gitignored — se genera con
`npm run discovery:comercial`, ver "Archivos de config" más abajo y
`docs/absa-endpoints.md` sección 3).

## Setup

```bash
npm install
# crear .env con al menos ABSA_USER y ABSA_PASSWORD (tabla completa abajo)
```

### Variables de entorno

| Variable | Requerida | Default | Descripción |
|---|---|---|---|
| `ABSA_USER` | sí | — | Usuario de broker en ABSA net |
| `ABSA_PASSWORD` | sí | — | Contraseña. Nunca se loguea ni se commitea. |
| `ABSA_BASE_URL` | no | `https://www.absanet.net` | Base URL del sitio |
| `ABSA_SESSION_STORE_PATH` | no | `.session/absa-session.json` | Dónde persistir la sesión entre corridas |
| `PORT` | no | `3000` | Puerto del endpoint HTTP (Fase 3) |
| `LOG_LEVEL` | no | `info` | Nivel de log de pino |
| `ABSA_MIN_REQUEST_INTERVAL_MS` | no | `1500` | Piso de tiempo entre requests salientes a ABSA (rate limit conservador) |
| `ABSA_MAX_RETRIES` | no | `1` | Reintentos ante error transitorio |
| `ABSA_COMERCIAL_TEMPLATE_PATH` | no | `config/absa-comercial.json` | Config comercial de cuenta (rebajas/comisiones por aseguradora), ver sección abajo |
| `ABSA_PRODUCTORES_PATH` | no | `config/absa-productores.json` | Mapeo de la lista de productores del formulario a IDs de ABSA, ver sección abajo. Si no existe, todo cotiza con el productor de la plantilla comercial |
| `ABSA_CONFIG_COMERCIAL_TTL_MS` | no | `21600000` (6h) | Cuánto se cachea la config comercial que ABSA devuelve por productor (son 3 requests por productor) |
| `ABSA_ASEGURADORAS_EXCLUIDAS` | no | *(vacío)* | Aseguradoras a NO cotizar, por nombre o id, separadas por coma (ej. `SANCOR`) |
| `ABSA_PROXY_URL` | no | *(vacío)* | Proxy por el que sale el tráfico a ABSA (ej. `socks5://127.0.0.1:1080`), para cuando la IP del servidor no está habilitada. Vacío = directo. Ver `docs/deploy.md` |
| `HUBSPOT_ACCESS_TOKEN` | no | *(vacío)* | Token de la Private App. **Vacío = integración HubSpot apagada** (no se monta el webhook) |
| `HUBSPOT_WEBHOOK_SECRET` | no | *(vacío)* | Secreto compartido que valida el header `x-webhook-secret` del webhook |
| `HUBSPOT_API_BASE_URL` | no | `https://api.hubapi.com` | Base URL de la API de HubSpot |
| `HUBSPOT_PROPERTIES_PATH` | no | `config/hubspot-properties.json` | Mapeo de propiedades custom del Deal, ver sección abajo |
| `HUBSPOT_ADJUNTAR_PDF` | no | `false` | `true`/`false`. Adjuntar el PDF de la cotización al Deal (hoy apagado, ver `docs/hubspot-integration.md`) |
| `QUEUE_STORE_PATH` | no | `.queue/leads.json` | Cola de leads pendientes (contiene PII — gitignored) |
| `QUEUE_POLL_INTERVAL_MS` | no | `15000` | Cada cuánto el worker busca trabajo |
| `QUEUE_MAX_ATTEMPTS` | no | `3` | Reintentos por lead antes de marcarlo fallido |
| `HUBSPOT_BARRIDO` | no | `true` | `true`/`false`. Barrido de rescate: busca en HubSpot Deals sin cotizar y los encola, para los leads cuyo webhook nunca llegó. Prendido de fábrica — ponelo en `false` solo para apagarlo a propósito |
| `HUBSPOT_BARRIDO_SIMULACRO` | no | `false` | `true`/`false`. Loguea qué encolaría y no encola nada. **Usalo en la primera pasada** |
| `HUBSPOT_BARRIDO_INTERVAL_MS` | no | `600000` | Cada cuánto barre (10 min) |
| `HUBSPOT_BARRIDO_HORAS` | no | `24` | Cuántas horas hacia atrás mira. Evita despertar leads viejos: hay ~32.000 Deals sin cotizar en el portal |
| `HUBSPOT_BARRIDO_SOLO_HOY` | no | `true` | `true`/`false`. Además de las horas, no pasar del comienzo del día de hoy: **de ayer para atrás no se toca** |
| `HUBSPOT_BARRIDO_ZONA` | no | `America/Argentina/Buenos_Aires` | Con qué zona horaria se decide dónde empieza "hoy" |
| `HUBSPOT_BARRIDO_MAX` | no | `25` | Tope de Deals por pasada |
| `HUBSPOT_BARRIDO_TIPO_RIESGO` | no | `AUTO` | Qué `tipo_riesgo` levanta. Este servicio solo cotiza autos; las MOTO se dejan afuera. Vacío = cualquiera |

### Archivos de config (no están en el repo)

Ninguno de los dos se versiona: tienen la config comercial del broker y el
mapeo del portal de HubSpot. Al montar un servidor nuevo hay que copiarlos
desde una máquina que ya los tenga, o regenerarlos:

**`config/absa-comercial.json`** — se genera solo con
`npm run discovery:comercial` a partir de un HAR de una cotización real
(descarta la PII de la captura y deja solo la config de cuenta). Forma:

```json
{
  "idOrganizador": 0, "idUsuario": 0, "idProductor": 0, "idConfiguracion": 0,
  "comision": 0, "idTipoPago": 3,
  "aseguradoras": [{ "id": 97, "nombre": "EXPERTA SEGUROS (P)" }],
  "camposPorAseguradora": { "Poliza.id_TipoPolizaZurich": 3, "Comercial.RebajaZurich": 30 }
}
```

**`config/absa-productores.json`** — mapea cada opción de la lista (cerrada) de
productores del formulario a su `id_Productor` real de ABSA. Se genera de una
con `npm run productores -- --mapear <lista>` y se chequea contra ABSA con
`npm run productores -- --verificar`. Es **opcional**: sin él, todo cotiza con
el productor de `config/absa-comercial.json`. Forma:

```json
{
  "defecto": "ardama",
  "productores": {
    "ardama": {
      "idProductor": 6856,
      "nombre": "ARDAMA 2020 S.A.",
      "idConfiguracion": 3345,
      "alias": ["ARDAMA 2020 S.A."]
    }
  }
}
```

Ver "Cotizar con el productor del formulario" más abajo para qué es cada campo.

**`config/hubspot-properties.json`** — a mano, con los nombres internos de las
propiedades custom que creaste en tu portal. **Lo que no esté acá no se
escribe**, así que alcanza con mapear las que existen (ver
`docs/hubspot-integration.md` sección 1.2):

```json
{
  "properties": {
    "estado": "absa_estado",
    "numeroCotizacion": "absa_numero_cotizacion",
    "errorMensaje": "absa_error_mensajes",
    "cotizacionUrl": "cotizacion_absa"
  }
}
```

## Fase 0 — Descubrimiento

```bash
npm run discovery:capture   # abre browser visible, hacé login + una cotización a mano, ENTER al terminar
npm run discovery:parse     # parsea el .har mas reciente -> docs/absa-endpoints.generated.md
npm run discovery:comercial # extrae config/absa-comercial.json del .har (valores reales de la cuenta)
```

El `.har` queda en `discovery/output/` (gitignored: **contiene credenciales
y cookies de sesión reales en texto plano**, nunca se commitea). El parser
redacta valores sensibles antes de escribir `docs/absa-endpoints.md`, pero
igual **revisar a mano** antes de compartir ese doc — las heurísticas de
detección de endpoints pueden traer falsos positivos.

Después de correr esto, hay que llevar lo aprendido a:

- `src/session/authStrategies.ts` — URL/campos reales de login (o el flujo de Playwright, si el login no es un POST simple)
- `src/quote/mapper.ts` — payload real que espera el endpoint de cotización, y forma real de la respuesta
- `src/quote/quoteClient.ts` — `QUOTE_PATH` y el patrón exacto de "sesión vencida" si no es un 401/403 simple

## Uso como librería (Fase 3, modo función)

```ts
import { cotizar } from "absa-cotizador";

const resultado = await cotizar({
  ramo: "automotor",
  asegurado: {
    nombre: "Juan",
    apellido: "Pérez",
    documentoTipo: "DNI",
    documentoNumero: "30123456",
  },
  objetoAsegurado: {
    tipo: "vehiculo",
    vehiculo: { marca: "Ford", modelo: "Fiesta", anio: 2020, usoTipo: "particular" },
  },
  cobertura: { tipo: "terceros completo" },
});

console.log(resultado.opciones); // [{ plan, premio, moneda, cobertura, ... }]
```

`cotizar()` maneja login, renovación de sesión y reintentos internamente.
El agente de Ninjo solo ve `CotizacionInput` / `CotizacionResult`
(`src/quote/types.ts`) — nunca cookies, tokens, ni el payload real de ABSA.

## El servicio HTTP

```bash
npm run dev:api     # local, recarga al tocar codigo
npm run build && npm run start:api   # produccion (compila src -> dist/api/server.js)
```

Expone dos rutas y nada mas:

| Ruta | Para que |
|---|---|
| `GET /health` | Chequeo de vida (nginx, monitoreo) |
| `POST /webhooks/hubspot/absa` | Recibe un Deal ya creado y encola su cotizacion. Header `x-webhook-secret`. |

El webhook responde `202` al instante; el resultado se escribe en el Deal 3-4
minutos despues (ver `docs/hubspot-integration.md`). Para cotizar a mano no
hace falta el servidor: esta el CLI.

Hay una coleccion de Postman lista en
`postman/absa-cotizador.postman_collection.json` (Import → File).

## Cotizar desde la terminal

```bash
npm run cotizar -- --marca CHEVROLET --modelo TRACKER --version "1.2 TURBO AT PREMIER" \
  --anio 2021 --cp 1425 --sexo M --estadocivil 2 --nacimiento 1990-01-15
```

Le pega a ABSA net **real** y deja la cotización guardada en la cuenta, que es
lo que después permite abrirla desde el listado (`--sin-guardar` para no
guardarla). Al terminar imprime los premios agrupados por aseguradora y el link
para abrir la cotización en ABSA. No escribe archivos.

ABSA exige **sexo, estado civil y fecha de nacimiento** (los valida del lado
del servidor). El **documento no**: `--dni` es opcional y solo sirve para que
la cotización quede identificada en el listado de ABSA.

**La provincia no se manda**: sale del código postal, igual que en el portal
(que la completa en un hidden al elegir la localidad). Lo que sí conviene mandar
es `--localidad`: un CP cubre muchas —el 1849 devuelve 11— y ABSA las lista
alfabéticamente, así que sin el nombre se cotiza con "BRIO DON ORIONE" cuando el
cliente vive en Claypole. La localidad entra en la prima.

### Elegir la versión correcta

ABSA tiene muchas versiones del mismo modelo/año y las escribe a su manera
(`TRACKER 1.2 TURBO AT6 PREMIER`), distinto a la cédula (`TRACKER 1.2T AT
PREMIER`). Pasando `--version` (o escribiendo todo junto en `--modelo`) el
resolver elige la **más parecida**, no la primera de la lista, e informa con
qué parecido quedó y qué otras versiones había:

```
      -> CHEVROLET - TRACKER 1.2 TURBO PREMIER AT6   [100% de parecido a lo pedido]
      -> otras versiones del catalogo (para clavar otra: --infoauto <codigo>):
          79%  120588   CHEVROLET - CHEVROLET - TRACKER 1.2 TURBO AT6
```

Para ver la lista completa del catálogo antes de cotizar (solo lectura, no
crea ninguna cotización). Con `--anio` chequea además cuáles cotizan para ese
año, que es lo que distingue las líneas (`L/22`, `L/25`) de la misma versión:

```bash
npm run versiones -- --marca CHEVROLET --modelo TRACKER 1.2T AT PREMIER --anio 2021
```

```
PARECIDO  INFOAUTO   2021   VERSION EN ABSA
    100%  120586     si     CHEVROLET - CHEVROLET - TRACKER 1.2 TURBO PREMIER AT6
    100%  120620     NO     CHEVROLET - CHEVROLET - TRACKER 1.2 TURBO PREMIER AT6 L/22
     79%  120588     si     CHEVROLET - CHEVROLET - TRACKER 1.2 TURBO AT6   (le falta: PREMIER)
```

y después cotizar esa versión exacta con `--infoauto <código>`, que saltea la
búsqueda. Sin `--version` no hay con qué elegir: se toma la primera del
catálogo y se avisa (puede no ser la del cliente). Lo mismo aplica al
pipeline de HubSpot, que usa la propiedad `version_vehiculo` del formulario.

## Cotizar con el productor del formulario

Cada cotización se hace **con el acuerdo comercial de un productor** (la
concesionaria o el vendedor): eso define las rebajas, la comisión y qué
aseguradoras cotizan. Antes había uno solo y fijo, el de
`config/absa-comercial.json` (ARDAMA). Ahora el formulario puede mandar cuál.

### Cómo funciona

El formulario manda su valor (`productor` en el payload del webhook, o
`--productor` en el CLI) y el backend lo traduce a un `id_Productor` de ABSA
con `config/absa-productores.json`. **La traducción es un mapeo a mano y el
match es exacto**, a propósito: elegir "el más parecido" cuando las dos listas
no coinciden es como se termina cotizando con el acuerdo comercial del de al
lado, sin ningún síntoma visible.

**Lo que no está mapeado cotiza con el productor `defecto` (hoy ARDAMA)**, no
falla. Vale también si el formulario no manda el campo. Es una decisión de
negocio: entre no atender el lead y cotizarlo con la cuenta general, se prefiere
lo segundo — la cotización queda igual guardada en ABSA para que la levante un
vendedor. En el log queda un `warn` con el valor que no matcheó y los parecidos
del mapeo, que es lo que hace falta para completarlo después.

Con el productor resuelto, se le pide a ABSA la config comercial de **ese**
productor —las mismas tres llamadas que hace el portal cuando alguien cambia el
combo, ver `docs/absa-endpoints.md` sección 3.3— y de ahí sale lo que **sí**
cambia por productor: la configuración/tarifa (`id_Configuracion`), la comisión
y qué aseguradoras tiene habilitadas. Se cachea 6h por productor
(`ABSA_CONFIG_COMERCIAL_TTL_MS`).

Las **condiciones comerciales** (rebajas, cláusulas de ajuste, tipo de póliza,
planes) NO salen de ahí: son las mismas para todos los productores del broker y
se toman de `config/absa-comercial.json`. Ver "Las rebajas" abajo.

Un atajo que evita trabajo: si el productor resuelto es el mismo de
`config/absa-comercial.json` (hoy ARDAMA), se usa el archivo tal cual y no se le
pide nada a ABSA. Es el caso de todo lead sin productor o con uno sin mapear.

### Armar el mapeo

```bash
npm run productores -- --mapear lista.txt    # mapea TODA la lista del formulario de una
npm run productores -- --buscar "xango"      # busca uno solo
npm run productores -- --id 9767             # que ofrece ese productor
npm run productores -- --id 9767 --campos    # + los 44 campos comerciales y sus opciones
npm run productores -- --verificar           # chequea TODO el mapeo contra ABSA
```

**`--mapear`** es el camino para cargar la lista entera. Come dos formatos:

- **Texto**: un nombre por línea (se ignoran las vacías y las que arrancan con `#`).
- **JSON exportado de la planilla**: array de strings, o de objetos
  (`{"Productores": "...", "Activos": "SI"}`), incluso sin los corchetes de
  afuera, que es como los deja Google Sheets. Las filas marcadas como inactivas
  se saltean, y el mojibake típico de un export mal codificado
  (`BurgueÃ±O` → `BURGUEÑO`) se arregla al leer.

Escribe un borrador en `config/absa-productores.draft.json`. También acepta la
lista escrita a mano: `--nombres "Xango Autos, Abasto Motors"`.

```
  ESTADO  OPCION DEL FORMULARIO                  ID       PRODUCTOR EN ABSA
  YA     Ardama                                 6856     ARDAMA 2020 S.A.
  OK     Xango Autos                            9767     XANGO AUTOS, CONCESIONARIA (100%)
  OK     Woscoff Gabriel                        7616     WOSCOFF, GABRIEL (100%)
  FALTA  Concesionaria Que No Existe SRL        -        (nada parecido)
```

- `OK` (100%) se mapea solo; `MIRAR` se mapea pero hay que confirmarlo.
- `YA` = ya estaba en el mapeo: se copia tal cual, con los ajustes que le hayas
  hecho a mano.
- `FALTA` = **no se mapea**. Queda en `_pendientes` con los candidatos, para
  resolverlo a ojo. Debajo del 70% de parecido, o con empate entre dos
  candidatos, no se elige solo: un id equivocado no falla, cotiza con el
  acuerdo de otro.

`_comentario` y `_pendientes` los ignora el loader, así que el borrador se puede
renombrar a `config/absa-productores.json` y usar aunque queden pendientes.

Todos los modos son de **solo lectura**: no cotizan ni guardan nada.

**Una excepción, con `--mapear` y `--buscar`:** la lista completa de productores
sale del combo de la página del cotizador (1036 en esta cuenta), y abrir esa
página sin más **crea una cotización vacía** en la cuenta. Para evitarlo, pasar
el número de una cotización que ya exista:

```bash
npm run productores -- --mapear lista.txt --cotizacion 41322632
```

El combo se cachea 24h en `.session/`, así que en el peor caso pasa una vez por
día. Y no alcanza con la búsqueda incremental de ABSA: **se saltea productores
que existen** (`woscoff`, `ballesteros` y `yimi` no devuelven nada aunque están
en el combo). Se usa solo como respaldo.

### Las rebajas

`ObtenerConfigCotizador` devuelve los **defaults del formulario**, no lo que el
productor elige en la pantalla: las rebajas vienen en `0` junto con la lista de
las que ese acuerdo permite. Cotizar con el default es legítimo pero da primas
más caras que cotizando a mano.

Como el acuerdo comercial del broker es **uno solo para todos los productores**,
las condiciones salen de `config/absa-comercial.json` (los ~45 campos
`Comercial.*` / `Poliza.*` / `Item.RebajasComerciales[*]`, con las rebajas que
el negocio eligió a mano) y se aplican igual para cualquier productor. Verificado
sobre el terreno: los productores que miramos ofrecen exactamente las mismas
opciones de rebaja que ARDAMA.

Si alguna concesionaria alguna vez necesita condiciones distintas, la entrada
del mapeo acepta `campos`, que se pisan encima:

```json
"xango autos, concesionaria": {
  "idProductor": 9767,
  "nombre": "XANGO AUTOS, CONCESIONARIA",
  "campos": { "Comercial.RebajaZurich": 25 }
}
```

`npm run productores -- --id <id>` lista qué rebajas tiene ese productor y qué
valores acepta cada una. Un valor que ABSA no ofrece se manda igual (ABSA es la
autoridad final) pero queda avisado en el log y en `--verificar`.

El resto de la entrada, todo opcional: `idConfiguracion` o `configuracion` (solo
hacen falta si el productor tiene más de una tarifa; con una sola ABSA la elige
sola), `comision` (default: la que ABSA proponga), `alias` (otras formas en las
que el formulario puede escribir lo mismo) y `defecto` a nivel archivo (con qué
productor cotizar lo que no esté mapeado).

## Dejar de cotizar una aseguradora

```bash
# .env
ABSA_ASEGURADORAS_EXCLUIDAS=SANCOR
```

Se filtran al cargar la plantilla comercial: **no hay que tocar nada en ABSA
net**, la configuración del portal queda como está. Acepta varias separadas
por coma, por nombre (alcanza una parte: `GALICIA`) o por id (`21`). Si un
valor no matchea ninguna, se avisa por log — si no, el síntoma sería "sigue
cotizando la que quise sacar".

Va como env var y no editando `config/absa-comercial.json` porque ese archivo
se regenera con `npm run discovery:comercial` y la exclusión se perdería.

Tiempos medidos sobre dos capturas reales, por si hay que decidir a quién
sacar: SANCOR tarda **40-55s**, contra 5-17s de todas las demás — es ~30% del
tiempo total de una cotización.

## Deploy

Paso a paso para el VPS en [`docs/deploy.md`](docs/deploy.md): clonar, build,
`.env`, los dos JSON de config, pm2 y cómo verificar que el webhook quedó
realmente montado.

## Tests

```bash
npm test
```

Todos los tests usan HTTP mockeado con `nock` (`nock.disableNetConnect()`
está activo en `tests/setup.ts`) — **nunca** le pegan a ABSA net real, ni en
local ni en CI.

## Smoke test manual

```bash
npm run smoke-test
```

Corre una cotización de referencia contra ABSA net **real** (usando las
credenciales de `.env`) y devuelve exit code 0/1 según éxito/fallo, con un
log claro. Pensado para correrse periódicamente desde afuera (cron, un
scheduled job) como early-warning de que algo se rompió en ABSA net — este
script no se agenda solo.

Antes de depender de esto en serio: reemplazar `REFERENCE_INPUT` en
`src/smoke-test.ts` por un caso que se sepa estable (mismo criterio: si el
smoke test falla, tiene que ser porque la integración se rompió, no porque
el caso de prueba tenía datos inválidos).

## Integración HubSpot (Fase 6)

Tu formulario ya crea el Contact **y el Deal** en HubSpot — este backend
nunca crea ninguno de los dos. Un Workflow de HubSpot dispara un webhook
hacia este backend con el `dealId` → se encola el lead → un worker asíncrono
resuelve el vehículo contra el catálogo real de ABSA (marca/modelo/año →
IDs internos, sin intervención manual) y cotiza (típicamente 3-4 minutos,
no es un delay artificial: es lo que tarda el flujo real de sesión
reutilizada + resolución de catálogo + una request por aseguradora) →
actualiza propiedades del **Deal existente** y le adjunta un PDF comparativo
vía una Nota.

Setup completo (Private App, propiedades custom de Deal, configuración del
Workflow, variables de entorno, estados posibles, limitaciones conocidas):
ver **`docs/hubspot-integration.md`**.

## Seguridad y cumplimiento (antes de producción)

Checklist, no resuelto por este repo — requiere decisión humana:

- [ ] **Confirmar con ABSA / legal** si este uso está permitido por los
      términos de servicio de ABSA net. Este repo asume que Ninjo lo
      confirma por su cuenta antes de producción.
- [ ] Usar una **cuenta de broker dedicada** para el bot (no la cuenta
      personal de una persona), para trazabilidad y para poder revocar
      acceso sin afectar a nadie.
- [ ] Revisar que `ABSA_MIN_REQUEST_INTERVAL_MS` sea conservador para el
      volumen esperado — evitar generar carga anómala o activar
      protecciones anti-bot de ABSA.
- [ ] `.env`, `config/absa-comercial.json`, `config/absa-productores.json`,
      `config/hubspot-properties.json`
      y todo lo bajo `discovery/output/`, `.session/` y `.queue/` **nunca**
      se commitean (ya están en `.gitignore`) ni se
      comparten fuera del equipo que administra las credenciales — `.queue/`
      en particular tiene PII de leads (nombre, DNI) mientras esperan a ser
      cotizados.
- [ ] Si en la Fase 0 aparece un captcha o protección anti-bot activa en el
      login, **no** se debe intentar evadirlo automáticamente — es una señal
      de que ABSA no espera este tipo de acceso automatizado; escalarlo como
      tema legal/comercial antes de seguir.

## Estructura del repo

```
absa-cotizador/
  discovery/           # Fase 0: captura y parseo de HAR
    capture-har.ts
    parse-har.ts
    output/             # gitignored — HAR crudo con credenciales reales
  docs/
    absa-endpoints.md    # documentación generada en Fase 0
  src/
    config.ts            # env vars validadas (zod)
    logger.ts             # pino con redacción de secretos
    index.ts              # export público: cotizar() + tipos
    session/               # Fase 1
    quote/                  # Fase 2 (incluye vehicleCatalog.ts, el gap de la Fase 0,
                            #   y la config comercial por productor: absaComercialClient.ts)
    api/                     # servidor HTTP: /health + webhook de HubSpot
    integrations/hubspot/     # Fase 6: cliente HubSpot, mapper, auth del webhook
    queue/                     # Fase 6: cola persistida en archivo + worker asíncrono
    productores-cli.ts       # busca productores en ABSA y verifica el mapeo del formulario
    smoke-test.ts            # Fase 4
  tests/                # HTTP mockeado con nock, no pegan a ABSA ni HubSpot reales
```
