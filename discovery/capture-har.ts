/**
 * Fase 0.1 — Captura de HAR.
 *
 * Abre un browser VISIBLE (headed) contra ABSA net y graba todo el trafico
 * de red de la sesion a un archivo .har. Un humano (vos) hace login manual
 * y completa un flujo de cotizacion de punta a punta; el script no toca
 * credenciales ni interactua con el sitio por su cuenta.
 *
 * IMPORTANTE: el HAR resultante contiene credenciales y cookies de sesion
 * reales en texto plano. discovery/output/ esta en .gitignore desde el
 * primer commit — nunca lo saques de ahi.
 *
 * Uso:
 *   npm run discovery:capture
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, "output");
const BASE_URL = process.env.ABSA_BASE_URL ?? "https://www.absanet.net";

function waitForEnter(prompt: string): Promise<void> {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", () => {
      process.stdin.pause();
      resolve();
    });
  });
}

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const harPath = path.join(OUTPUT_DIR, `absa-session-${Date.now()}.har`);

  console.log("=== Fase 0: captura de HAR ===");
  console.log(`Destino: ${harPath}`);
  console.log("");
  console.log("Se va a abrir un browser visible. Segui estos pasos EN ORDEN:");
  console.log("");
  console.log("  1. Login con tu usuario/contrasena de broker en ABSA net.");
  console.log("  2. Cotiza un AUTO (no otro ramo): busca marca/modelo/anio en el");
  console.log("     buscador de vehiculos, completa los datos del cliente y el");
  console.log("     codigo postal, y selecciona TODAS las aseguradoras con las que");
  console.log("     trabajas habitualmente (de ahi sale la config comercial).");
  console.log("  3. Espera a que la comparativa termine de cargar los premios.");
  console.log("  4. GUARDA la cotizacion (el boton de guardar de ABSA net). Este paso");
  console.log("     es el que nos deja ver el endpoint de guardado -- sin el, hay que");
  console.log("     repetir toda la captura.");
  console.log("  5. Volve a esta terminal y presiona ENTER para cerrar y guardar el HAR.");
  console.log("");
  console.log("Tip: si algo sale mal a mitad de camino, no pasa nada -- terminá el flujo");
  console.log("igual y volvé a correr esto. Un HAR de mas no molesta (se usa el mas nuevo).");
  console.log("");
  console.log("IMPORTANTE: el HAR va a contener tus credenciales y cookies de sesion");
  console.log("en texto plano. NUNCA lo commitees (discovery/output/ ya esta en .gitignore).");
  console.log("");

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    recordHar: { path: harPath, mode: "full", content: "embed" },
    viewport: { width: 1400, height: 900 },
  });
  const page = await context.newPage();
  await page.goto(BASE_URL);

  await waitForEnter("\nPresiona ENTER cuando termines el login + la cotizacion...\n");

  // Cerrar el context es lo que efectivamente flushea el HAR a disco.
  await context.close();
  await browser.close();

  console.log(`\nListo. HAR guardado en: ${harPath}`);
  console.log("Siguiente paso: npm run discovery:comercial");
  console.log("  (extrae config/absa-comercial.json y busca el endpoint de guardado)");
}

main().catch((err) => {
  console.error("Error durante la captura:", err);
  process.exit(1);
});
