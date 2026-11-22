import { describe, it, expect, vi, afterEach } from "vitest";
import { checkHealth } from "../src/lib/apolloClient.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("apolloClient.checkHealth", () => {
  it("reports not_configured (never a fabricated success) when no secret is stored", async () => {
    const result = await checkHealth({ config: {}, secret: null });
    expect(result.status).toBe("not_configured");
    expect(result.detail).toMatch(/no apollo api key/i);
  });

  it("reports connected on a real 2xx response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ people: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await checkHealth({ config: {}, secret: "real-apollo-key" });
    expect(result.status).toBe("connected");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.apollo.io/api/v1/mixed_people/search",
      expect.objectContaining({ method: "POST", headers: expect.objectContaining({ "x-api-key": "real-apollo-key" }) }),
    );
  });

  it("classifies 401/403 as an authentication error, never 'connected'", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 401 })));
    const result = await checkHealth({ config: {}, secret: "bad-key" });
    expect(result.status).toBe("error");
    expect(result.detail).toMatch(/authentication failed/i);
  });

  it("classifies 429 as a rate limit, never 'connected'", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 429 })));
    const result = await checkHealth({ config: {}, secret: "real-key" });
    expect(result.status).toBe("error");
    expect(result.detail).toMatch(/rate limit/i);
  });

  it("reports a network error honestly rather than throwing or fabricating success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("fetch failed: ECONNREFUSED")));
    const result = await checkHealth({ config: {}, secret: "real-key" });
    expect(result.status).toBe("error");
    expect(result.detail).toMatch(/network error/i);
  });
});
