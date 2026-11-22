import { describe, it, expect, vi, afterEach } from "vitest";
import { checkHealth } from "../src/lib/googleClient.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("googleClient.checkHealth", () => {
  it("reports not_configured when both the API key and engine id are missing", async () => {
    const result = await checkHealth({ config: {}, secret: null });
    expect(result.status).toBe("not_configured");
    expect(result.detail).toMatch(/API key and Search Engine ID/i);
  });

  it("reports not_configured when only the engine id (cx) is missing, even though a key is stored", async () => {
    const result = await checkHealth({ config: {}, secret: "real-google-key" });
    expect(result.status).toBe("not_configured");
    expect(result.detail).toMatch(/Search Engine ID \(cx\)/i);
  });

  it("reports not_configured when only the key is missing, even though an engine id is stored", async () => {
    const result = await checkHealth({ config: { engineId: "abc123:cx" }, secret: null });
    expect(result.status).toBe("not_configured");
    expect(result.detail).toMatch(/API key/i);
  });

  it("reports connected on a real 2xx response when both the key and engine id are present", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ items: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await checkHealth({ config: { engineId: "abc123:cx" }, secret: "real-google-key" });
    expect(result.status).toBe("connected");
    const [calledUrl] = fetchMock.mock.calls[0] as [string];
    expect(calledUrl).toContain("key=real-google-key");
    expect(calledUrl).toContain("cx=abc123%3Acx");
  });

  it("classifies 400/403 as an authentication/config error, never 'connected'", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 403 })));
    const result = await checkHealth({ config: { engineId: "abc123:cx" }, secret: "bad-key" });
    expect(result.status).toBe("error");
    expect(result.detail).toMatch(/authentication\/config failed/i);
  });

  it("classifies 429 as a quota/rate limit, never 'connected'", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 429 })));
    const result = await checkHealth({ config: { engineId: "abc123:cx" }, secret: "real-key" });
    expect(result.status).toBe("error");
    expect(result.detail).toMatch(/quota or rate limit/i);
  });

  it("reports a network error honestly rather than throwing or fabricating success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("fetch failed: ECONNREFUSED")));
    const result = await checkHealth({ config: { engineId: "abc123:cx" }, secret: "real-key" });
    expect(result.status).toBe("error");
    expect(result.detail).toMatch(/network error/i);
  });
});
