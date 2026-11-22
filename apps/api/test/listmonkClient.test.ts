import { describe, it, expect, vi, beforeEach } from "vitest";

// config/env.ts reads process.env once at module-evaluation time (same
// convention as credentialEncryption.test.ts), so this must be set BEFORE
// the dynamic imports below — a static import would be hoisted ahead of
// any top-level statement in this file, which is exactly why these are
// dynamic imports rather than static ones.
process.env.INTEGRATION_CREDENTIALS_KEY = Buffer.alloc(32, 7).toString("base64");

const {
  RealListmonkClient,
  NotConfiguredListmonkClient,
  NotConfiguredListmonkError,
  ListmonkApiError,
  getListmonkClient,
  parseListmonkCredential,
  checkHealth,
} = await import("../src/lib/listmonkClient.js");
const { encryptCredential } = await import("../src/lib/credentialEncryption.js");

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe("NotConfiguredListmonkClient", () => {
  it("throws NotConfiguredListmonkError on every method — never fabricates a result", async () => {
    const client = new NotConfiguredListmonkClient("test reason");
    await expect(client.health()).rejects.toThrow(NotConfiguredListmonkError);
    await expect(client.getOrCreateList("x", "y")).rejects.toThrow(NotConfiguredListmonkError);
    await expect(client.upsertSubscriber({ email: "a@b.com", name: "A", listIds: [1] })).rejects.toThrow(NotConfiguredListmonkError);
    await expect(client.createCampaign({ name: "n", subject: "s", listIds: [1], body: "b" })).rejects.toThrow(NotConfiguredListmonkError);
    await expect(client.updateCampaignStatus(1, "running")).rejects.toThrow(NotConfiguredListmonkError);
  });
});

describe("RealListmonkClient — real HTTP call shape (fetch mocked, no network call)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
  });

  it("sends listmonk's documented 'token <user>:<key>' Authorization header", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { ok: true } }));
    const client = new RealListmonkClient({ baseUrl: "http://listmonk.local", apiUser: "api-user", apiKey: "secret-key" }, fetchMock as unknown as typeof fetch);

    await client.health();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://listmonk.local/api/health");
    expect((init.headers as Record<string, string>).Authorization).toBe("token api-user:secret-key");
  });

  it("getOrCreateList finds an existing list by name instead of creating a duplicate", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { results: [{ id: 7, uuid: "u-7", name: "My List" }] } }));
    const client = new RealListmonkClient({ baseUrl: "http://listmonk.local", apiUser: "u", apiKey: "k" }, fetchMock as unknown as typeof fetch);

    const list = await client.getOrCreateList("My List", "tag:x");

    expect(list.id).toBe(7);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("getOrCreateList creates a new list when none matches by name", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { data: { results: [] } }))
      .mockResolvedValueOnce(jsonResponse(200, { data: { id: 9, uuid: "u-9", name: "New List" } }));
    const client = new RealListmonkClient({ baseUrl: "http://listmonk.local", apiUser: "u", apiKey: "k" }, fetchMock as unknown as typeof fetch);

    const list = await client.getOrCreateList("New List", "tag:y");

    expect(list.id).toBe(9);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1].method).toBe("POST");
  });

  it("upsertSubscriber falls back to find-by-email + update on a 409 duplicate", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(409, { message: "subscriber exists" }))
      .mockResolvedValueOnce(jsonResponse(200, { data: { results: [{ id: 5, uuid: "u-5", email: "a@b.com", name: "A", status: "enabled" }] } }))
      .mockResolvedValueOnce(jsonResponse(200, { data: { id: 5 } }));
    const client = new RealListmonkClient({ baseUrl: "http://listmonk.local", apiUser: "u", apiKey: "k" }, fetchMock as unknown as typeof fetch);

    const subscriber = await client.upsertSubscriber({ email: "a@b.com", name: "A", listIds: [1] });

    expect(subscriber.id).toBe(5);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2][1].method).toBe("PUT");
  });

  it("throws ListmonkApiError (never fabricates a success) on a non-2xx, non-409 response", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(500, { message: "boom" }));
    const client = new RealListmonkClient({ baseUrl: "http://listmonk.local", apiUser: "u", apiKey: "k" }, fetchMock as unknown as typeof fetch);

    await expect(client.health()).rejects.toThrow(ListmonkApiError);
  });

  it("updateCampaignStatus PUTs /api/campaigns/:id/status with the real status", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { id: 3, uuid: "u-3", name: "C", status: "running" } }));
    const client = new RealListmonkClient({ baseUrl: "http://listmonk.local", apiUser: "u", apiKey: "k" }, fetchMock as unknown as typeof fetch);

    const result = await client.updateCampaignStatus(3, "running");

    expect(result.status).toBe("running");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://listmonk.local/api/campaigns/3/status");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toEqual({ status: "running" });
  });
});

describe("getListmonkClient", () => {
  function fakeTenantDb(result: unknown) {
    return { query: vi.fn().mockResolvedValue(result) };
  }

  beforeEach(() => {
    process.env.INTEGRATION_CREDENTIALS_KEY = Buffer.alloc(32, 7).toString("base64");
  });

  function fakeTenantDbSeq(responses: unknown[]) {
    const query = vi.fn();
    for (const r of responses) query.mockResolvedValueOnce(r);
    return { query };
  }

  it("returns a NotConfiguredListmonkClient when no integration row exists", async () => {
    const tenantDb = fakeTenantDb({ rowCount: 0, rows: [] });
    const { client, integrationId } = await getListmonkClient(tenantDb as any, "tenant-1", "project-1");

    expect(integrationId).toBeNull();
    await expect(client.health()).rejects.toThrow(NotConfiguredListmonkError);
  });

  it("returns a NotConfiguredListmonkClient when there is no credential to resolve", async () => {
    const tenantDb = fakeTenantDbSeq([
      { rowCount: 1, rows: [{ id: "int-1" }] }, // SELECT id
      { rowCount: 1, rows: [{ config: {}, encrypted_credential_ref: null, status: "pending_setup" }] }, // getIntegrationCredential
    ]);
    const { client, integrationId } = await getListmonkClient(tenantDb as any, "tenant-1", "project-1");

    expect(integrationId).toBe("int-1");
    await expect(client.health()).rejects.toThrow(NotConfiguredListmonkError);
  });

  it("returns a real client with the decrypted credential when connected", async () => {
    const encrypted = encryptCredential("k");
    const tenantDb = fakeTenantDbSeq([
      { rowCount: 1, rows: [{ id: "int-1" }] },
      { rowCount: 1, rows: [{ config: { baseUrl: "http://listmonk.local", apiUser: "u" }, encrypted_credential_ref: encrypted, status: "connected" }] },
    ]);

    const { client, integrationId } = await getListmonkClient(tenantDb as any, "tenant-1", "project-1");

    expect(integrationId).toBe("int-1");
    expect(client).toBeInstanceOf(RealListmonkClient);
  });
});

describe("parseListmonkCredential", () => {
  it("treats a bare secret string as the API key directly", () => {
    const credential = parseListmonkCredential({ baseUrl: "http://listmonk.local", apiUser: "u" }, "raw-api-key");
    expect(credential).toEqual({ baseUrl: "http://listmonk.local", apiUser: "u", apiKey: "raw-api-key", webhookVerification: undefined });
  });

  it("parses a JSON-object secret for apiKey + webhookVerification", () => {
    const secret = JSON.stringify({ apiKey: "real-key", webhookVerification: { sendgridPublicKey: "abc" } });
    const credential = parseListmonkCredential({ baseUrl: "http://listmonk.local", apiUser: "u" }, secret);
    expect(credential?.apiKey).toBe("real-key");
    expect(credential?.webhookVerification?.sendgridPublicKey).toBe("abc");
  });

  it("returns null when config is missing baseUrl/apiUser", () => {
    expect(parseListmonkCredential({}, "some-secret")).toBeNull();
  });

  it("returns null when there is no secret at all", () => {
    expect(parseListmonkCredential({ baseUrl: "http://listmonk.local", apiUser: "u" }, null)).toBeNull();
  });
});

describe("checkHealth", () => {
  it("returns { status: 'error' } (never throws) when the credential is incomplete", async () => {
    const result = await checkHealth({ config: {}, secret: null });
    expect(result.status).toBe("error");
  });

  it("returns { status: 'connected' } on a real successful health call", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ data: { ok: true } }) }));
    const result = await checkHealth({ config: { baseUrl: "http://listmonk.local", apiUser: "u" }, secret: "k" });
    expect(result.status).toBe("connected");
    vi.unstubAllGlobals();
  });

  it("returns { status: 'error', detail } (never throws) when listmonk is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const result = await checkHealth({ config: { baseUrl: "http://listmonk.local", apiUser: "u" }, secret: "k" });
    expect(result.status).toBe("error");
    expect(result.detail).toContain("ECONNREFUSED");
    vi.unstubAllGlobals();
  });
});
