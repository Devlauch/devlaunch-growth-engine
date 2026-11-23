import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type * as http from "node:http";

/**
 * Real tests for the shared SSRF guard (../src/lib/ssrfGuard.ts), per
 * docs/BROADER_WORKSTREAM_AUDIT.md's "no SSRF guard exists anywhere a
 * user-supplied URL/domain is crawled" finding and
 * docs/SECURITY_HARDENING_MILESTONE_1.md.
 *
 * `node:http`'s `request` is mocked (not the whole networking stack) so the
 * redirect-following/DNS-rebinding-pinning logic can be tested
 * deterministically and offline, while still exercising the REAL production
 * code path (the actual `lookup` closure `safeFetch` builds, the actual
 * redirect-following loop, the actual response-size cap). One genuine,
 * unmocked, live-network test (against a real public domain over real
 * `node:https`, untouched by the `node:http` mock below) covers the
 * happy-path "a real domain is allowed" case end to end.
 */

const { httpRequestMock } = vi.hoisted(() => ({ httpRequestMock: vi.fn() }));

vi.mock("node:http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:http")>();
  return { ...actual, request: httpRequestMock };
});

const {
  assertSafeUrl,
  safeFetch,
  isBlockedIp,
  SsrfBlockedError,
  ResponseTooLargeError,
} = await import("../src/lib/ssrfGuard.js");

type CapturedRequestOptions = http.RequestOptions & { lookup?: unknown };

function fakeRequest(): EventEmitter & { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> } {
  const req = new EventEmitter() as any;
  req.write = vi.fn();
  req.end = vi.fn();
  req.destroy = vi.fn();
  return req;
}

function fakeResponse(opts: { statusCode: number; headers?: Record<string, string>; body?: string | Buffer[] }) {
  const res = new EventEmitter() as any;
  res.statusCode = opts.statusCode;
  res.statusMessage = "";
  res.headers = opts.headers ?? {};
  res.destroy = vi.fn();
  queueMicrotask(() => {
    const chunks = Array.isArray(opts.body) ? opts.body : opts.body ? [Buffer.from(opts.body)] : [];
    for (const chunk of chunks) res.emit("data", chunk);
    res.emit("end");
  });
  return res;
}

/** Queues one `http.request(...)` response and returns the options the
 * production code actually passed in (so tests can inspect/invoke the
 * pinned `lookup` function directly). */
function queueResponse(opts: { statusCode: number; headers?: Record<string, string>; body?: string | Buffer[] }): {
  getOptions: () => CapturedRequestOptions;
} {
  let captured: CapturedRequestOptions | undefined;
  httpRequestMock.mockImplementationOnce((options: CapturedRequestOptions, callback: (res: unknown) => void) => {
    captured = options;
    const req = fakeRequest();
    queueMicrotask(() => callback(fakeResponse(opts)));
    return req;
  });
  return {
    getOptions: () => {
      if (!captured) throw new Error("request() was never called");
      return captured;
    },
  };
}

beforeEach(() => {
  httpRequestMock.mockReset();
});

// ---------------------------------------------------------------------------
// isBlockedIp — private/loopback/link-local/metadata/reserved ranges
// ---------------------------------------------------------------------------

describe("isBlockedIp", () => {
  const blockedV4 = [
    ["127.0.0.1", "loopback"],
    ["127.255.255.255", "loopback (edge of /8)"],
    ["169.254.169.254", "cloud metadata (AWS/GCP/Azure)"],
    ["169.254.0.1", "link-local"],
    ["10.0.0.1", "RFC1918 10/8"],
    ["172.16.0.1", "RFC1918 172.16/12"],
    ["172.31.255.255", "RFC1918 172.16/12 (edge)"],
    ["192.168.1.1", "RFC1918 192.168/16"],
    ["0.0.0.1", "'this network'"],
    ["100.64.0.1", "CGNAT"],
    ["192.0.0.1", "IETF protocol assignments"],
    ["192.0.2.1", "TEST-NET-1"],
    ["198.18.0.1", "benchmarking"],
    ["198.51.100.1", "TEST-NET-2"],
    ["203.0.113.1", "TEST-NET-3"],
    ["224.0.0.1", "multicast"],
    ["255.255.255.255", "reserved/broadcast"],
  ] as const;

  it.each(blockedV4)("blocks IPv4 %s (%s)", (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  const blockedV6 = [
    ["::1", "loopback"],
    ["::", "unspecified"],
    ["fe80::1", "link-local"],
    ["febf::1", "link-local (edge of /10)"],
    ["fc00::1", "unique local"],
    ["fd00::1", "unique local"],
    ["ff02::1", "multicast"],
    ["::ffff:127.0.0.1", "IPv4-mapped loopback"],
    ["::ffff:169.254.169.254", "IPv4-mapped metadata"],
  ] as const;

  it.each(blockedV6)("blocks IPv6 %s (%s)", (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  const allowed = [
    ["8.8.8.8", "public v4 (Google DNS)"],
    ["1.1.1.1", "public v4 (Cloudflare DNS)"],
    ["93.184.216.34", "public v4 (example.com)"],
    ["2606:4700:4700::1111", "public v6 (Cloudflare DNS)"],
  ] as const;

  it.each(allowed)("allows %s (%s)", (ip) => {
    expect(isBlockedIp(ip)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// assertSafeUrl
// ---------------------------------------------------------------------------

describe("assertSafeUrl", () => {
  it("rejects non-http(s) schemes without ever calling the resolver", async () => {
    const resolver = { resolve4: vi.fn(), resolve6: vi.fn() };
    await expect(assertSafeUrl("file:///etc/passwd", { resolver })).rejects.toThrow(SsrfBlockedError);
    await expect(assertSafeUrl("ftp://internal.example/file", { resolver })).rejects.toThrow(SsrfBlockedError);
    await expect(assertSafeUrl("data:text/plain,hello", { resolver })).rejects.toThrow(SsrfBlockedError);
    expect(resolver.resolve4).not.toHaveBeenCalled();
  });

  it("rejects a literal metadata/private IP in the URL directly, without calling the resolver", async () => {
    const resolver = { resolve4: vi.fn(), resolve6: vi.fn() };
    await expect(assertSafeUrl("http://169.254.169.254/latest/meta-data/", { resolver })).rejects.toThrow(
      SsrfBlockedError,
    );
    await expect(assertSafeUrl("http://127.0.0.1:8080/admin", { resolver })).rejects.toThrow(SsrfBlockedError);
    await expect(assertSafeUrl("http://[::1]/", { resolver })).rejects.toThrow(SsrfBlockedError);
    expect(resolver.resolve4).not.toHaveBeenCalled();
  });

  it("rejects when the hostname resolves to a blocked (cloud metadata) address", async () => {
    const resolver = {
      resolve4: vi.fn(async () => ["169.254.169.254"]),
      resolve6: vi.fn(async () => {
        throw Object.assign(new Error("no AAAA"), { code: "ENODATA" });
      }),
    };
    await expect(assertSafeUrl("http://attacker-controlled.example/", { resolver })).rejects.toThrow(
      SsrfBlockedError,
    );
  });

  it("rejects when ANY resolved address is blocked, even if another is public", async () => {
    const resolver = {
      resolve4: vi.fn(async () => ["8.8.8.8"]),
      resolve6: vi.fn(async () => ["fc00::1"]), // unique-local — blocked
    };
    await expect(assertSafeUrl("http://mixed-answers.example/", { resolver })).rejects.toThrow(SsrfBlockedError);
  });

  it("rejects when DNS resolution fails entirely (no A/AAAA records)", async () => {
    const resolver = {
      resolve4: vi.fn(async () => {
        throw Object.assign(new Error("NXDOMAIN"), { code: "ENOTFOUND" });
      }),
      resolve6: vi.fn(async () => {
        throw Object.assign(new Error("NXDOMAIN"), { code: "ENOTFOUND" });
      }),
    };
    await expect(assertSafeUrl("http://does-not-exist.invalid/", { resolver })).rejects.toThrow(SsrfBlockedError);
  });

  it("allows a hostname that resolves only to public addresses (mocked happy path)", async () => {
    const resolver = {
      resolve4: vi.fn(async () => ["93.184.216.34"]),
      resolve6: vi.fn(async () => {
        throw Object.assign(new Error("no AAAA"), { code: "ENODATA" });
      }),
    };
    await expect(assertSafeUrl("https://a-tenants-real-site.example/about", { resolver })).resolves.toBeUndefined();
  });

  it("allows a real public domain over the real network (live happy path, default resolver)", async () => {
    await expect(assertSafeUrl("https://example.com/")).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// safeFetch — pinned-connection + redirect safety (node:http mocked)
// ---------------------------------------------------------------------------

describe("safeFetch", () => {
  it("fetches successfully and returns a fetch-like response (happy path)", async () => {
    const resolver = { resolve4: vi.fn(async () => ["93.184.216.34"]), resolve6: vi.fn(async () => []) };
    queueResponse({ statusCode: 200, body: "hello world" });

    const res = await safeFetch("http://safe-tenant-site.example/page", {}, { resolver });

    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello world");
    expect(httpRequestMock).toHaveBeenCalledTimes(1);
  });

  it("pins the connection to the validated IP and never re-resolves DNS at connect time (rebinding simulation)", async () => {
    // Simulates a rebinding DNS server: the FIRST (and, per the assertion
    // below, ONLY) answer this resolver ever gives is a safe public IP. If
    // safeFetch re-resolved at connect time against a rebound record, a
    // real DNS server could then answer differently (e.g. 169.254.169.254).
    // We prove it never asks again, and that the actual `lookup` function
    // handed to the transport returns the pre-validated IP regardless of
    // what hostname is passed to it.
    const resolve4 = vi.fn(async () => ["93.184.216.34"]); // safe public IP — the DNS server's only ever answer
    const resolver = { resolve4, resolve6: vi.fn(async () => []) };

    const { getOptions } = queueResponse({ statusCode: 200, body: "ok" });

    await safeFetch("http://rebinding-target.example/", {}, { resolver });

    expect(resolve4).toHaveBeenCalledTimes(1);
    expect(resolve4).toHaveBeenCalledWith("rebinding-target.example");

    const options = getOptions();
    expect(typeof options.lookup).toBe("function");
    // Call the captured lookup with a COMPLETELY different hostname — a
    // real DNS-rebinding attempt would try to get a fresh answer here. The
    // pinned lookup must ignore it and still return the originally
    // validated IP, without ever touching the resolver again.
    const lookupFn = options.lookup as (
      hostname: string,
      opts: unknown,
      cb: (err: Error | null, address: string, family: number) => void,
    ) => void;
    await new Promise<void>((resolve) => {
      lookupFn("totally-different-rebound-hostname.evil", {}, (err, address, family) => {
        expect(err).toBeNull();
        expect(address).toBe("93.184.216.34");
        expect(family).toBe(4);
        resolve();
      });
    });
    expect(resolve4).toHaveBeenCalledTimes(1); // still only once — no second resolution happened
  });

  it("follows a redirect to a safe target and re-validates it", async () => {
    const resolver = {
      resolve4: vi.fn(async (hostname: string) => (hostname === "hop1.example" ? ["93.184.216.34"] : ["93.184.216.35"])),
      resolve6: vi.fn(async () => []),
    };
    queueResponse({ statusCode: 302, headers: { location: "http://hop2.example/final" } });
    queueResponse({ statusCode: 200, body: "final page" });

    const res = await safeFetch("http://hop1.example/start", {}, { resolver });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("final page");
    expect(httpRequestMock).toHaveBeenCalledTimes(2);
    expect(resolver.resolve4).toHaveBeenCalledWith("hop1.example");
    expect(resolver.resolve4).toHaveBeenCalledWith("hop2.example");
  });

  it("never silently trusts a redirect to an unsafe destination — rejects before ever connecting to it", async () => {
    const resolver = {
      resolve4: vi.fn(async (hostname: string) =>
        hostname === "redirector.example" ? ["93.184.216.34"] : ["169.254.169.254"],
      ),
      resolve6: vi.fn(async () => []),
    };
    queueResponse({
      statusCode: 302,
      headers: { location: "http://metadata-smuggle.example/latest/meta-data/" },
    });

    await expect(safeFetch("http://redirector.example/start", {}, { resolver })).rejects.toThrow(SsrfBlockedError);

    // Only the first (safe) hop's connection was ever attempted — the
    // unsafe redirect target was never connected to.
    expect(httpRequestMock).toHaveBeenCalledTimes(1);
  });

  it("bounds the number of redirects it will follow", async () => {
    const resolver = { resolve4: vi.fn(async () => ["93.184.216.34"]), resolve6: vi.fn(async () => []) };
    for (let i = 0; i < 10; i++) {
      queueResponse({ statusCode: 302, headers: { location: `http://redirect-chain.example/${i + 1}` } });
    }

    await expect(
      safeFetch("http://redirect-chain.example/0", {}, { resolver, maxRedirects: 3 }),
    ).rejects.toThrow(SsrfBlockedError);
    expect(httpRequestMock).toHaveBeenCalledTimes(4); // initial + 3 redirects, then bail
  });

  it("aborts and rejects once the response body exceeds the configured byte cap", async () => {
    const resolver = { resolve4: vi.fn(async () => ["93.184.216.34"]), resolve6: vi.fn(async () => []) };
    const bigChunk = Buffer.alloc(1024, "x");
    queueResponse({ statusCode: 200, body: Array.from({ length: 20 }, () => bigChunk) }); // 20KB

    await expect(
      safeFetch("http://huge-page.example/", {}, { resolver, maxResponseBytes: 2048 }),
    ).rejects.toThrow(ResponseTooLargeError);
  });
});
