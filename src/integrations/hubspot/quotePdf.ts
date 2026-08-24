import PDFDocument from "pdfkit";
import type { CotizacionInput, CotizacionResult } from "../../quote/types.js";

/**
 * Genera un PDF resumen de la cotizacion (comparativa por aseguradora/plan)
 * para adjuntar al Deal en HubSpot -- ver src/integrations/hubspot/client.ts
 * (uploadFile + attachNoteToDeal) y docs/hubspot-integration.md.
 *
 * Deliberadamente simple (texto plano, sin logos ni diseño de marca): el
 * objetivo es que el broker tenga el detalle a mano en el Deal, no
 * reemplazar un PDF "lindo" para mandarle al cliente final.
 */
export function buildCotizacionPdf(input: CotizacionInput, result: CotizacionResult): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fontSize(18).text("Cotización de seguro automotor — ABSA net", { align: "left" });
    doc.moveDown(0.5);
    doc.fontSize(10).fillColor("#666").text(`Generado el ${new Date(result.obtenidoEn).toLocaleString("es-AR")}`);
    if (result.numeroCotizacion) {
      doc.text(`Número de cotización ABSA: ${result.numeroCotizacion}`);
    }
    doc.fillColor("#000");
    doc.moveDown();

    doc.fontSize(13).text("Asegurado");
    doc.fontSize(10);
    // El documento es opcional: sin el, no se imprime el renglon a medias.
    const documento = input.asegurado.documentoNumero
      ? ` — ${input.asegurado.documentoTipo ?? "DNI"} ${input.asegurado.documentoNumero}`
      : "";
    doc.text(`${input.asegurado.nombre} ${input.asegurado.apellido}${documento}`.trim());
    doc.moveDown();

    if (input.objetoAsegurado.vehiculo) {
      const v = input.objetoAsegurado.vehiculo;
      doc.fontSize(13).text("Vehículo");
      doc.fontSize(10);
      doc.text(`${v.marca} ${v.modelo} ${v.anio}${v.version ? ` — ${v.version}` : ""}`);
      doc.moveDown();
    }

    doc.fontSize(13).text("Opciones cotizadas");
    doc.moveDown(0.3);

    const opciones = [...result.opciones].sort((a, b) => a.premio - b.premio);
    const formatter = new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 2 });

    doc.fontSize(10);
    for (const opcion of opciones) {
      doc.text(`${opcion.plan}`, { continued: false });
      doc.fillColor("#333").text(`   ${formatter.format(opcion.premio)}`, { continued: false });
      doc.fillColor("#000");
      doc.moveDown(0.2);
    }

    if (opciones.length === 0) {
      doc.text("No se obtuvieron opciones parseables — revisar absa_error_mensaje en el Deal.");
    }

    doc.end();
  });
}
