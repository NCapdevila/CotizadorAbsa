/**
 * El servicio HTTP: recibe leads del formulario y los cotiza en segundo plano.
 *
 * Expone dos rutas y nada mas:
 *
 *   GET  /health                  — chequeo de vida (nginx / monitoreo)
 *   POST /webhooks/hubspot/absa   — recibe un Deal ya creado y encola su cotizacion
 *
 * El resultado NO viaja en la respuesta del webhook: se escribe en el Deal de
 * HubSpot 3-4 minutos despues (ver src/queue/worker.ts y
 * docs/hubspot-integration.md). Para cotizar a mano esta el CLI
 * (`npm run cotizar`), que no necesita este servidor.
 */
import express, { type NextFunction, type Request, type Response } from "express";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { JobQueue } from "../queue/jobQueue.js";
import { createDefaultLeadWorker } from "../queue/worker.js";
import { isValidWebhookSecret } from "../integrations/hubspot/webhookAuth.js";
import { hubspotLeadWebhookSchema } from "../integrations/hubspot/webhookSchema.js";
import { HubspotClient } from "../integrations/hubspot/client.js";
import { enProcesoDealProperties } from "../integrations/hubspot/mapper.js";
import { LeadSweeper } from "../integrations/hubspot/leadSweeper.js";

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "absa-cotizador", time: new Date().toISOString() });
});

// --- Integracion HubSpot (ver docs/hubspot-integration.md) ---
// Se monta solo si esta configurada (token + secreto de webhook). Sin eso el
// proceso levanta igual y sirve /health, pero no hay nada que cotizar.
const hubspotEnabled = Boolean(config.HUBSPOT_ACCESS_TOKEN && config.HUBSPOT_WEBHOOK_SECRET);

if (hubspotEnabled) {
  const leadQueue = new JobQueue(config.QUEUE_STORE_PATH);
  const hubspotClient = new HubspotClient();
  const leadWorker = createDefaultLeadWorker(leadQueue);
  leadWorker.start();

  // Red de seguridad para los leads cuyo webhook no llega. Comparte la MISMA
  // JobQueue que el webhook, que es lo que evita cotizar dos veces el mismo
  // Deal. Apagado por default: ver HUBSPOT_BARRIDO en src/config.ts.
  if (config.HUBSPOT_BARRIDO) {
    new LeadSweeper({ queue: leadQueue }).start();
  } else {
    logger.info("Barrido de Deals sin cotizar apagado (HUBSPOT_BARRIDO). Los leads dependen solo del webhook.");
  }

  app.post("/webhooks/hubspot/absa", async (req: Request, res: Response) => {
    // Se loguea ANTES de validar nada. Sin esta linea no habia forma de
    // responder "¿el webhook llego?" mirando nuestros logs: un lead que no
    // aparecia podia ser HubSpot que no disparo, o nosotros que lo tiramos.
    // El 2026-08-28 hubo que ir al access.log de nginx para distinguirlo.
    //
    // Va el dealId y nada mas del body: el payload trae PII del lead (nombre,
    // DNI, fecha de nacimiento) y estos logs se leen a mano todo el tiempo.
    logger.info(
      { dealId: typeof req.body?.dealId === "string" ? req.body.dealId : "(sin dealId)", ip: req.ip },
      "Webhook de HubSpot recibido",
    );

    if (!isValidWebhookSecret(req.header("x-webhook-secret"))) {
      logger.warn({ ip: req.ip }, "Webhook de HubSpot rechazado: secreto invalido o ausente");
      res.status(401).json({ ok: false, error: "secreto_invalido" });
      return;
    }

    const parsed = hubspotLeadWebhookSchema.safeParse(req.body);
    if (!parsed.success) {
      // Antes esto devolvia 400 sin dejar rastro: el lead se perdia en silencio
      // y no habia con que reclamarle al workflow de HubSpot.
      logger.warn(
        { ip: req.ip, errores: parsed.error.issues.map((i) => `${i.path.join(".") || "(raiz)"}: ${i.message}`) },
        "Webhook de HubSpot rechazado: el payload no tiene la forma esperada",
      );
      res.status(400).json({ ok: false, error: "payload_invalido", detalles: parsed.error.flatten() });
      return;
    }

    // El try/catch envuelve todo el handler a proposito: Express 4 NO atrapa el
    // rechazo de un handler async, y una promesa sin manejar tumba el proceso
    // en Node 20. Un disco lleno o un .queue/ corrupto no puede dejar sin
    // servicio al formulario entero.
    try {
      // Se responde de inmediato (202): la cotizacion se procesa async en el
      // LeadWorker, para no bloquear al formulario esperando los 3-4 minutos
      // que tarda el flujo completo contra ABSA net.
      const { job, duplicado } = await leadQueue.enqueue(parsed.data);
      if (duplicado) {
        logger.info({ jobId: job.id, dealId: parsed.data.dealId }, "Ese Deal ya tenia una cotizacion en vuelo, no se encola de nuevo");
        res.status(202).json({ ok: true, jobId: job.id, duplicado: true });
        return;
      }

      logger.info({ jobId: job.id, contactId: parsed.data.contactId }, "Lead de HubSpot encolado para cotizar");

      // Marca el Deal como "cotizando" apenas se encola: sin esto las
      // propiedades de ABSA quedan vacias durante los minutos que tarda, y no
      // hay forma de distinguir "todavia no llego" de "fallo en silencio".
      // No bloquea la respuesta: si HubSpot no acepta la escritura, el lead ya
      // esta encolado igual y el worker va a escribir el estado final.
      try {
        await hubspotClient.updateDealProperties(parsed.data.dealId, enProcesoDealProperties().properties);
      } catch (err) {
        logger.warn({ err, dealId: parsed.data.dealId }, "No se pudo marcar el Deal como en proceso (sigue encolado igual)");
      }

      res.status(202).json({ ok: true, jobId: job.id });
    } catch (err) {
      logger.error({ err, dealId: parsed.data.dealId }, "No se pudo encolar el lead");
      res.status(500).json({
        ok: false,
        error: "no_se_pudo_encolar",
        mensaje: err instanceof Error ? err.message : String(err),
      });
    }
  });
} else {
  logger.warn(
    "Integracion HubSpot deshabilitada (falta HUBSPOT_ACCESS_TOKEN y/o HUBSPOT_WEBHOOK_SECRET) — " +
      "no se monta POST /webhooks/hubspot/absa. Ver docs/hubspot-integration.md.",
  );
}

// Red de seguridad para cualquier error que se escape de un handler.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  logger.error({ err }, "Error no manejado en el servidor");
  res.status(500).json({ ok: false, error: "error_interno" });
});

app.listen(config.PORT, () => {
  logger.info({ port: config.PORT }, "absa-cotizador escuchando");
});

export { app };
