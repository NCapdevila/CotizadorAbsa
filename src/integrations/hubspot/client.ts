import got from "got";
import { config } from "../../config.js";
import { logger } from "../../logger.js";
import { loadHubspotProperties } from "./propertiesConfig.js";
import { PROPIEDADES_DE_CONTACT, PROPIEDADES_DE_DEAL } from "./leadSweeperMapper.js";

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

  /** GET generico contra la API de HubSpot, con el error ya interpretado. */
  private async getJson<T>(path: string, que: string): Promise<T> {
    const response = await got.get(`${this.baseUrl}${path}`, {
      headers: this.authHeaders(),
      throwHttpErrors: false,
      timeout: { request: 20_000 },
    });
    if (response.statusCode >= 400) {
      throw new Error(`HubSpot rechazo ${que} (status ${response.statusCode}): ${response.body.slice(0, 400)}`);
    }
    return JSON.parse(response.body) as T;
  }

  /**
   * Deals que todavia no cotizo nadie, para el barrido (ver ./leadSweeper.ts).
   *
   * Tres filtros, y los tres importan:
   * - `absa_estado` SIN valor: los que ya tienen `ok` o `error_*` fueron
   *   atendidos; volver a encolarlos seria recotizar en loop.
   * - `marca_vehiculo` CON valor: descarta los Deals del portal que no son de
   *   cotizacion de autos. Sin esto el barrido levanta cualquier Deal.
   * - `createdate` reciente: la ventana evita despertar leads viejos el dia
   *   que se prenda esto por primera vez.
   * - `tipo_riesgo`: este servicio solo cotiza AUTO. Una MOTO buscada en el
   *   catalogo de autos no encuentra nada y el lead muere como
   *   "error_catalogo_no_resuelto", que no es lo que paso.
   */
  async buscarDealsSinCotizar(
    desde: Date,
    limite: number,
    tipoRiesgo?: string,
  ): Promise<Array<{ id: string; properties: Record<string, string | null> }>> {
    const props = loadHubspotProperties().properties;
    if (!props.estado) {
      throw new Error(
        'El barrido necesita la propiedad "estado" mapeada en config/hubspot-properties.json: es como sabe que Deal falta cotizar.',
      );
    }

    const response = await got.post(`${this.baseUrl}/crm/v3/objects/deals/search`, {
      headers: this.authHeaders(),
      json: {
        filterGroups: [
          {
            filters: [
              { propertyName: props.estado, operator: "NOT_HAS_PROPERTY" },
              { propertyName: "marca_vehiculo", operator: "HAS_PROPERTY" },
              { propertyName: "createdate", operator: "GTE", value: String(desde.getTime()) },
              ...(tipoRiesgo ? [{ propertyName: "tipo_riesgo", operator: "EQ", value: tipoRiesgo }] : []),
            ],
          },
        ],
        sorts: [{ propertyName: "createdate", direction: "DESCENDING" }],
        properties: PROPIEDADES_DE_DEAL,
        limit: limite,
      },
      throwHttpErrors: false,
      timeout: { request: 20_000 },
    });
    if (response.statusCode >= 400) {
      throw new Error(`HubSpot rechazo la busqueda de Deals sin cotizar (status ${response.statusCode}): ${response.body.slice(0, 400)}`);
    }
    const parsed = JSON.parse(response.body) as { results?: Array<{ id: string; properties: Record<string, string | null> }> };
    return parsed.results ?? [];
  }

  /**
   * El Contact asociado al Deal. Devuelve `undefined` si no hay ninguno: el
   * lead no se puede cotizar sin el (ahi viven DNI, fecha de nacimiento, sexo
   * y codigo postal), pero eso lo decide el llamador.
   */
  async contactoDeDeal(dealId: string): Promise<string | undefined> {
    const parsed = await this.getJson<{ results?: Array<{ toObjectId: string | number }> }>(
      `/crm/v4/objects/deals/${encodeURIComponent(dealId)}/associations/contacts`,
      `las asociaciones del Deal ${dealId}`,
    );
    const primero = parsed.results?.[0]?.toObjectId;
    return primero === undefined ? undefined : String(primero);
  }

  /**
   * Propiedades del Contact.
   *
   * OJO: se piden EXPLICITAMENTE. Pedir el contacto sin `?properties=` hace
   * que HubSpot devuelva las default y, si el portal tiene alguna marcada como
   * sensible, rechaza la llamada entera pidiendo
   * `crm.objects.contacts.sensitive.read.v2` — con la lista explicita anda con
   * el `crm.objects.contacts.read` de siempre.
   */
  async leerContacto(contactId: string): Promise<Record<string, string | null>> {
    const parsed = await this.getJson<{ properties?: Record<string, string | null> }>(
      `/crm/v3/objects/contacts/${encodeURIComponent(contactId)}?properties=${PROPIEDADES_DE_CONTACT.join(",")}`,
      `la lectura del Contact ${contactId}`,
    );
    return parsed.properties ?? {};
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
