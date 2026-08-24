// Env de test, seteado ANTES de que cualquier test importe src/config.ts
// (que valida y congela process.env al importarse).
process.env.ABSA_USER = "test-user";
process.env.ABSA_PASSWORD = "test-password";
process.env.ABSA_BASE_URL = "https://absanet.test";
process.env.ABSA_SESSION_STORE_PATH = ".session/test-session.json";
process.env.LOG_LEVEL = "silent";
process.env.ABSA_MIN_REQUEST_INTERVAL_MS = "0";
process.env.ABSA_MAX_RETRIES = "1";
process.env.PORT = "3001";
process.env.ABSA_COMERCIAL_TEMPLATE_PATH = "tests/fixtures/absa-comercial.test.json";
// Explicito en vacio: dotenv NO pisa lo que ya esta en process.env, pero SI
// completa lo que falta — sin esta linea, un ABSA_ASEGURADORAS_EXCLUIDAS en el
// .env de la maquina se cuela en los tests y les cambia la plantilla debajo.
process.env.ABSA_ASEGURADORAS_EXCLUIDAS = "";
// Idem: explicito, para que los tests del adjunto no dependan de si la maquina
// lo tiene prendido o apagado. Los que prueban el PDF apagado lo fuerzan por
// dependencia (LeadWorkerDeps.adjuntarPdf).
process.env.HUBSPOT_ADJUNTAR_PDF = "true";

// --- Fase 6: integracion HubSpot ---
process.env.HUBSPOT_ACCESS_TOKEN = "test-hubspot-token";
process.env.HUBSPOT_WEBHOOK_SECRET = "test-webhook-secret";
process.env.HUBSPOT_API_BASE_URL = "https://api.hubspot.test";
process.env.HUBSPOT_PROPERTIES_PATH = "tests/fixtures/hubspot-properties.test.json";
process.env.QUEUE_STORE_PATH = ".queue/test-leads.json";
process.env.QUEUE_POLL_INTERVAL_MS = "50";
process.env.QUEUE_MAX_ATTEMPTS = "2";

import nock from "nock";

// Nunca permitir que un test pegue a la red real por accidente. Cualquier
// request no mockeada con nock explota en vez de salir a internet.
nock.disableNetConnect();
