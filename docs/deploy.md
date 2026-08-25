# Deploy en `api.cebrokers.com.ar`

Ajustado al droplet `call-hubspot`, que ya tiene nginx con SSL para
`api.cebrokers.com.ar` apuntando a `localhost:3000`, Node 20, git, pm2 y
certbot. **No hay que tocar nginx, certbot ni el firewall.** Las apps viven en
`/root/apps/` como root vía pm2, y seguimos esa convención.

## Paso 0 (antes de todo): que ABSA habilite la IP

**ABSA net filtra por lista blanca de IPs.** Desde una IP no habilitada corta
con `403` en la primera request, antes de ver usuario y contraseña — o sea
que el servicio despliega bien, arranca bien, y **ningún lead cotiza**.

```bash
curl -s ifconfig.me        # la IP publica del droplet
```

Con ese número, pedirle a ABSA que lo agreguen. Para verificar que ya está:

```bash
curl -sI https://www.absanet.net/ | head -1
# HTTP/2 200  -> habilitada
# HTTP/2 403  -> todavia no
```

Si el droplet cambia de IP (lo destruís y recreás, o le ponés una floating IP),
hay que pedir la habilitación de nuevo.

## Qué vas a dejar corriendo

Un proceso Node que expone **dos rutas** y nada más:

| Ruta | Para qué |
|---|---|
| `GET /health` | Chequeo de vida |
| `POST /webhooks/hubspot/absa` | Recibe un Deal ya creado y encola su cotización (header `x-webhook-secret`) |

El webhook responde `202` al instante; la cotización tarda 3-4 minutos y el
resultado se escribe en el Deal de HubSpot. Nada más queda expuesto.

---

## 1. Clonar

```bash
cd /root/apps
git clone https://github.com/NCapdevila/CotizadorAbsa.git
cd CotizadorAbsa
```

## 2. Instalar y compilar

`npm ci` completo (con devDependencies): `tsc` es devDependency y hace falta
para compilar. Se saltea la descarga de Chromium, que solo usa el fallback de
login por Playwright.

```bash
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
npm ci
npm run build      # compila src/ -> dist/api/server.js
```

Verificá que exista lo que vas a arrancar:

```bash
ls dist/api/server.js
```

## 3. El `.env`

```bash
nano .env
chmod 600 .env     # tiene credenciales del broker y el token de HubSpot
```

Contenido:

```ini
# --- ABSA ---
ABSA_USER=usuario_del_broker
ABSA_PASSWORD=contraseña_del_broker
ABSA_ASEGURADORAS_EXCLUIDAS=SANCOR

# --- Servicio ---
PORT=3000
NODE_ENV=production
LOG_LEVEL=info

# --- HubSpot ---
# OJO: sin ESTAS DOS el webhook NO se monta. El servicio arranca igual,
# /health responde 200 y /webhooks/hubspot/absa devuelve 404.
HUBSPOT_ACCESS_TOKEN=...
HUBSPOT_WEBHOOK_SECRET=...
HUBSPOT_ADJUNTAR_PDF=false
```

La lista completa de variables (todas opcionales salvo usuario y contraseña)
está en el README.

## 4. Los archivos de config

Ninguno se versiona (tienen la config comercial del broker y el mapeo del
portal). Los dos primeros son **obligatorios**: sin `hubspot-properties.json`,
cada lead se cotiza los 3-4 minutos y recién ahí falla al escribir el Deal, y
reintenta tres veces.

```bash
mkdir -p config
nano config/absa-comercial.json       # pegar el de tu máquina
nano config/hubspot-properties.json   # pegar el de tu máquina
nano config/absa-productores.json     # solo si el formulario manda `productor`
```

`config/absa-productores.json` mapea la lista de productores del formulario a
IDs de ABSA (ver el README, sección "Cotizar con el productor del formulario").
Es **opcional** en el sentido de que sin él nada se rompe: todo cotiza con el
productor de `absa-comercial.json`. Con él, cada lead cotiza con el suyo y lo
que no esté mapeado cae igual a ese default.

`config/hubspot-properties.json` tiene que quedar así (son las cuatro
propiedades que existen hoy en el portal):

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

## 5. Probar antes de pm2

```bash
npm run smoke-test
```

Fuerza un login nuevo y consulta el catálogo: en ~3 segundos te dice si las
credenciales y ABSA responden. Tiene que terminar en `OK — ...` y exit code 0.
No cotiza ni deja nada registrado.

Después, el servidor:

```bash
node dist/api/server.js
```

Tenés que ver `absa-cotizador escuchando` **y** `LeadWorker arrancado`. Si en
vez de eso aparece `Integracion HubSpot deshabilitada`, faltan las dos
variables de HubSpot del paso 3.

Desde otra sesión SSH:

```bash
curl localhost:3000/health
curl -X POST localhost:3000/webhooks/hubspot/absa -o /dev/null -w '%{http_code}\n'
# 401 = la ruta existe y pide secreto  ✓
# 404 = el webhook no se montó → revisar el .env
```

Cortá con `Ctrl+C`.

## 6. Dejarlo corriendo con pm2

El `--cwd` no es opcional: todas las rutas de config son relativas
(`.session/`, `.queue/`, `config/`). Sin él, el proceso escribe la sesión y la
cola donde no va.

```bash
cd /root/apps/CotizadorAbsa
pm2 start dist/api/server.js --name absa-cotizador --cwd /root/apps/CotizadorAbsa
pm2 save
pm2 logs absa-cotizador --lines 20
```

No hace falta `pm2 startup`: `pm2-root.service` ya está activo y levanta lo
guardado con `pm2 save` al reiniciar el droplet.

## 7. Verificación desde afuera

```bash
curl https://api.cebrokers.com.ar/health
curl -X POST https://api.cebrokers.com.ar/webhooks/hubspot/absa -o /dev/null -w '%{http_code}\n'
```

El `401` del segundo es la señal de que el deploy sirvió: `/health` responde
igual con el webhook desmontado, así que por sí solo no prueba nada.

## 8. La prueba de verdad: un lead real

Con un `dealId` que exista en HubSpot:

```bash
curl -X POST https://api.cebrokers.com.ar/webhooks/hubspot/absa \
  -H 'Content-Type: application/json' \
  -H 'x-webhook-secret: TU_SECRETO' \
  -d '{"dealId":"123456","firstname":"Test","lastname":"Prueba","sexo":"M",
       "fecha_nacimiento":"1990-01-15","codigo_postal":"1425",
       "marca_vehiculo":"CHEVROLET","modelo_vehiculo":"TRACKER",
       "version_vehiculo":"1.2 TURBO AT PREMIER","anio_vehiculo":"2021"}'
```

Qué tiene que pasar:

1. Responde `202` al instante.
2. El Deal queda con `absa_estado = en_proceso` enseguida.
3. A los 3-4 minutos: `absa_estado = ok`, `absa_numero_cotizacion` y
   `cotizacion_absa` con el link para abrirla y recotizar en ABSA.

Si a los 5 minutos sigue en `en_proceso`, mirá `pm2 logs absa-cotizador`.

## 9. Después del deploy

**Rotación de logs** (con pm2 crecen sin techo):

```bash
pm2 install pm2-logrotate
```

**El canario.** Es lo que te avisa de credenciales vencidas o de un cambio en
ABSA antes que un lead. `crontab -e`:

```cron
0 8 * * * cd /root/apps/CotizadorAbsa && /usr/bin/npm run smoke-test >> /var/log/absa-smoke.log 2>&1
```

Cada tanto conviene además una cotización completa, que es lo único que
ejercita el parseo de las propuestas:

```bash
npm run cotizar -- --marca CHEVROLET --modelo TRACKER --version "1.2T AT PREMIER" \
  --anio 2021 --cp 1425 --sexo M --estadocivil 2 --nacimiento 1990-01-15 --sin-guardar
```

## 10. Actualizar

```bash
cd /root/apps/CotizadorAbsa
git pull
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
npm ci
npm run build
pm2 restart absa-cotizador
npm run smoke-test          # confirmar que sigue vivo
```

Los leads en cola (`.queue/leads.json`) sobreviven al restart; los que estaban
`processing` justo en ese momento quedan trabados en ese estado — se destraban
solos al agotar reintentos, o se editan a mano en el archivo.

## Apéndice: si NO habilitan la IP

Plan B, mientras tanto o para siempre: el servicio sigue en el droplet, pero
**el tráfico a ABSA sale por la IP de la oficina**, que ya está habilitada
(desde ahí funciona hoy). Un túnel SSH la presta.

### 1. Levantar el túnel desde la oficina

En una máquina de la oficina que quede prendida (Linux, macOS o WSL):

```bash
ssh -N -R 1080 root@IP_DEL_DROPLET
```

Eso deja un SOCKS escuchando en `127.0.0.1:1080` **del droplet**, cuyo tráfico
sale por la conexión de la oficina. No hay que abrir puertos en el router: la
conexión la inicia la oficina hacia afuera.

Para que se reconecte solo:

```bash
autossh -M 0 -f -N -R 1080   -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes   root@IP_DEL_DROPLET
```

Conviene dejarlo como servicio (systemd en Linux; en Windows, WSL con tarea
programada o NSSM).

### 2. Probar el túnel ANTES de tocar la app

En el droplet:

```bash
curl -sI --socks5-hostname 127.0.0.1:1080 https://www.absanet.net/ | head -1
# HTTP/2 200 -> el tunel funciona y esa IP esta habilitada
# HTTP/2 403 -> la IP de la oficina tampoco esta habilitada (raro: desde ahi anda)
# curl: (7)  -> el tunel no esta levantado
```

### 3. Prenderlo en el servicio

```ini
# .env
ABSA_PROXY_URL=socks5://127.0.0.1:1080
```

```bash
pm2 restart absa-cotizador
npm run smoke-test
```

Al arrancar tiene que loguear `Trafico a ABSA net saliendo por proxy`. Si no
aparece esa línea, la variable no se leyó y está saliendo directo.

### Rollback

Comentá la variable y reiniciá:

```bash
sed -i "s/^ABSA_PROXY_URL=/#ABSA_PROXY_URL=/" .env
pm2 restart absa-cotizador
npm run smoke-test
```

Con `ABSA_PROXY_URL` vacío el cliente HTTP es `got` sin modificar: no hay
agente, no hay diferencia con hoy. El día que habiliten la IP del droplet,
este es el único paso para volver atrás.

### Lo que hay que saber antes de elegir este camino

- **Si el túnel se cae, no se pierden leads**: quedan encolados y el worker
  reintenta. Pero si la caída dura, agotan `QUEUE_MAX_ATTEMPTS` y quedan como
  `error_absa` en el Deal. Con un túnel de por medio conviene subirlo a 5.
- Suma una dependencia al camino crítico: la máquina de la oficina y su
  internet pasan a ser parte de producción.
- La IP de la oficina tiene que ser estable. Si es dinámica y cambia, el
  túnel sigue funcionando (la conexión la inicia la oficina), pero ABSA va a
  ver la IP nueva y volvés al 403.

## Si algo falla

| Síntoma | Causa | Qué mirar |
|---|---|---|
| `/webhooks/hubspot/absa` → 404 | Falta `HUBSPOT_ACCESS_TOKEN` o `HUBSPOT_WEBHOOK_SECRET` | El log dice `Integracion HubSpot deshabilitada` |
| `/webhooks/hubspot/absa` → 401 con el header puesto | El secreto no coincide con el `.env` | — |
| `Cannot find module dist/api/server.js` | Falta `npm run build`, o quedó un build viejo | `ls dist/api/` |
| `Configuracion invalida` al arrancar | Falta `ABSA_USER`/`ABSA_PASSWORD` | El error lista qué falta |
| `No se encontro el archivo de config comercial` | Falta `config/absa-comercial.json` | Paso 4 |
| Cotizaciones que salen con el productor equivocado | El valor que manda el formulario no está en `config/absa-productores.json` (el match es exacto), así que cayó al productor por defecto. Se ve en el log: `El productor del lead no esta mapeado` | `npm run productores -- --buscar <nombre>` y agregar la entrada |
| El Deal se queda en `en_proceso` | El worker murió, o ABSA rechazó | `pm2 logs absa-cotizador` |
| `Las credenciales ingresadas son incorrectas` | Contraseña de ABSA cambiada o mal copiada | Entrar a mano a absanet.net antes de retocar el `.env` |
| `403 al pedir la pagina de login` | La IP del servidor no está habilitada en ABSA | Paso 0, o el apéndice del túnel |
| `connect ECONNREFUSED` al puerto del proxy | El túnel SSH se cayó | Apéndice, paso 1 |
| El PATCH a HubSpot da 400 | El mapeo apunta a una propiedad que no existe en el portal | `config/hubspot-properties.json` |
| Cotiza SANCOR | Falta `ABSA_ASEGURADORAS_EXCLUIDAS=SANCOR` | El log lista contra quiénes cotiza |

Los logs son JSON en stdout: `pm2 logs absa-cotizador`, o
`~/.pm2/logs/absa-cotizador-*.log`.
