import { afterEach, describe, expect, it } from "vitest";
import { isValidWebhookSecret } from "../src/integrations/hubspot/webhookAuth.js";
import { config } from "../src/config.js";

describe("isValidWebhookSecret", () => {
  const originalSecret = config.HUBSPOT_WEBHOOK_SECRET;
  afterEach(() => {
    config.HUBSPOT_WEBHOOK_SECRET = originalSecret;
  });

  it("acepta el header cuando coincide con el secreto configurado", () => {
    expect(isValidWebhookSecret(config.HUBSPOT_WEBHOOK_SECRET)).toBe(true);
  });

  it("rechaza un valor distinto", () => {
    expect(isValidWebhookSecret("otro-valor")).toBe(false);
  });

  it("rechaza si no se manda el header", () => {
    expect(isValidWebhookSecret(undefined)).toBe(false);
  });

  it("es fail-closed: si HUBSPOT_WEBHOOK_SECRET no esta configurado, rechaza cualquier cosa", () => {
    config.HUBSPOT_WEBHOOK_SECRET = "";
    expect(isValidWebhookSecret("cualquier-cosa")).toBe(false);
  });
});
