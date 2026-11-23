import { createHmac } from "node:crypto";
import { describe, it, expect, vi } from "vitest";
import {
  sendWhatsAppTemplate,
  WhatsAppCloudApiProvider,
  NotConfiguredWhatsAppCloudApiProvider,
  WhatsAppApiError,
  resolveWhatsAppCredential,
  buildWhatsAppProviderForTenant,
  verifyWhatsAppWebhookSubscription,
  verifyWhatsAppWebhookSignature,
  parseWhatsAppDeliveryStatusEvents,
} from "../src/lib/whatsAppProvider.js";

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

describe("sendWhatsAppTemplate", () => {
  it("POSTs a real template-message payload and returns the real provider message id", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ messages: [{ id: "wamid.real-id" }] }));
    const result = await sendWhatsAppTemplate(
      { phoneNumberId: "pn-1", accessToken: "access-tok" },
      { to: "+15551234567", templateName: "hello_world", parameters: ["Jane"] },
      { fetcher },
    );
    expect(result).toEqual({ messageId: "wamid.real-id" });
    expect(fetcher).toHaveBeenCalledWith(
      "https://graph.facebook.com/v19.0/pn-1/messages",
      expect.objectContaining({ method: "POST", headers: expect.objectContaining({ Authorization: "Bearer access-tok" }) }),
    );
    const sentBody = JSON.parse((fetcher.mock.calls[0][1] as RequestInit).body as string);
    expect(sentBody.template.name).toBe("hello_world");
    expect(sentBody.template.components[0].parameters[0]).toEqual({ type: "text", text: "Jane" });
  });

  it("throws rather than fabricating a message id when WhatsApp's response has none", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ messages: [] }));
    await expect(
      sendWhatsAppTemplate({ phoneNumberId: "pn-1", accessToken: "access-tok" }, { to: "+15551234567", templateName: "hello_world" }, { fetcher }),
    ).rejects.toThrow(/fabricated/);
  });

  it("throws WhatsAppApiError on a real Graph API failure", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ error: { message: "Invalid phone number" } }, 400));
    await expect(
      sendWhatsAppTemplate({ phoneNumberId: "pn-1", accessToken: "access-tok" }, { to: "bad", templateName: "hello_world" }, { fetcher }),
    ).rejects.toThrow(WhatsAppApiError);
  });
});

describe("WhatsAppCloudApiProvider", () => {
  it("sendTemplateMessage returns the real messageId, never a fabricated delivery receipt", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ messages: [{ id: "wamid.abc" }] }));
    const original = globalThis.fetch;
    // @ts-expect-error -- test-only global fetch stub
    globalThis.fetch = fetcher;
    try {
      const provider = new WhatsAppCloudApiProvider({ phoneNumberId: "pn-1", accessToken: "access-tok" });
      const result = await provider.sendTemplateMessage({ to: "+15551234567", templateName: "hello_world" });
      expect(result).toEqual({ provider: "whatsapp_business", messageId: "wamid.abc", sentAt: expect.any(String) });
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("NotConfiguredWhatsAppCloudApiProvider / resolveWhatsAppCredential / buildWhatsAppProviderForTenant", () => {
  it("resolveWhatsAppCredential returns null when no credential is configured (this environment's real state)", async () => {
    const db = { query: vi.fn().mockResolvedValue({ rowCount: 0, rows: [] }) };
    const credential = await resolveWhatsAppCredential(db as never, "tenant-1", "project-1");
    expect(credential).toBeNull();
  });

  it("buildWhatsAppProviderForTenant returns the NotConfigured stub, which never fabricates a delivery result", async () => {
    const db = { query: vi.fn().mockResolvedValue({ rowCount: 0, rows: [] }) };
    const provider = await buildWhatsAppProviderForTenant(db as never, "tenant-1", "project-1");
    expect(provider).toBeInstanceOf(NotConfiguredWhatsAppCloudApiProvider);
    await expect(provider.sendTemplateMessage({ to: "+15551234567", templateName: "hello_world" })).rejects.toThrow(/not configured/i);
  });
});

describe("verifyWhatsAppWebhookSubscription", () => {
  it("echoes hub.challenge when hub.mode=subscribe and the verify token matches", () => {
    const challenge = verifyWhatsAppWebhookSubscription(
      { "hub.mode": "subscribe", "hub.verify_token": "secret-token", "hub.challenge": "challenge-123" },
      "secret-token",
    );
    expect(challenge).toBe("challenge-123");
  });

  it("returns null when the verify token doesn't match", () => {
    const challenge = verifyWhatsAppWebhookSubscription(
      { "hub.mode": "subscribe", "hub.verify_token": "wrong", "hub.challenge": "challenge-123" },
      "secret-token",
    );
    expect(challenge).toBeNull();
  });
});

describe("verifyWhatsAppWebhookSignature", () => {
  const appSecret = "app-secret-value";
  const rawBody = JSON.stringify({ entry: [] });

  it("accepts a correctly computed X-Hub-Signature-256", () => {
    const signature = "sha256=" + createHmac("sha256", appSecret).update(rawBody).digest("hex");
    expect(verifyWhatsAppWebhookSignature(rawBody, signature, appSecret)).toBe(true);
  });

  it("rejects a tampered body/signature mismatch", () => {
    const signature = "sha256=" + createHmac("sha256", appSecret).update("different body").digest("hex");
    expect(verifyWhatsAppWebhookSignature(rawBody, signature, appSecret)).toBe(false);
  });

  it("rejects a missing signature header", () => {
    expect(verifyWhatsAppWebhookSignature(rawBody, undefined, appSecret)).toBe(false);
  });
});

describe("parseWhatsAppDeliveryStatusEvents", () => {
  it("extracts real status updates, never guessing an unrecognized status", () => {
    const events = parseWhatsAppDeliveryStatusEvents({
      entry: [
        {
          changes: [
            {
              value: {
                statuses: [
                  { id: "wamid.1", status: "delivered", timestamp: "123", recipient_id: "1555" },
                  { id: "wamid.2", status: "bogus_status" },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(events).toEqual([
      { messageId: "wamid.1", status: "delivered", timestamp: "123", recipientId: "1555", errorMessage: null },
    ]);
  });
});
