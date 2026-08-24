# Integración HubSpot → ABSA net (Fase 6)

Objetivo: tu formulario ya crea el Contact **y el Deal** en HubSpot. En
paralelo (sin pantalla, sin RPA visible) este backend cotiza en ABSA net y,
dentro de los ~3-4 minutos siguientes, actualiza ese **mismo Deal** con el
resultado y el link a la cotización (y, si se prende `HUBSPOT_ADJUNTAR_PDF`,
el PDF adjunto). Este backend **nunca crea Deals ni Contacts** — solo escribe
sobre uno que ya existe.

## 0. Por qué esta arquitectura

- **HubSpot guarda el Contact y el Deal al instante** (eso ya lo hace tu
  formulario, no lo toca esta integración).
- **En paralelo**, un Workflow de HubSpot le avisa a este backend que hay un
  Deal nuevo, pasándole su `dealId`. El backend responde en milisegundos
  (`202 Accepted`) y encola el trabajo — el Workflow no espera a que termine
  la cotización.
- **Un worker asíncrono**, corriendo en el mismo proceso Node, toma ese
  trabajo de la cola, resuelve el vehículo contra el catálogo real de ABSA
  (marca/modelo/año → IDs internos) y cotiza contra ABSA net. Esto es lo que
  tarda 3-4 minutos: no es un delay artificial, es lo que realmente demora
  el flujo (login/reuso de sesión + resolución de catálogo + 1 request por
  aseguradora, con rate limiting conservador para no parecer tráfico de bot).
- **Al terminar**, guarda la cotización en ABSA (para que el link sirva) y
  actualiza propiedades del Deal existente (`absa_estado`, `cotizacion_absa`,
  etc.). El PDF adjunto es opcional y hoy está apagado (ver 1.2).

No hay ninguna pantalla de navegador visible en este flujo: todo es HTTP
directo (la sesión de ABSA se reutiliza vía cookies, como se armó en la Fase
1), corriendo en un proceso backend en tu servidor.

```
Formulario (tu web)
      │
      ▼
Contact + Deal creados en HubSpot  ──(guardado inmediato, nativo de HubSpot / tu formulario)
      │
      ▼
Workflow de HubSpot ──"Enviar un webhook"──▶  POST /webhooks/hubspot/absa  { dealId, ... }
                                                     │
                                                     ▼
                                          responde 202 al instante,
                                          encola el lead (.queue/leads.json)
                                                     │
                                                     ▼ (asíncrono, cada QUEUE_POLL_INTERVAL_MS)
                                              LeadWorker
                                                     │
                                    resuelve vehículo → IDs de ABSA (AbsaHttpVehicleCatalogResolver)
                                                     │
                                              QuoteClient.cotizar()  ──▶ ABSA net
                                                     │
                              PATCH propiedades del Deal EXISTENTE ──▶ HubSpot
                              (+ PDF adjunto via Nota si HUBSPOT_ADJUNTAR_PDF=true)
```

## 1. Del lado de HubSpot

### 1.1 Private App (para que el backend pueda escribir en HubSpot)

Settings → Integrations → Private Apps → Create a private app.

Scopes necesarios:

- `crm.objects.deals.read`
- `crm.objects.deals.write`
- `crm.schemas.deals.read` (para poder usar las propiedades custom del punto 1.2)
- `files` (subir el PDF adjunto vía Files API)
- `crm.objects.notes.write` (crear la Nota con el adjunto)

Copiá el token generado a `HUBSPOT_ACCESS_TOKEN` en tu `.env`. **Nunca** lo
commitees ni lo compartas fuera del equipo que administra credenciales.

### 1.2 Propiedades custom en Deals

Settings → Objects → Deals → Properties → Create property.

**Solo hacen falta las que quieras**: el mapeo de
`config/hubspot-properties.json` es la fuente de verdad y lo que no esté ahí
no se escribe. Esto importa más de lo que parece — HubSpot rechaza el PATCH
**entero** con un 400 si una sola de las propiedades enviadas no existe en el
portal, así que mapear de más no degrada: rompe todo, incluidas las que sí
existen.

El portal de CeBrokers hoy tiene estas cuatro (verificado por API el
2026-08-24), y es con las que corre:

| Clave del mapeo | Propiedad en HubSpot | Tipo |
|---|---|---|
| `estado` | `absa_estado` | Texto de una línea |
| `numeroCotizacion` | `absa_numero_cotizacion` | Texto de una línea |
| `errorMensaje` | `absa_error_mensajes` | Área de texto |
| `cotizacionUrl` | `cotizacion_absa` | Área de texto |

Con eso, un Deal cotizado queda así:

```json
{
  "absa_estado": "ok",
  "absa_numero_cotizacion": "41321726",
  "cotizacion_absa": "https://www.absanet.net/AutoCotizador/Cotizar/41321726?accion=4&esRecotizacionAnalisis=False"
}
```

Las demás claves del mapeo son opcionales; si algún día querés los números en
el CRM (para reportes o vistas), creás la propiedad y la agregás al JSON:

| Nombre interno sugerido | Tipo | Uso |
|---|---|---|
| `absa_estado` | Texto de una línea | `ok`, `error_datos_incompletos`, `error_catalogo_no_resuelto`, `error_negocio_absa`, `error_absa` (ver sección 3) |
| `absa_numero_cotizacion` | Texto de una línea | Número de cotización de ABSA net |
| `absa_mejor_premio` | Número | Premio más bajo entre todas las opciones cotizadas |
| `absa_mejor_aseguradora` | Texto de una línea | Aseguradora/plan de esa mejor opción |
| `absa_cantidad_opciones` | Número | Cuántos planes devolvieron cotización |
| `absa_opciones_json` | Área de texto | Todas las opciones, en JSON crudo |
| `absa_cotizado_en` | Fecha/hora | Timestamp de cuándo se obtuvo el resultado (o el error) |
| `absa_error_mensaje` | Área de texto | Detalle del error, si `absa_estado` no es `ok` |
| `cotizacion_absa` | Texto de una línea | URL de la cotización en ABSA net (`/AutoCotizador/Cotizar/{nroCotizacion}?accion=4&…`) |

Sobre `cotizacion_absa`: el link **solo abre con sesión activa en ABSA net**,
así que es para el productor, no para mandarle al cliente. Requiere además que
la cotización esté guardada en ABSA — el worker la guarda solo (ver
`docs/absa-endpoints.md` secciones 3.4 y 3.6).

**El PDF está apagado por ahora** (`HUBSPOT_ADJUNTAR_PDF=false`). La
cotización automática es orientativa — el estado civil se asume Casado y la
versión se elige por parecido — y un PDF con formato de cotización formal en
el Deal se lee como definitivo. El Deal igual queda con los premios, las
opciones y el link para abrir la cotización en ABSA y ajustarla ahí.

Cuando se prenda (`HUBSPOT_ADJUNTAR_PDF=true`): el PDF **no** va en una
propiedad — HubSpot no tiene un tipo de propiedad "archivo" para Deals — se
sube a Files y se adjunta con una **Nota** asociada al Deal, con lo que
aparece tanto en el timeline como en la tarjeta **"Archivos adjuntos"**. Es la
impresión que genera ABSA (la misma del botón "Exportar PDF"), con la comisión
oculta; si ABSA no la devuelve, se adjunta como respaldo el comparativo que
arma este repo.

### 1.3 Workflow: disparar el webhook al crearse el Deal

Automation → Workflows → Create workflow (basado en **Deal**, no Contact —
necesitamos el `dealId` que ya existe).

- **Trigger**: "Deal is created" (o el trigger que dispare tu formulario al
  crear el Deal).
- **Acción**: "Enviar un webhook" / "Send a webhook" (en algunos planes esto
  requiere Marketing/Sales/Service Hub Pro o superior, o Operations Hub para
  la variante "Custom code" — **revisá qué tenés disponible en tu portal**,
  el nombre exacto de la acción puede variar según el tier).
  - **Method**: POST
  - **URL**: `https://TU-SERVIDOR/webhooks/hubspot/absa`
  - **Headers custom**: `x-webhook-secret: <el mismo valor de HUBSPOT_WEBHOOK_SECRET>`
  - **Body** (JSON custom, usando tokens de personalización de HubSpot —
    combinando propiedades del Deal y, si las necesitás, del Contact
    asociado, según qué objeto tenga cada dato en tu formulario):

    ```json
    {
      "dealId": "{{deal.hs_object_id}}",
      "contactId": "{{associatedContact.hs_object_id}}",
      "email": "{{associatedContact.email}}",
      "firstname": "{{associatedContact.firstname}}",
      "lastname": "{{associatedContact.lastname}}",
      "dni": "{{associatedContact.dni}}",
      "fecha_nacimiento": "{{associatedContact.fecha_nacimiento}}",
      "telefono": "{{associatedContact.phone}}",
      "provincia": "{{associatedContact.provincia}}",
      "localidad": "{{associatedContact.localidad}}",
      "codigo_postal": "{{associatedContact.codigo_postal}}",
      "marca_vehiculo": "{{deal.marca_vehiculo}}",
      "modelo_vehiculo": "{{deal.modelo_vehiculo}}",
      "anio_vehiculo": "{{deal.anio_vehiculo}}",
      "uso_vehiculo": "{{deal.uso_vehiculo}}",
      "cobertura_tipo": "{{deal.cobertura_tipo}}"
    }
    ```

    Ajustá los nombres de propiedad (`deal.xxx` / `associatedContact.xxx`) a
    los reales de tu portal/formulario — estos son solo el contrato que
    espera `src/integrations/hubspot/mapper.ts`. Si tu form guarda todo en
    el Contact (no en el Deal), usá `{{associatedContact.xxx}}` para esos
    campos también — lo único que **tiene** que venir del Deal es `dealId`.
    **`codigo_postal` importa**: sin código postal (o `localidad`) el
    resolver de catálogo no puede resolver `DomicilioRiesgo.id_Localidad` y
    el Deal va a quedar en `error_catalogo_no_resuelto`.

## 2. Del lado de este repo

```bash
# crear config/hubspot-properties.json (formato en el README, seccion "Archivos de config")
# ajustar los nombres si usaste otros distintos a los sugeridos en 1.2
```

Completar en `.env` (lista completa de variables en el README): `HUBSPOT_ACCESS_TOKEN`,
`HUBSPOT_WEBHOOK_SECRET` (inventá un valor random largo, ej.
`openssl rand -hex 32`).

Si `HUBSPOT_ACCESS_TOKEN` o `HUBSPOT_WEBHOOK_SECRET` quedan vacíos, esta
parte se desactiva sola (`GET /health` y `POST /cotizaciones/absa` siguen
funcionando igual) — no rompe el resto del servicio.

```bash
npm run dev:api   # levanta Express + el LeadWorker en el mismo proceso
```

## 3. Estados posibles del Deal (`absa_estado`)

| Estado | Qué significa | ¿Se reintenta? | ¿Adjunta PDF? |
|---|---|---|---|
| `en_proceso` | El lead se encoló y la cotización está en curso. Se escribe apenas entra el webhook, para poder distinguir "todavía viene" de "falló en silencio" | — | Todavía no |
| `ok` | Se cotizó correctamente, ver `absa_opciones_json` y `cotizacion_absa` | — | Solo si `HUBSPOT_ADJUNTAR_PDF=true` |
| `error_datos_incompletos` | El payload de HubSpot no traía lo mínimo (nombre, apellido, marca/modelo/año, sexo, estado civil, fecha de nacimiento — el DNI **no** es obligatorio: ABSA cotiza sin documento) | No — completar el dato en HubSpot y reprocesar a mano | No |
| `error_catalogo_no_resuelto` | ABSA no tiene ese vehículo/año, o falta código postal/localidad para resolver el domicilio (ver `docs/absa-endpoints.md` sección 3.1) | No | No |
| `error_negocio_absa` | ABSA net rechazó la cotización por un motivo de negocio (dato inválido, producto no cotizable) | No | No |
| `error_absa` | Error técnico contra ABSA net (sesión, timeout, cambio de contrato) después de agotar `QUEUE_MAX_ATTEMPTS` reintentos | Ya se reintentó automáticamente antes de llegar a este estado | No |

Un Deal que nunca cambia de estado (no aparece ninguna actualización después
de varios minutos) generalmente significa que el proceso backend no está
corriendo, o que el Workflow no está disparando — revisar logs del servicio
y el historial de ejecuciones del Workflow en HubSpot.

## 4. Catálogo de vehículos y limitaciones conocidas

La resolución marca/modelo/año → IDs internos de ABSA (`AbsaHttpVehicleCatalogResolver`,
`src/quote/absaCatalogClient.ts`) está implementada contra los endpoints
reales de ABSA net (confirmados con un HAR real) — ver
`docs/absa-endpoints.md` sección 3.1 para el detalle. Lo que hay que tener
presente:

- **Elección de versión**: el resolver puntúa todas las versiones del
  catálogo contra `marca + modelo + versión` y elige la más parecida (no la
  primera de la lista, que en ABSA es la más nueva). La calidad del match
  depende de que llegue `version_vehiculo` — el formulario la manda desde
  Datacar. La similitud (0-100) queda en los logs, y por debajo de 60 se
  loguea como warning para poder revisar.
- **Estado civil asumido**: el formulario no lo pregunta y ABSA lo exige, así
  que se manda **Casado** siempre (`ESTADO_CIVIL_POR_DEFECTO` en
  `src/integrations/hubspot/mapper.ts`). Influye en la prima: las
  cotizaciones automáticas son orientativas y al emitir hay que confirmar el
  dato real.
- **Sexo sí es obligatorio**: ABSA lo valida server-side y no hay default
  razonable (cambia la prima). Un lead sin `sexo` queda en
  `error_datos_incompletos`.

## 4.1 Disparar desde el formulario (FormLeads) en vez de un Workflow

El Workflow de HubSpot (sección 1.3) sigue siendo válido, pero si el
formulario ya tiene el `dealId` en la mano es más simple que lo dispare él:
una llamada menos, sin depender del tier de HubSpot y sin la latencia del
Workflow.

En `app/api/leads/route.ts`, después de `crearLeadYDeal()`:

```ts
const { contacto, deal } = await crearLeadYDeal(data);

// El lead YA está guardado. Esto solo encola la cotización: responde 202 en
// milisegundos y el resultado llega al Deal 3-4 minutos después.
try {
  await fetch(`${process.env.ABSA_COTIZADOR_URL}/webhooks/hubspot/absa`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-webhook-secret": process.env.ABSA_WEBHOOK_SECRET!,
    },
    body: JSON.stringify({
      dealId: deal.id,
      contactId: contacto.id,
      firstname: data.nombre,
      lastname: data.apellido,
      dni: data.dni,                        // opcional, ABSA cotiza sin él
      sexo: data.sexo,                      // OBLIGATORIO
      fecha_nacimiento: data.fechaNacimiento,
      codigo_postal: data.codigoPostal,
      provincia: data.provincia,
      localidad: data.localidad,
      marca_vehiculo: data.marca,
      modelo_vehiculo: data.modelo,
      version_vehiculo: data.version,       // lo que sale de Datacar
      anio_vehiculo: data.anio,
      patente: data.patente,
      cero_km: data.es0km,
    }),
    signal: AbortSignal.timeout(5000),
  });
} catch (err) {
  // Nunca romper el guardado del lead por esto: el lead ya está en HubSpot.
  console.error("No se pudo encolar la cotización ABSA", err);
}
```

Tres cosas que importan en Vercel:

1. **No fire-and-forget.** Una promesa sin `await` se corta cuando la función
   serverless devuelve la respuesta. Como el cotizador contesta `202` en
   milisegundos, `await` no agrega latencia perceptible. Si preferís no
   esperar nada, usá `waitUntil()` de `@vercel/functions` — pero no dejes la
   promesa suelta.
2. **El fallo del cotizador no puede tumbar el lead.** El `try/catch` de
   arriba no es decorativo: si el VPS está caído, el lead igual se guarda y
   la cotización se rehace después a mano.
3. **Reintentos son gratis.** Si el submit se manda dos veces, el segundo
   `POST` detecta que ese `dealId` ya tiene una cotización en vuelo, no
   encola nada y responde `{ ok: true, duplicado: true }`. Importa porque la
   sesión de ABSA es de a una por vez y cada duplicado costaría 3-4 minutos.

## 5. Deploy (VPS propio, always-on)

Un solo proceso Node (`npm run start:api` sobre el build de `npm run build`)
sirve `/health`, `/webhooks/hubspot/absa` y el `LeadWorker` — no hace falta un
proceso separado ni infra de colas externa (Redis, etc.) al volumen esperado de
un formulario de broker.

Sugerido: correrlo bajo `systemd` (o `pm2`) para que se reinicie solo si
crashea, con `.session/`, `.queue/` y `config/*.json` (los no versionados)
persistidos en disco junto al código — son justamente los que sobreviven a
un restart del proceso sin perder la sesión de ABSA ni los leads en cola.

**Por qué no serverless (Vercel/Lambda).** Este servicio necesita disco
persistente (la sesión de ABSA y la cola) y corridas de 3-4 minutos por job:
son justo las dos cosas que una función serverless no da. El formulario sí
vive bien en Vercel; el cotizador va en el droplet.

Concretamente, en un droplet de DigitalOcean (el más chico alcanza: esto es
I/O contra ABSA, no CPU):

- Node 20+, el repo clonado, `npm ci && npm run build`.
- `.env` con las credenciales de ABSA, `HUBSPOT_ACCESS_TOKEN` y
  `HUBSPOT_WEBHOOK_SECRET` (permisos `600`).
- Un servicio `systemd` con `Restart=always` corriendo `npm run start:api`.
- Nginx (o Caddy) por delante con TLS, y el firewall dejando pasar solo 80/443
  y SSH. El endpoint `/webhooks/hubspot/absa` queda público pero exige el
  header `x-webhook-secret`; conviene además limitarlo por IP si el único que
  lo llama es el backend del formulario.
- Backup de `.queue/` y `.session/`: la cola tiene PII de leads (mismo trato
  que un secreto).

**Capacidad.** El worker procesa de a un job por vez porque la sesión de ABSA
es una sola: ~3-4 minutos por cotización, del orden de 15-20 por hora. Con el
volumen de un formulario alcanza. Si en algún momento no alcanza, la salida
no es subir la concurrencia contra la misma cuenta (parecería tráfico
anómalo) sino un segundo usuario de ABSA con su propia sesión y un worker por
usuario.

## 6. Probar el webhook a mano

```bash
curl -X POST https://TU-SERVIDOR/webhooks/hubspot/absa \
  -H "Content-Type: application/json" \
  -H "x-webhook-secret: $HUBSPOT_WEBHOOK_SECRET" \
  -d '{
    "dealId": "777",
    "contactId": "12345",
    "firstname": "Juan",
    "lastname": "Perez",
    "dni": "30123456",
    "codigo_postal": "1425",
    "marca_vehiculo": "Fiat",
    "modelo_vehiculo": "Argo",
    "anio_vehiculo": "2022"
  }'
```

Respuesta esperada: `202 { "ok": true, "jobId": "..." }`. Un rato después
(según `QUEUE_POLL_INTERVAL_MS` + lo que tarde ABSA) el Deal `777` en
HubSpot debería tener `absa_estado=ok` y una Nota nueva con el PDF adjunto —
si en cambio el `dealId` de la prueba no existe en tu portal, `updateDealProperties`
va a fallar con un 404 y el job va a quedar reintentando hasta agotar
`QUEUE_MAX_ATTEMPTS`; usá un `dealId` real de tu portal para probar.
