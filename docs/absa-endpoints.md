# ABSA net — endpoints descubiertos (Fase 0)

**Estado: prácticamente completo para Autos.** Capturado a partir de dos HAR
reales del flujo de cotización de Autos (`AutoCotizador`) — el segundo **con
contenido** ("Save all as HAR with content"), que confirmó el HTML real de
las respuestas, el catálogo de vehículos, y resolvió varios TODOs que habían
quedado abiertos — más una captura en vivo del login (sección 1). **Falta
todavía** el nombre exacto de la cookie de sesión (sección 5) y confirmar de
punta a punta cómo se genera/crea `id_Entity` (sección 3.1, es una asunción
razonable pero no verificada con una cotización nueva real).

Todos los valores de ejemplo abajo están **redactados/anonimizados**
(documento, fecha de nacimiento, token CSRF, IDs internos de usuario/productor
reemplazados por placeholders).

## 0. Arquitectura general

ABSA net **no es una SPA con API JSON**: es una aplicación **ASP.NET MVC
clásica** (`x-aspnetmvc-version: 5.2`, `x-aspnet-version: 4.0.30319`), servida
detrás de Cloudflare. El flujo de cotización usa jQuery + `jquery.unobtrusive-ajax`
para hacer POSTs por AJAX, pero las respuestas son **fragmentos HTML
(partial views)**, no JSON — con la excepción de un par de respuestas
`application/json` muy chicas (~48 bytes) que parecen ser un estado
intermedio ("procesando") para aseguradoras cuya cotización tarda más.

Implicancia para el Quote Client: el mapper de respuesta
(`parseCotizacionPropuestaHtml` en `src/quote/mapper.ts`) tiene que
**parsear HTML** (con `cheerio`), no `JSON.parse` — salvo el caso puntual de
error confirmado en la sección 4.

## 1. Login

**Confirmado** (capturado en vivo: navegación manual a la home deslogueada →
"Inicio de Sesión - AbsaNet" → login → redirect a `/Home/Index`).

```
POST https://www.absanet.net/
Content-Type: application/x-www-form-urlencoded
```

- La home (`GET /`) sirve el form de login directamente cuando no hay sesión
  activa (no hay una ruta separada tipo `/Account/Login`) — mismo patrón que
  el resto del sitio: `GET` para obtener el token anti-forgery embebido,
  luego `POST` al mismo path.
- Form real (`document.forms`, id `loginForm`): campos `Mail` (usuario/email
  del broker) y `Password` (contraseña), más el `__RequestVerificationToken`
  hidden input estándar de ASP.NET MVC (mismo mecanismo que el resto de los
  POSTs, ver sección 2).
- Se observó un **segundo input `type="password"` sin atributo `name`** en el
  HTML del form — probable honeypot anti-bot (un browser real no lo envía
  porque un input sin `name` no se serializa en un form-urlencoded; un bot
  que llene "todos los campos password por selector" caería en la trampa).
  El cliente HTTP lo ignora deliberadamente.
- Éxito: `200 OK` seguido de redirect a `/Home/Index` (`followRedirect:
  true` con `got`/cookie jar resuelve esto solo). No se observó ningún
  status 4xx en un login fallido durante la prueba — la heurística
  implementada (`src/session/authStrategies.ts`) asume que si la respuesta
  final todavía contiene `name="Password"` (el form de login re-renderizado),
  el login falló, aunque el HTTP status sea 200. Esto no se confirmó con un
  intento de credenciales inválidas real (no se quiso arriesgar un bloqueo
  de cuenta) — si en producción esta heurística da falsos positivos/negativos,
  revisar.
- No se observó 2FA ni captcha en el login manual.
- **Todavía sin confirmar**: nombre exacto de la(s) cookie(s) de sesión (las
  herramientas de captura disponibles no expusieron headers de
  `Set-Cookie`/`Cookie`) — se asume que es cookie-based por ser ASP.NET MVC
  clásico, y el cliente HTTP simplemente preserva el cookie jar completo
  entre requests sin depender de un nombre específico, así que esto no
  bloquea la implementación, solo la sección 5 (duración de sesión).

## 2. Identificación de sesión / CSRF

- Cada POST relevante lleva un campo `__RequestVerificationToken` en el body
  (form-urlencoded), el token anti-forgery estándar de ASP.NET MVC. Este
  token se emite embebido como `<input type="hidden">` en el HTML de la
  página del cotizador — **hay que hacer un GET previo y extraerlo del HTML**
  antes de poder hacer cualquier POST. No es un header ni un cookie separado.
- No se observaron cookies explícitas en este HAR (el export no las incluyó),
  pero al ser ASP.NET MVC es prácticamente seguro que la sesión viaja por
  cookie (`ASP.NET_SessionId` y/o `.ASPXAUTH`), enviada automáticamente por
  el browser en cada request — el cliente HTTP tiene que preservar el cookie
  jar entre el GET (para sacar el token) y los POSTs subsiguientes.
- No se observó ningún otro header custom (no hay `Authorization`, no hay
  `X-CSRF-Token` — el token va en el body, no en headers).

## 3. Endpoint principal de cotización

```
POST /AutoCotizador/Cotizar/{id_Entity}?Length={n}
Content-Type: application/x-www-form-urlencoded; charset=UTF-8
X-Requested-With: XMLHttpRequest
Referer: https://www.absanet.net/AutoCotizador/Cotizar/{id_Entity}?accion=1
```

- `{id_Entity}`: ID numérico de la "entidad" de cotización en curso (se
  genera al arrancar el wizard, ej. `19156383`). Aparece también repetido
  dentro del body como `id_Entity`.
- `?Length={n}`: cantidad de aseguradoras seleccionadas para cotizar (13 en
  la captura).
- Body (form-urlencoded, ~140 campos). Grupos principales:

  | Grupo | Campos (ejemplos) | Notas |
  |---|---|---|
  | Anti-forgery | `__RequestVerificationToken` | **requerido**, sale del HTML (sección 2) |
  | Identificación operación | `id_Organizador`, `id_Usuario`, `id_Riesgo=9` (9=Auto), `id_Operacion`, `id_Entity`, `NroCotizacion`, `EsRecotizacion`, `EsRenovacion`, `AccionCotizar=1` | `id_Riesgo` probablemente varía por ramo (auto/hogar/etc) |
  | Comercial | `Comercial.Comision`, `Comercial.id_TipoPago`, `Comercial.id_Productor`, `Comercial.id_Configuracion` | config comercial del broker, no del cliente |
  | Cliente | `Cliente.Nombre`, `Cliente.id_TipoCliente`, `Cliente.id_TipoIVA`, `Cliente.id_TipoDocumento`, `Cliente.Documento`, `Cliente.Sexo`, `Cliente.id_EstadoCivil`, `Cliente.FechaNacimiento` (`dd/MM/yyyy`, URL-encoded) | datos del asegurado |
  | Domicilio | `DomicilioRiesgo.id_Localidad`, `DomicilioRiesgo.CodigoPostal`, `DomicilioRiesgo.id_Provincia` | IDs de catálogo, no texto libre |
  | Vehículo | `Item.id_Vehiculo`, `Item.id_MarcaVehiculo`, `Item.id_ModeloVehiculo`, `Item.id_OrigenVehiculo`, `Item.VersionVehiculo` (texto libre, ej. `FIAT - ARGO 1.8 PRECISION L/21`), `Item.SumaAsegurada`, `Item.InfoAuto` (código catálogo Infoauto), `Item.Anio`, `Item.id_UsoVehiculo`, `Item.id_FormaRastreo` | **`Item.id_Vehiculo`/`id_MarcaVehiculo`/`id_ModeloVehiculo`/`InfoAuto` salen de un catálogo interno de ABSA** — probablemente hay un autocomplete/typeahead en un paso anterior del wizard que resuelve texto libre → estos IDs. No confirmado el endpoint de ese catálogo. |
  | Póliza | `Poliza.FechaInicioVigencia` (`dd/MM/yyyy`) | |
  | Aseguradoras seleccionadas | `Comercial.ConfigCotizacion.Aseguradoras[i].id_Aseguradora`, `...Aseguradoras[i].Aseguradora` (nombre) | array indexado, una entrada por aseguradora a cotizar |
  | Config comercial **por aseguradora** | `TarifaSura`, `RebajaSura`, `ClausulaAjusteZurich`, `RebajaZurich`, `RebajaMercantil`, `RebajaMeridional`, `BoniFedPat`, `TarifaHDI`, `RebajaSanCristobal`, etc. (docenas de campos, uno o varios por cada aseguradora soportada) | **Esto es configuración comercial del acuerdo del broker con cada aseguradora** (rebajas, cláusulas de ajuste, tipo de póliza) — no depende del cliente/vehículo. Ver nota abajo. |
  | Misceláneo | `CotizacionGuardada=false`, `item.Checked` (repetido N veces, `false`) | estado de checkboxes de una lista previa, probablemente del selector de vehículo |

  **Nota importante de diseño:** los campos de "config comercial por
  aseguradora" (rebajas, cláusulas, tipos de póliza) son decisiones de
  negocio del broker (cuánta rebaja aplicar, qué cláusula de ajuste usar),
  **no datos que el agente de Ninjo deba mandar por cotización**. La
  implementación los trata como una plantilla (`src/quote/absaTemplate.ts`)
  configurable una vez, no como parte de `CotizacionInput`.

- Respuesta: `200 OK`, `text/html` (fragmento HTML, 17KB–67KB según cuántas
  aseguradoras ya resolvieron). **Confirmado con un HAR con contenido**: el
  `nroCotizacion` NO viene en un input hidden — viene embebido en llamadas JS
  inline, una por cada aseguradora container: `<script>cotizar('{id_Aseguradora}',
  '{nombre}', '{count}', '{nroCotizacion}', '{ocultarComision}',
  '{accionCotizar}')</script>`. `extractNroCotizacion()` en
  `src/quote/quoteClient.ts` prueba ese patrón primero, con los patrones
  viejos (input hidden, variable JS genérica) como fallback por si ABSA
  cambia el template.

### 3.1 Catálogo de vehículos (marca/modelo/año → IDs internos) — **CONFIRMADO**

Cascada de llamadas AJAX (mismo mecanismo que usa el wizard cuando un
usuario busca un vehículo), todas devuelven JSON (no HTML) y requieren la
misma sesión autenticada que el resto:

| Endpoint | Uso |
|---|---|
| `GET /Combo/GetVehiculos?q={marca} {modelo}&sumaAseguradaMinima=0` | Busca por texto libre, devuelve candidatos `{text, value}` donde `value` es el código **InfoAuto** (ej. `q=fiat argo` → `"FIAT - FIAT - ARGO 1.8 PRECISION L/21"` → `170840`) |
| `GET /Combo/GetAniosVehiculo?infoAuto={infoAuto}&esInfoAuto=true&sumaAseguradaMinima=0` | Años disponibles para ESE candidato puntual (`170840` → `2022, 2021, 2020`) — clave para desambiguar entre candidatos de `GetVehiculos` |
| `GET /Data/GetVehiculoInfoAuto?infoAuto={infoAuto}` | Devuelve `id_Vehiculo`, `id_MarcaVehiculo`, `id_ModeloVehiculo`, `id_OrigenVehiculo`, `id_TipoCombustible`, `marca`, `modelo`, `descripcion` — esto es directamente `CotizacionInput.absa` (menos `id_Entity`/`id_Localidad`) |
| `GET /Localidad/GetLocalidadesApi?query={codigoPostal}` | Resuelve código postal → `id_Localidad` (ej. `1425` → `313`, "CAPITAL FEDERAL") |
| `GET /Data/GetVehiculoSumaAsegurada?infoAuto={infoAuto}&anio={anio}` | Suma asegurada sugerida por ABSA — usada como fallback si `CotizacionInput.cobertura.sumaAsegurada` no viene |
| `GET /Combo/GetMarcasVehiculo`, `GetModelosVehiculo`, `GetVersionesVehiculo`, `GetTiposCombustible`, `GetOrigenesVehiculo` | Combos auxiliares del wizard (selects en cascada) — no usados por el resolver actual, que va directo por `GetVehiculos` + `GetAniosVehiculo`, pero documentados por si hace falta una resolución más fina (ej. por versión/motorización exacta) |

Implementado en `src/quote/absaCatalogClient.ts`
(`AbsaHttpVehicleCatalogResolver`).

**Elección de versión.** `GetVehiculos` hace un AND de substrings sobre la
descripción y devuelve los resultados **ordenados por InfoAuto descendente**
(el código más nuevo primero), **no por relevancia**, cortados en ~35 items
y mezclando otros modelos que matchean por substring (`q=fiat argo` trae
`UNO CARGO` y `DUCATO … MAXICARGO`). Por eso "el primer candidato con el año
pedido" era en la práctica "la versión más nueva del modelo".

El resolver puntúa **todos** los candidatos contra `marca + modelo + versión`
(`src/quote/vehicleVersionMatch.ts`) y prueba de más parecido a menos hasta
encontrar uno con el año disponible. El matcher normaliza las equivalencias
reales entre cómo escribe la marca y cómo escribe ABSA (`1.2T` = `1.2 TURBO`,
`A/T` = `AT6` = `AUT`, `L/21` = año de línea, se descarta), pesa fuerte la
cilindrada y la caja, y devuelve un parecido 0..100 más las alternativas.
Sin versión pedida no inventa un orden: deja el de ABSA y no reporta
parecido (`AbsaEntityIds.similitudVersion` queda en `undefined`).

Para clavar una versión exacta, `VehiculoInput.codigoCatalogo` = InfoAuto
saltea la búsqueda entera. La lista para elegirlo sale de
`npm run versiones -- --marca X --modelo Y --version "…"`.

**`id_Entity` — asunción no verificada:** ninguno de los endpoints de
catálogo de arriba recibe/devuelve `id_Entity`, lo que sugiere que el
frontend lo genera del lado del cliente (un número de 8 dígitos, ej.
`19156383`, `20152510`) y ABSA lo acepta/crea de forma lazy en el primer
GET/POST a `/AutoCotizador/Cotizar/{id}` — no se encontró un endpoint
explícito de "crear entidad". `generateIdEntity()` en
`absaCatalogClient.ts` genera un aleatorio de 8 dígitos siguiendo esa
asunción. **No se probó de punta a punta con una cotización nueva real** —
antes de confiar en esto en producción, correr `npm run smoke-test` una vez
y confirmar que arma una cotización nueva sin pisar una existente.

### 3.1.1 Catalogos de los combos del formulario — **CONFIRMADO**

Leidos del HTML del cotizador. Los valores que no estan aca **no existen**:

| Campo | Valores |
|---|---|
| `Cliente.Sexo` | `M` Masculino, `F` Femenino |
| `Cliente.id_EstadoCivil` | `1` Soltero, `2` Casado, `3` Divorciado, `4` Viudo, `6` No corresponde, `7` Concubino (**no hay 5**) |
| `Item.id_UsoVehiculo` | `1` Particular, `2` Comercial, `5` Transporte Gral. Rutero |
| `Item.id_FormaRastreo` | `1` No, `2` Si a cargo de la compañia, `3` Si a cargo del cliente |
| `Comercial.id_TipoPago` | `1` CBU, `2` Cuponera, `3` Tarjeta de Credito |

> `src/quote/mapper.ts` tenia `taxi: 3` y `remis: 4` para `id_UsoVehiculo`:
> inventados, no existen en el catalogo. Corregido.

**`Cliente.Sexo`, `Cliente.id_EstadoCivil` y `Cliente.FechaNacimiento` son
obligatorios.** Si faltan, el POST de cotizacion responde:

```
400  {"success":false,"Errores":[
       "Debe seleccionar un sexo.",
       "Debe seleccionar un estado civil.",
       "Debe ingresar una fecha de nacimiento."]}
```

Ese array `Errores` es la unica fuente de motivos legibles cuando ABSA rechaza
una cotizacion: `tryParseAbsaErrores()` lo extrae para que el error no sea un
"status 400" pelado. `QuoteClient` ademas valida los tres campos **antes** de
la primera request, para no dejar entidades de cotizacion huerfanas en la
cuenta del broker.

### 3.2 Creacion de la cotizacion (`id_Entity`) — **CONFIRMADO**

```
GET /Cotizador/NuevaCotizacion?idRiesgo=9
    Referer: /Home/Index
  -> 302  Location: /AutoCotizador/Cotizar/{id_Entity}?accion=1
```

El `id_Entity` **lo asigna el servidor**, no el cliente. Hay que hacer este GET
sin seguir el redirect (`followRedirect: false`) y leer el ID del header
`Location`. Implementado en `crearNuevaCotizacion()`
(`src/quote/absaCatalogClient.ts`).

**`idRiesgo` es obligatorio** (9 = Auto). Sin ese parametro ABSA no sabe que
ramo arrancar y responde **200 con una pagina** en vez del 302 — sin
`Location` y sin id_Entity. Verificado contra el sitio real.

Como red de seguridad, si la respuesta llega 200 con la pagina del cotizador ya
renderizada, el id_Entity se puede sacar igual del hidden del form:
`<input name="id_Entity" ... value="20174384" />`.

Si la sesion vencio, el redirect apunta al login en vez de al cotizador: el
patron no matchea y se falla explicitamente en vez de seguir con un ID invalido.

> Historico: antes se generaba un random de 8 digitos asumiendo que ABSA creaba
> la entidad de forma lazy. Era incorrecto y podia caer sobre la cotizacion en
> curso de otro usuario del portal.

#### Nota sobre `?Length=`

`?Length=13` es un **artefacto de la serializacion del frontend**, no un
contador. En dos capturas distintas valia 13 mientras el productor ofrecia 10
aseguradoras y el body enviaba esas mismas 10. Se reproduce el valor observado
(`COTIZAR_LENGTH` en `src/quote/quoteClient.ts`) en vez de calcularlo.

### 3.3 Config comercial **por productor** — **CONFIRMADO E IMPLEMENTADO**

`Comercial.id_Productor` es un `<select>` con ~1033 opciones embebido en el HTML
del cotizador (para esta cuenta viene precargado; para otras el select2 lo llena
por búsqueda incremental). El JS que gobierna esto es
`Scripts/Cotizador/Autos/productor.js`: al cambiar el productor dispara **tres**
llamadas, no una.

```
GET /Combo/GetConfiguracionesWS?idOrganizador={org}&idProductor={id}&idRiesgo=9
  -> { data: { items: [{ text: "STD ARDAMA", value: "3345" }] } }   <- id_Configuracion
     (si viene una sola, el portal la selecciona solo)

GET /Data/GetPaquetesComision?idOrganizador={org}&idProductor={id}&idRiesgo=9&idAseguradora=&comision=0
  -> { data: { comisiones: [10,15,20,25,30], comisionPrincipal: 25, comisionOrg: 0 } }
     -> Comercial.Comision y Comercial.ConfigCotizacion.ComisionOrg

GET /AutoCotizador/ObtenerConfigCotizador?idProductor={id}
  -> { Estado: 1, View: "<html...>" }
     View reemplaza ENTERO el div #condicionesAseguradoras: las
     Comercial.ConfigCotizacion.Aseguradoras[i] y los ~45 campos
     Comercial.* / Poliza.* / Item.RebajasComerciales[*] de ESE productor.
     Estado != 1 = el portal muestra `Mensaje` en un modal (productor no habilitado).
```

Y para buscar un productor por nombre, sin crear nada:

```
GET /Combo/GetProductoresIncremental?query=ardama
  -> { data: { items: [{ text: "ARDAMA 2020 S.A.", value: "6856" }] } }
```

**OJO: ese buscador no devuelve todos los productores.** Verificado el
2026-08-25 contra producción: `woscoff` (7616 "WOSCOFF, GABRIEL"),
`ballesteros` (11026) y `yimi` (9711) devuelven **cero** resultados aunque los
tres están en el `<select>` del cotizador, mientras `zuccotti` (7688),
`zarate` (10080), `1989` (9590) y `abril` (7998) sí aparecen. No se encontró el
criterio; el patrón no es "persona vs concesionaria". No usarlo como fuente de
verdad del catálogo.

La lista completa (1036 en esta cuenta) es el `<select id="idProductor">` de la
página del cotizador. Se puede abrir sin efectos secundarios con una cotización
que ya exista, en vez de creando una nueva:

```
GET /AutoCotizador/Cotizar/{nroCotizacion}?accion=4&esRecotizacionAnalisis=False
  -> 200 con la página completa (~190KB), combo de productores incluido
```

Implementado en `parseComboProductores()` (`src/quote/productoresCatalogo.ts`),
con cache de 24h en `.session/` porque la alternativa —`/Cotizador/NuevaCotizacion`—
deja una entidad de cotización vacía en la cuenta.

**Implicancia:** `config/absa-comercial.json` NO es config de la cuenta, es la
config de **un productor puntual** (el que estaba seleccionado al capturar).
Cotizar para otro productor con esos valores da precios con el acuerdo
comercial equivocado, y la lista de aseguradoras disponibles puede diferir.

Implementado en `src/quote/absaComercialClient.ts` (las tres requests, con
cache por productor) y `parseCondicionesAseguradoras()`
(`src/quote/absaTemplate.ts`), que reproduce lo que mandaría el navegador con
ese HTML recién cargado. Cuatro rarezas del View que el parser tiene que
respetar, todas verificadas contra el HTML real:

| Rareza | Qué hace el parser |
|---|---|
| El name real va en `Name=` (mayúscula) y hay otro `name=` (minúscula) con un id corto | HTML no distingue mayúsculas en atributos y gana el primero, que es el que sirve |
| Selects sin ninguna opción `selected` | Toma la primera, que es lo que submitea un form real |
| Checkbox + hidden de MVC con el mismo name | El hidden (`false`) no pisa al checkbox |
| Dos selects distintos con el mismo name (`Comercial.PlanAsegFedPat`) | Gana el primero; el navegador manda los dos y la plantilla de archivo manda uno solo desde siempre, y Federación cotiza igual |

**Lo que el View NO trae:** las rebajas llegan con el default del formulario
(casi siempre `0`) y el listado de opciones que ese productor tiene permitidas
(`Comercial.RebajaZurich` → `0, 10, 15, 20, 25, 30`). Cuál se usa es una
decisión comercial que el productor toma a mano en la pantalla, no un dato que
ABSA devuelva: por eso el mapeo de productores tiene overrides
(`campos`), y por eso la plantilla de archivo sigue siendo la fuente para su
propio productor. Ver el README, sección "Cotizar con el productor del
formulario".

`Comercial.FranquiciaFedPat` y `Comercial.TipoVehiculoFedPat` llegan **vacíos**:
dependen del vehículo y de la configuración, y se pueblan aparte con
`GET /AutoCotizador/GetFranquiciasFedPat?infoAuto={infoAuto}&idConfiguracion={id}`
y `GetTiposVehiculoFedPat` con los mismos parámetros. Hoy se mandan los valores
de la plantilla/overrides sin consultar esos combos.

### 3.3.1 Provincia del riesgo: NO se pide, se deriva del codigo postal

`DomicilioRiesgo.id_Provincia` es un **hidden**, no un `<select>`: no hay lista
de provincias que elegir. El portal lo llena solo cuando se elige la localidad
(`Scripts/_Components/localidad.js`):

```js
Localidad.prototype.getLocalidad = function (idLocalidad) {
    $.getJSON('/Localidad/GetLocalidad', { idLocalidad }).done(response => {
        $(codigoPostalSelector).val(response.data.codigoPostal);
        $(provinciaSelector).val(response.data.id_Provincia);
        $(paisSelector).val(response.data.id_Pais);
    });
};
```

```
GET /Localidad/GetLocalidadesApi?query=1425   -> { items: [{ text: "(1425) CAPITAL FEDERAL", value: "313" }] }
GET /Localidad/GetLocalidad?idLocalidad=313
  -> { data: { id_Pais: 80, id_Provincia: 1, id_Localidad: 313,
               codigoPostal: "1425", localidad: "CAPITAL FEDERAL", provincia: "Capital Federal" } }
```

Verificado contra produccion el 2026-08-25 con CPs de distintas provincias:

| CP | id_Localidad | id_Provincia | Provincia | Localidades con ese CP |
|---|---|---|---|---|
| 1425 | 313 | 1 | Capital Federal | 1 |
| 1900 | 3184 | 2 | Buenos Aires | 26 |
| 5000 | 21224 | 4 | Cordoba | 53 |
| 8000 | 2839 | 2 | Buenos Aires | 42 |
| 4000 | 20606 | 24 | Tucuman | 33 |
| 5500 | 12991 | 13 | Mendoza | 11 |
| 9410 | 19976 | 23 | Tierra del Fuego | 16 |

**Ojo con la localidad, no con la provincia:** un CP puede tener decenas y ABSA
las manda **en orden alfabetico, no por relevancia**. Para la provincia da igual
(todas las de un CP son de la misma), pero la localidad entra en la prima. Caso
real, CP 1849 (11 localidades):

```
3176    (1849) BRIO DON ORIONE (Buenos Aires)      <- la primera del combo
646     (1849) BRIO EL PATRONATO (Buenos Aires)
1357    (1849) BRIO EL TREBOL (Buenos Aires)
...
3311    (1849) CLAYPOLE (Buenos Aires)             <- la que suele ser
```

Por eso, cuando el lead trae el nombre de la localidad, se elige la mas parecida
en vez de la primera (`rankearLocalidades()`, `src/quote/localidadMatch.ts`).
Sin nombre, o si no se parece a ninguna, se toma la primera y queda en el log.

Implementado en `resolveLocalidad()` (`src/quote/absaCatalogClient.ts`).

### 3.4 Guardar la cotizacion — **CONFIRMADO**

Cotizar NO deja la cotizacion guardada: hay un paso explicito aparte.

```
GET  /AutoCotizador/GuardarCotizacion?nroCotizacion={nro}&_={timestamp}
     X-Requested-With: XMLHttpRequest
     Referer: /AutoCotizador/Cotizar/{id_Entity}?accion=1
  -> HTML del modal (form#GuardarCotizacionForm)

POST /AutoCotizador/GuardarCotizacion
     Content-Type: application/x-www-form-urlencoded; charset=UTF-8
     body: __RequestVerificationToken, NroCotizacion, Descripcion
  -> HTML del modal; el exito se ve como `<div class="alert alert-success">`
```

**Ojo con el token:** el modal trae su **propio** `__RequestVerificationToken`,
distinto del de la pagina del cotizador y distinto en cada GET. Hay que sacar
el del modal, no reusar el otro.

`Descripcion` es el nombre libre con el que la cotizacion queda en el listado
(en la captura: `"cotización prueba - abc123 - gomez - ardama"`). Lo arma
`descripcionCotizacion()` (`src/quote/mapper.ts`) con todo lo que sirva para
encontrarla despues, salteando lo que no vino:

```
CHEVROLET TRACKER 2021 - AB123CD - Juan Perez - 30123456
    vehiculo             patente     titular     documento
```

Implementado en `QuoteClient.guardarCotizacion()`. Compartir la cotizacion con
los asesores del scope es configuracion manual del lado de ABSA, fuera de
alcance de este repo.

### 3.5 Impresión en PDF de la cotización — **CONFIRMADO**

**Paso 0 — marcar qué propuestas entran.** Cuál cobertura se imprime **no
viaja en el form de impresión**: es estado del lado del servidor, que el
portal va actualizando cada vez que el productor tilda un checkbox en la
grilla de resultados. Sin este paso el PDF sale con la cabecera (titular +
vehículo) y la **tabla de propuestas vacía** — verificado en producción.

```
POST /AutoCotizador/ExportarActualizarPropuestasCheck   (XHR, form-urlencoded)
    nroCotizacion={nro}&idAseguradora={id}&chktodos=true&idCobRiesgo=0
    &chkCobRiesgo=false&ocultarComision=False
 -> 200 {"result":true}
```

El contrato sale del JS del propio cotizador, que expone
`ActualizarPropuestasCheckExportar(idAseguradora, chktodos, idCobRiesgo, chkCobRiesgo)`:

| Acción en la pantalla | Parámetros |
|---|---|
| Tildar **todas** las de una aseguradora | `chktodos=true, idCobRiesgo=0, chkCobRiesgo=false` |
| Destildar todas | `chktodos=false, idCobRiesgo=0, chkCobRiesgo=false` |
| Tildar **una** cobertura | `chktodos=false, idCobRiesgo={id}, chkCobRiesgo=true` |

Los `idCobRiesgo` son los `id` de los checkboxes `class="Exportar Propuesta{idAseguradora}"`
del fragmento de propuesta. Se usa el "todas" (una request por aseguradora) en
vez de una por cobertura, que serían ~10 veces más.

Solo se marcan las aseguradoras que **efectivamente cotizaron**
(`CotizacionResult.aseguradorasCotizadas`): las que fallaron no tienen
propuestas y ABSA responde sin confirmar.

Después de eso, el PDF sale en **dos pasos** más, confirmados con el HAR de
Fase 0:

```
GET /AutoCotizador/ExportarPDF?ocultarComision=True&nroCotizacion={nro}&_={ts}
    (XHR, Referer: /AutoCotizador/Cotizar/{id_Entity}?accion=1)
 -> 200 text/html: el HTML del modal de opciones, con el
    __RequestVerificationToken adentro

POST /Impresion/ExportarPDFCotAutos   (application/x-www-form-urlencoded)
    __RequestVerificationToken={token}&OcultarComision=True&NroCotizacion={nro}
    &OcultarLogoOrganizador=false&OcultarLogoProductor=false&OcultarFooter=false
    &MostrarPrima=false&MostrarPremio=true&MostrarPremio=false
    &MostrarCobertura=true&MostrarCobertura=false&MostrarPremioTotal=false
    &Ordenamiento=Aseguradora
 -> 200 application/pdf
    content-disposition: attachment; filename=FIAT - ARGO 1.8 PRECISION L/21_2022.pdf
```

Los campos repetidos (`MostrarPremio=true&MostrarPremio=false`) **no son un
error**: es el patrón checkbox+hidden de ASP.NET MVC y así los manda el
navegador real. Se replican igual.

Ojo: si la sesión venció, este POST responde **200 con el HTML del login**
(mismo patrón que la sección 5), así que hay que validar el `content-type`
antes de dar el PDF por bueno — si no, se termina adjuntando la página de
login en el CRM. Implementado en `QuoteClient.exportarPdfCotizacion()`.

### 3.6 URL para recotizar / editar una cotización — **CONFIRMADO**

```
https://www.absanet.net/AutoCotizador/Cotizar/{nroCotizacion}?accion=4&esRecotizacionAnalisis=False
```

El ID del path acá es el **número de cotización** (ej. `41321726`), **no** el
`id_Entity` (ej. `24104663`) que usa `?accion=1` al crear una cotización
nueva. Son dos números distintos y conviene no confundirlos.

Verificado en producción el 2026-08-24 con la cotización `41321726`:

| | `?accion=4` | `?accion=1` (mismo número) |
|---|---|---|
| Status | 200, 201 KB | 200, 158 KB |
| `Cliente.Documento` | `30123456` | vacío |
| `Cliente.FechaNacimiento` | `15/01/1990` | vacío |
| `DomicilioRiesgo.CodigoPostal` | `1425` | vacío |
| `Item.id_MarcaVehiculo` / `id_ModeloVehiculo` | `12` / `67` | `0` / `0` |

O sea: `accion=4` abre el cotizador **con los datos del cliente y del vehículo
precargados**, listo para modificar y volver a cotizar — que es justamente
para lo que se guarda el link en el Deal. `accion=1` con el mismo número abre
un formulario vacío. En el form, `id_Entity` toma el valor del número de
cotización.

Dos condiciones para que el link sirva: la cotización tiene que estar
**guardada** (sección 3.4; si no, es efímera) y quien lo abra tiene que tener
**sesión activa en ABSA net** — no es un link para mandarle a un cliente.
Se arma en `urlDeCotizacionEnAbsa()` y se escribe en el Deal de HubSpot.

## 4. Endpoint por aseguradora (resultado individual)

```
POST /CotizadorPropuesta/CotizarPropuesta/
Content-Type: application/x-www-form-urlencoded; charset=UTF-8
X-Requested-With: XMLHttpRequest
```

Body: `idRiesgo={id_Riesgo}&idAseguradora={id}&ocultarComision=False&nroCotizacion={nroCotizacion}&accionCotizar=1`

- Se dispara **una vez por cada aseguradora seleccionada**, en paralelo,
  después de la respuesta del endpoint principal (que devuelve/expone
  `nroCotizacion`, ej. `41318289`).
- Mayoría de las respuestas: `200 OK`, `text/html` (17KB–31KB) — **estructura
  confirmada con un HAR con contenido**: una tabla `table.table-propuesta`
  con una fila de encabezado (`<th class="panel-heading">`, la primera
  celda es el logo de la aseguradora y se ignora, el resto son los planes
  disponibles con el nombre en `a.labelDetalle`) y filas de detalle
  identificadas por su primera celda (`<td>Premio</td>`, `<td>Prima</td>`,
  `<td>Comisión</td>`, etc), con un valor por plan en el mismo orden que el
  encabezado. Una sola respuesta puede traer **varios planes** de la misma
  aseguradora (ej. "XL TC + GRA. FULL", "B1", "L RC", ... — hasta 10 en la
  captura). `parseCotizacionPropuestaHtml()` en `src/quote/mapper.ts` usa la
  fila "Premio" (precio final) como el valor de cada opción.
- Alguna respuesta puntual: `200 OK`, `application/json` (48 bytes) —
  **confirmado**: `{"error":true,"responseText":"Error al Cotizar"}`. NO es
  un estado "todavía procesando" (no hace falta pollear) — es un rechazo de
  negocio de ESA aseguradora puntual para este vehículo/cobertura.
  `tryParseAbsaErrorJson()` en `src/quote/mapper.ts` lo detecta y
  `QuoteClient` lo trata como un fallo más de la lista (`fallos[]`), no de
  toda la cotización.

### 4.1 Tiempos reales (medidos sobre dos capturas)

| Request | Tiempo |
|---|---|
| `POST /AutoCotizador/Cotizar/{id}` | 1,4 s – 2,1 s |
| `POST /CotizadorPropuesta/CotizarPropuesta/` (la mayoria) | 5 s – 17 s |
| `POST /CotizadorPropuesta/CotizarPropuesta/` (la mas lenta) | **40 s y 55 s** |

Siempre hay **una** aseguradora que tarda muchisimo mas que el resto. El
timeout por aseguradora esta en 90 s (`PROPUESTA_TIMEOUT_MS`) por eso; con los
30 s que habia antes, esa aseguradora daba timeout en todas las corridas.

Ademas, un timeout contra una aseguradora **no** debe propagarse: el reintento
de `QuoteClient.attempt()` rehace el flujo desde cero y deja una cotizacion
**duplicada** en la cuenta del broker. Cada propuesta se pide dentro de su
propio try/catch y un fallo se registra en `fallos` como uno mas.

## 5. Duración de sesión / expiración

**RESUELTO** (observado en produccion el 2026-08-20).

ABSA net **no devuelve 401 ni 403** cuando la sesion vence. Responde
**`200 OK` con el HTML de la pagina de login**, incluso en los endpoints que
normalmente devuelven JSON (`/Combo/*`, `/Data/*`). El sintoma en el cliente
era un `Unexpected token '<', "
<!DOCTYPE "... is not valid JSON`.

Consecuencias para el diseño:

- La deteccion por status code (`SESSION_EXPIRED_STATUS = {401, 403}` en
  `QuoteClient`) **nunca se dispara sola** en este sitio. Hay que detectar
  ademas "me devolvio HTML donde esperaba JSON".
- `SessionArtifact.estimatedExpiresAt` sigue en `null` (no se conoce la
  duracion real), asi que `SessionManager.isExpired()` siempre da `false` y la
  sesion persistida en `.session/` se reusa indefinidamente. Sin la deteccion
  de arriba, una sesion vencida en disco rompe todas las corridas siguientes
  hasta borrar el archivo a mano.
- Implementado en `assertNoEsPaginaDeLogin()`
  (`src/quote/absaCatalogClient.ts`): tira `SessionExpiredError`, el resolver
  relogea y reintenta una vez, y se cura solo.

**Segundo patrón, en los endpoints JSON** (observado el 2026-08-25): con una
sesión vieja en `.session/`, **todos** los `/Combo/*` y `/Data/*` responden
`200` con el **cuerpo vacío** — cero bytes, sin `content-type` — y después de
reloguear los mismos devuelven su JSON normal. No hay HTML que detectar, así
que el síntoma era `Unexpected end of JSON input` reportado como error técnico.
`assertNoEsPaginaDeLogin()` trata el cuerpo vacío igual que el login: sesión
vencida, relogin y un reintento.

**Tercer patrón, en las páginas HTML** (observado el 2026-08-24): además del
login servido con 200, las vistas del cotizador responden **`302` a
`/Cuenta/UsuarioLogOut`** cuando la sesión ya no vale. Es más traicionero que
el anterior, porque `got` sigue el redirect y termina con una página de la que
`extractRequestVerificationToken()` saca un token **válido pero de otro
formulario** — el POST siguiente falla de una forma que no se parece en nada
a "se venció la sesión".

Detectado en `esSesionCaida()` (`src/quote/quoteClient.ts`), mirando tanto el
`location` como los `redirectUrls` de la respuesta. `cotizar()` lo maneja con
su ciclo de reintentos, y `guardarCotizacion()` / `exportarPdfCotizacion()`
con `conSesionFresca()` (relogin + un reintento).

Sigue pendiente: la **duracion** real de la sesion (para poder relogear
proactivamente en vez de reactivamente) y el nombre exacto de la cookie.

## 6. Protecciones anti-bot y **lista blanca de IPs**

**ABSA net filtra por IP.** Desde una IP no habilitada, corta con **`403` en la
primera request** — el `GET` de la página de login, antes de ver usuario y
contraseña. Confirmado el 2026-08-24 desplegando en un VPS de DigitalOcean:

| Origen | `GET https://www.absanet.net/` |
|---|---|
| Máquina de la oficina | `200` |
| Droplet (DigitalOcean) | `403` |
| Droplet, con User-Agent de Chrome real | `403` |

No se arregla del lado del cliente: los headers de navegador no cambian nada.
**Hay que pedirle a ABSA que habilite la IP pública del servidor** antes de
desplegar (`curl -s ifconfig.me` para saber cuál es). Está contemplado en
`HttpFormAuthStrategy`: un 403 en esa request tira un error que lo dice.

Aparte de eso, no se observó ningún challenge durante el flujo normal (login
manual + cotización). El sitio corre detrás de Cloudflare (headers `cf-ray`,
`cf-cache-status`), que puede tener bot-management para tráfico anómalo aunque
no se haya disparado acá. Recomendación: mantener
`ABSA_MIN_REQUEST_INTERVAL_MS` conservador y no asumir que nunca va a aparecer
un challenge.

## 7. Pendientes para cerrar la Fase 0

1. ~~Capturar el login desde cero (form/URL/mecanismo).~~ **Hecho** (sección 1).
2. ~~Re-capturar el flujo de cotización con "Save all as HAR with
   content".~~ **Hecho** — HTML real de ambos endpoints, parser reescrito
   contra selectores reales (`src/quote/mapper.ts`).
3. ~~Confirmar el endpoint del catálogo de vehículos.~~ **Hecho** (sección
   3.1) — implementado en `src/quote/absaCatalogClient.ts`. Limitación
   conocida: sin versión/motorización en el input, puede resolver a una
   versión distinta si hay varias para el mismo modelo/año.
4. ~~Confirmar el patrón de "aseguradora todavía procesando".~~ **Hecho** —
   no es polling, es un error de negocio de esa aseguradora (sección 4).
5. Nombre exacto de la(s) cookie(s) de sesión (sección 5) — no bloquea la
   implementación (el cookie jar se preserva completo igual), solo la
   duración estimada de la sesión.
6. ~~Validar el `id_Entity` generado del lado del cliente.~~ **Resuelto**
   (sección 3.2): no se genera del lado del cliente, lo asigna ABSA via
   `GET /Cotizador/NuevaCotizacion`. La asunción anterior era incorrecta.
7. ~~La resolución del catálogo de vehículos asume que la primera versión
   encontrada por `GetVehiculos` que soporte el año pedido es la correcta.~~
   **Hecho** (sección 3.1): ahora se elige la versión más parecida a
   `marca + modelo + versión` y se puede clavar el InfoAuto exacto. Queda
   pendiente que el formulario de HubSpot capture la versión en
   `version_vehiculo` — el pipeline ya la usa si viene, y sin ella la
   elección entre versiones del mismo modelo sigue siendo arbitraria.
