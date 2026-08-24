import { afterEach, beforeEach, describe, expect, it } from "vitest";
import nock from "nock";
import { HubspotClient } from "../src/integrations/hubspot/client.js";
import { config } from "../src/config.js";

describe("HubspotClient.updateDealProperties", () => {
  beforeEach(() => nock.cleanAll());
  afterEach(() => nock.cleanAll());

  it("hace PATCH sobre el Deal existente (no lo crea)", async () => {
    const scope = nock(config.HUBSPOT_API_BASE_URL)
      .patch("/crm/v3/objects/deals/777", (body) => body.properties.absa_estado === "ok")
      .reply(200, { id: "777" });

    await new HubspotClient().updateDealProperties("777", { absa_estado: "ok" });
    expect(scope.isDone()).toBe(true);
  });

  it("tira error si HubSpot rechaza la actualizacion", async () => {
    nock(config.HUBSPOT_API_BASE_URL).patch("/crm/v3/objects/deals/777").reply(404, "not found");

    await expect(new HubspotClient().updateDealProperties("777", {})).rejects.toThrow(/rechazo la actualizacion/i);
  });
});

describe("HubspotClient.uploadFile / attachNoteToDeal / attachFileToDeal", () => {
  beforeEach(() => nock.cleanAll());
  afterEach(() => nock.cleanAll());

  it("sube el archivo, crea la nota con el adjunto y la asocia al Deal", async () => {
    const uploadScope = nock(config.HUBSPOT_API_BASE_URL).post("/files/v3/files").reply(201, { id: "file-1" });
    const noteScope = nock(config.HUBSPOT_API_BASE_URL)
      .post("/crm/v3/objects/notes", (body) => body.properties.hs_attachment_ids === "file-1")
      .reply(201, { id: "note-1" });
    const assocScope = nock(config.HUBSPOT_API_BASE_URL)
      .put("/crm/v4/objects/note/note-1/associations/default/deal/777")
      .reply(204);

    await new HubspotClient().attachFileToDeal(
      "777",
      { buffer: Buffer.from("PDF"), filename: "cotizacion.pdf", contentType: "application/pdf" },
      "nota de prueba",
    );

    expect(uploadScope.isDone()).toBe(true);
    expect(noteScope.isDone()).toBe(true);
    expect(assocScope.isDone()).toBe(true);
  });

  it("tira error si HubSpot rechaza la subida del archivo", async () => {
    nock(config.HUBSPOT_API_BASE_URL).post("/files/v3/files").reply(400, "archivo invalido");

    await expect(
      new HubspotClient().attachFileToDeal("777", { buffer: Buffer.from("x"), filename: "x.pdf" }, "nota"),
    ).rejects.toThrow(/rechazo la subida/i);
  });

  it("tira error si HubSpot rechaza la creacion de la nota", async () => {
    nock(config.HUBSPOT_API_BASE_URL).post("/files/v3/files").reply(201, { id: "file-1" });
    nock(config.HUBSPOT_API_BASE_URL).post("/crm/v3/objects/notes").reply(400, "nota invalida");

    await expect(
      new HubspotClient().attachFileToDeal("777", { buffer: Buffer.from("x"), filename: "x.pdf" }, "nota"),
    ).rejects.toThrow(/rechazo la creacion de la nota/i);
  });

  it("tira error si HubSpot rechaza la asociacion Nota-Deal", async () => {
    nock(config.HUBSPOT_API_BASE_URL).post("/files/v3/files").reply(201, { id: "file-1" });
    nock(config.HUBSPOT_API_BASE_URL).post("/crm/v3/objects/notes").reply(201, { id: "note-1" });
    nock(config.HUBSPOT_API_BASE_URL).put("/crm/v4/objects/note/note-1/associations/default/deal/777").reply(404, "not found");

    await expect(
      new HubspotClient().attachFileToDeal("777", { buffer: Buffer.from("x"), filename: "x.pdf" }, "nota"),
    ).rejects.toThrow(/rechazo la asociacion/i);
  });
});
