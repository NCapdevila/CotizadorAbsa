import got from "got";
import { config } from "../../config.js";
import { logger } from "../../logger.js";

export interface CreateDealInput {
  properties: Record<string, string | number>;
  /** hs_object_id del Contact a asociar (asociacion default deal<->contact, API v4). */
  associatedContactId: string;
}

export interface AttachFileInput {
  buffer: Buffer;
  filename: string;
  contentType?: string;
}

/**
 * Cliente minimo para la API de HubSpot (CRM v3/v4 + Files v3), autenticado
 * con el token de una Private App (HUBSPOT_ACCESS_TOKEN). El Deal (y el
 * Contact) YA EXISTEN -- los crea el formulario del sitio, no este backend
 * (ver docs/hubspot-integration.md) -- por eso este cliente solo actualiza
 * propiedades de un Deal existente y le adjunta un archivo (una Nota con el
 * PDF de la cotizacion), nunca crea Deals ni Contacts.
 */
export class HubspotClient {
  constructor(
    private readonly accessToken = config.HUBSPOT_ACCESS_TOKEN,
    private readonly baseUrl = config.HUBSPOT_API_BASE_URL,
  ) {
    if (!this.accessToken) {
      throw new Error(
        "HUBSPOT_ACCESS_TOKEN vacio — no se puede escribir a HubSpot. " +
          "Completa esa env var con el token de una Private App (ver docs/hubspot-integration.md).",
      );
    }
  }

  private authHeaders() {
    return { Authorization: `Bearer ${this.accessToken}` };
  }

  /** PATCH de propiedades sobre un Deal EXISTENTE (no lo crea). */
  async updateDealProperties(dealId: string, properties: Record<string, string | number>): Promise<void> {
    const response = await got.patch(`${this.baseUrl}/crm/v3/objects/deals/${encodeURIComponent(dealId)}`, {
      headers: this.authHeaders(),
      json: { properties },
      throwHttpErrors: false,
    });

    if (response.statusCode >= 400) {
      throw new Error(`HubSpot rechazo la actualizacion del Deal ${dealId} (status ${response.statusCode}): ${response.body}`);
    }
    logger.info({ dealId }, "Propiedades del Deal actualizadas en HubSpot");
  }

  /** Sube un archivo al Files API de HubSpot (carpeta privada) y devuelve su id. */
  async uploadFile(file: AttachFileInput): Promise<string> {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(file.buffer)], { type: file.contentType ?? "application/octet-stream" }), file.filename);
    form.append("options", JSON.stringify({ access: "PRIVATE", overwrite: true }));
    form.append("folderPath", "/absa-cotizador");

    const response = await got.post(`${this.baseUrl}/files/v3/files`, {
      headers: this.authHeaders(),
      body: form,
      throwHttpErrors: false,
    });

    if (response.statusCode >= 400) {
      throw new Error(`HubSpot rechazo la subida del archivo "${file.filename}" (status ${response.statusCode}): ${response.body}`);
    }
    const uploaded = JSON.parse(response.body) as { id: string };
    return uploaded.id;
  }

  /** Crea una Nota con el/los archivo(s) adjuntos y la asocia (asociacion default) a un Deal EXISTENTE. */
  async attachNoteToDeal(dealId: string, fileIds: string[], noteBody: string): Promise<string> {
    const createResponse = await got.post(`${this.baseUrl}/crm/v3/objects/notes`, {
      headers: this.authHeaders(),
      json: {
        properties: {
          hs_timestamp: new Date().toISOString(),
          hs_note_body: noteBody,
          hs_attachment_ids: fileIds.join(";"),
        },
      },
      throwHttpErrors: false,
    });

    if (createResponse.statusCode >= 400) {
      throw new Error(`HubSpot rechazo la creacion de la nota (status ${createResponse.statusCode}): ${createResponse.body}`);
    }
    const note = JSON.parse(createResponse.body) as { id: string };

    const assocResponse = await got.put(
      `${this.baseUrl}/crm/v4/objects/note/${encodeURIComponent(note.id)}/associations/default/deal/${encodeURIComponent(dealId)}`,
      { headers: this.authHeaders(), throwHttpErrors: false },
    );
    if (assocResponse.statusCode >= 400) {
      throw new Error(
        `HubSpot rechazo la asociacion Note(${note.id}) <-> Deal(${dealId}) (status ${assocResponse.statusCode}): ${assocResponse.body}`,
      );
    }

    logger.info({ dealId, noteId: note.id, fileIds }, "Nota con adjunto creada y asociada al Deal en HubSpot");
    return note.id;
  }

  /** Atajo: sube el archivo y lo adjunta como Nota al Deal, en un solo paso. */
  async attachFileToDeal(dealId: string, file: AttachFileInput, noteBody: string): Promise<void> {
    const fileId = await this.uploadFile(file);
    await this.attachNoteToDeal(dealId, [fileId], noteBody);
  }
}
