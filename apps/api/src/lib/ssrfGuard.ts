/**
 * Shared SSRF-guard utility for every place this codebase hands a
 * tenant/user-supplied URL or domain to an outbound HTTP fetch (directly, or
 * indirectly by asking a separate crawler service to fetch it on our
 * behalf) — chatbot website-import, the Growth Analyzer, and the SEO site
 * audit, per `docs/BROADER_WORKSTREAM_AUDIT.md`'s "no SSRF guard exists
 * anywhere a user-supplied URL/domain is crawled" finding.
 *
 * Design:
 *  1. `assertSafeUrl(url)` rejects non-http(s) schemes, resolves the
 *     hostname's real DNS A/AAAA records (or validates a literal IP
 *     directly), and throws `SsrfBlockedError` if ANY resolved address is
 *     loopback/link-local/private/reserved/cloud-metadata-adjacent.
 *  2. `safeFetch(url, init)` is a drop-in `fetch` replacement that performs
 *     that same validation and then — critically — connects to the EXACT
 *     validated IP (never re-resolving DNS at connect time), closing the
 *     DNS-rebinding TOCTOU gap: an attacker-controlled DNS record that
 *     resolves safely during validation and then rebinds to 169.254.169.254
 *     (or any other internal address) between validation and connection.
 *     Built directly on `node:http`/`node:https` (not global `fetch`/undici,
 *     which have no public, non-experimental way to pin a connection to a
 *     pre-resolved IP while still sending the right Host header/SNI) so the
 *     `lookup` option can be forced to always return the pre-validated
 *     address, regardless of what hostname is requested.
 *  3. Redirects are never auto-followed by the underlying transport —
 *     `safeFetch` follows them itself, one hop at a time, re-validating each
 *     `Location` target through the same guard, bounded to a small max hop
 *     count.
 *
 * Injectable DNS resolver (same convention as `emailVerification.ts`'s
 * injectable `resolver` param) so tests can simulate rebinding/private-IP
 * scenarios without touching the real network.
 */

import * as http from "node:http";
import * as https from "node:https";
import * as dns from "node:dns";
import * as net from "node:net";

export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfBlockedError";
  }
}

export class ResponseTooLargeError extends Error {
  constructor(limitBytes: number) {
    super(`Response body exceeded the ${limitBytes}-byte cap and was aborted.`);
    this.name = "ResponseTooLargeError";
  }
}

export interface SsrfResolver {
  resolve4(hostname: string): Promise<string[]>;
  resolve6(hostname: string): Promise<string[]>;
}

const defaultResolver: SsrfResolver = {
  resolve4: (hostname: string) => dns.promises.resolve4(hostname),
  resolve6: (hostname: string) => dns.promises.resolve6(hostname),
};

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024; // 10MB
export const DEFAULT_MAX_REDIRECTS = 5;

export interface SafeFetchOptions {
  /** Injectable for tests — defaults to node's real dns.promises resolve4/resolve6. */
  resolver?: SsrfResolver;
  maxRedirects?: number;
  maxResponseBytes?: number;
  /** Used only when `init.signal` isn't supplied. */
  timeoutMs?: number;
}

export interface SafeFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer | null;
  signal?: AbortSignal;
}

export interface SafeFetchHeaders {
  get(name: string): string | null;
}

export interface SafeFetchResponse {
  ok: boolean;
  status: number;
  statusText: string;
  url: string;
  headers: SafeFetchHeaders;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// IPv4 / IPv6 private & reserved range checks
// ---------------------------------------------------------------------------

function ipv4ToInt(ip: string): number {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    throw new SsrfBlockedError(`Invalid IPv4 address: "${ip}"`);
  }
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function v4InCidr(ip: string, base: string, prefixLen: number): boolean {
  const ipInt = ipv4ToInt(ip);
  const baseInt = ipv4ToInt(base);
  const mask = prefixLen === 0 ? 0 : (0xffffffff << (32 - prefixLen)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

/** Loopback, link-local (incl. cloud metadata 169.254.169.254), RFC1918
 * private, CGNAT, and other documented reserved/metadata-adjacent ranges. */
const BLOCKED_V4_RANGES: Array<[string, number]> = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // RFC1918 private
  ["100.64.0.0", 10], // CGNAT (RFC6598)
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local — AWS/GCP/Azure metadata at 169.254.169.254
  ["172.16.0.0", 12], // RFC1918 private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1 (documentation)
  ["192.88.99.0", 24], // deprecated 6to4 relay anycast
  ["192.168.0.0", 16], // RFC1918 private
  ["198.18.0.0", 15], // benchmarking (RFC2544)
  ["198.51.100.0", 24], // TEST-NET-2 (documentation)
  ["203.0.113.0", 24], // TEST-NET-3 (documentation)
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved / class E / broadcast
];

function isBlockedV4(ip: string): boolean {
  return BLOCKED_V4_RANGES.some(([base, bits]) => v4InCidr(ip, base, bits));
}

/** Expands a (possibly `::`-compressed, possibly IPv4-mapped) IPv6 address to a 128-bit BigInt. */
function ipv6ToBigInt(address: string): bigint {
  let addr = address;
  // IPv4-mapped/compatible tail (e.g. "::ffff:127.0.0.1") — rewrite the
  // trailing dotted-quad as two hex groups before the usual expansion.
  if (addr.includes(".")) {
    const lastColon = addr.lastIndexOf(":");
    const v4Part = addr.slice(lastColon + 1);
    const v4Int = ipv4ToInt(v4Part);
    const hex = v4Int.toString(16).padStart(8, "0");
    addr = `${addr.slice(0, lastColon + 1)}${hex.slice(0, 4)}:${hex.slice(4)}`;
  }

  let head: string[];
  let tail: string[];
  if (addr.includes("::")) {
    const [h, t] = addr.split("::");
    head = h ? h.split(":") : [];
    tail = t ? t.split(":") : [];
  } else {
    head = addr.split(":");
    tail = [];
  }
  const missing = 8 - head.length - tail.length;
  if (missing < 0) throw new SsrfBlockedError(`Invalid IPv6 address: "${address}"`);
  const full = [...head, ...Array(missing).fill("0"), ...tail];

  let result = 0n;
  for (const segment of full) {
    const value = segment === "" ? 0 : parseInt(segment, 16);
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
      throw new SsrfBlockedError(`Invalid IPv6 address: "${address}"`);
    }
    result = (result << 16n) | BigInt(value);
  }
  return result;
}

function v6InPrefix(ipBig: bigint, prefixAddr: string, prefixLen: number): boolean {
  const baseBig = ipv6ToBigInt(prefixAddr);
  const fullMask = (1n << 128n) - 1n;
  const mask = prefixLen === 0 ? 0n : (fullMask << BigInt(128 - prefixLen)) & fullMask;
  return (ipBig & mask) === (baseBig & mask);
}

function isBlockedV6(ip: string): boolean {
  const ipBig = ipv6ToBigInt(ip);
  if (ipBig === 0n) return true; // :: (unspecified)
  if (ipBig === 1n) return true; // ::1 (loopback)
  if (v6InPrefix(ipBig, "fe80::", 10)) return true; // link-local
  if (v6InPrefix(ipBig, "fc00::", 7)) return true; // unique local (fc00::/7)
  if (v6InPrefix(ipBig, "ff00::", 8)) return true; // multicast

  // IPv4-mapped (::ffff:0:0/96) — extract the embedded IPv4 and re-check it,
  // so a DNS AAAA record can't smuggle a blocked v4 address past the v6 checks.
  if (v6InPrefix(ipBig, "::ffff:0:0", 96)) {
    const v4Int = Number(ipBig & 0xffffffffn);
    const v4 = [24, 16, 8, 0].map((shift) => (v4Int >>> shift) & 0xff).join(".");
    return isBlockedV4(v4);
  }

  return false;
}

/** Validates a single already-resolved (or literal) IP address. */
export function isBlockedIp(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return isBlockedV4(ip);
  if (family === 6) return isBlockedV6(ip);
  throw new SsrfBlockedError(`Not a valid IP address: "${ip}"`);
}

// ---------------------------------------------------------------------------
// URL parsing + DNS validation
// ---------------------------------------------------------------------------

function parseHttpUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SsrfBlockedError(`Invalid URL: "${url}"`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new SsrfBlockedError(`Blocked non-http(s) URL scheme in "${url}": "${parsed.protocol}"`);
  }
  return parsed;
}

function bareHostname(parsed: URL): string {
  // URL.hostname brackets a literal IPv6 host (e.g. "[::1]") — strip for net.isIP/DNS use.
  return parsed.hostname.replace(/^\[|\]$/g, "");
}

export interface ValidatedTarget {
  hostname: string;
  ip: string;
  family: 4 | 6;
}

/**
 * Resolves `hostname`'s real DNS A/AAAA records (or validates it directly if
 * it's already a literal IP) and throws `SsrfBlockedError` if ANY resolved
 * address is private/loopback/link-local/reserved. Returns one validated IP
 * to pin the subsequent connection to.
 */
async function resolveValidatedTarget(hostname: string, resolver: SsrfResolver): Promise<ValidatedTarget> {
  const literalFamily = net.isIP(hostname);
  if (literalFamily === 4 || literalFamily === 6) {
    if (isBlockedIp(hostname)) {
      throw new SsrfBlockedError(`Blocked: "${hostname}" is a private/internal/reserved IP address.`);
    }
    return { hostname, ip: hostname, family: literalFamily as 4 | 6 };
  }

  const [v4Result, v6Result] = await Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]);

  const resolved: Array<{ ip: string; family: 4 | 6 }> = [];
  if (v4Result.status === "fulfilled") resolved.push(...v4Result.value.map((ip) => ({ ip, family: 4 as const })));
  if (v6Result.status === "fulfilled") resolved.push(...v6Result.value.map((ip) => ({ ip, family: 6 as const })));

  if (resolved.length === 0) {
    throw new SsrfBlockedError(`Could not resolve any DNS A/AAAA records for host "${hostname}".`);
  }

  for (const { ip } of resolved) {
    if (isBlockedIp(ip)) {
      throw new SsrfBlockedError(`Blocked: host "${hostname}" resolves to private/internal/reserved address ${ip}.`);
    }
  }

  // Prefer IPv4 for the pinned connection (matches Node's default dual-stack preference order).
  const chosen = resolved.find((r) => r.family === 4) ?? resolved[0];
  return { hostname, ip: chosen.ip, family: chosen.family };
}

/**
 * Validates a user/tenant-supplied URL is safe to fetch (directly, or to
 * hand to a separate crawler service that will fetch it on our behalf):
 * http(s)-only scheme, and every DNS A/AAAA record for its host is public.
 * Throws `SsrfBlockedError` otherwise. Call this even for URLs this process
 * itself never directly fetches (e.g. a URL forwarded to Crawl4AI), since
 * the SSRF risk is the same regardless of which process makes the request.
 */
export async function assertSafeUrl(url: string, opts: { resolver?: SsrfResolver } = {}): Promise<void> {
  const parsed = parseHttpUrl(url);
  await resolveValidatedTarget(bareHostname(parsed), opts.resolver ?? defaultResolver);
}

// ---------------------------------------------------------------------------
// safeFetch: pinned-IP fetch with manual, re-validated redirect following
// ---------------------------------------------------------------------------

class SimpleHeaders implements SafeFetchHeaders {
  constructor(private readonly map: Record<string, string>) {}
  get(name: string): string | null {
    return this.map[name.toLowerCase()] ?? null;
  }
}

function performPinnedRequest(
  parsed: URL,
  target: ValidatedTarget,
  init: SafeFetchInit,
  maxResponseBytes: number,
  timeoutMs: number,
): Promise<SafeFetchResponse> {
  return new Promise((resolve, reject) => {
    const transport = parsed.protocol === "https:" ? https : http;
    const port = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;

    const requestOptions: http.RequestOptions & { servername?: string } = {
      protocol: parsed.protocol,
      hostname: target.hostname,
      port,
      path: `${parsed.pathname}${parsed.search}`,
      method: init.method ?? "GET",
      headers: init.headers,
      // The crux of DNS-rebinding protection: ignore whatever hostname is
      // asked to be looked up and always hand back the pre-validated IP, so
      // the TCP connection can never land anywhere but the address that was
      // actually checked above.
      lookup: ((_hostname: string, options: unknown, callback: (...args: unknown[]) => void) => {
        const family = target.family;
        if (typeof options === "function") {
          (options as (err: Error | null, address: string, family: number) => void)(null, target.ip, family);
        } else {
          callback(null, target.ip, family);
        }
      }) as unknown as http.RequestOptions["lookup"],
      signal: init.signal ?? AbortSignal.timeout(timeoutMs),
    };
    if (parsed.protocol === "https:") {
      (requestOptions as https.RequestOptions).servername = target.hostname;
    }

    const req = transport.request(requestOptions, (res) => {
      const chunks: Buffer[] = [];
      let total = 0;
      let aborted = false;

      res.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > maxResponseBytes) {
          aborted = true;
          res.destroy();
          req.destroy();
          reject(new ResponseTooLargeError(maxResponseBytes));
          return;
        }
        chunks.push(chunk);
      });

      res.on("end", () => {
        if (aborted) return;
        const buffer = Buffer.concat(chunks);
        const headerMap: Record<string, string> = {};
        for (const [key, value] of Object.entries(res.headers)) {
          if (value === undefined) continue;
          headerMap[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
        }
        const status = res.statusCode ?? 0;
        resolve({
          ok: status >= 200 && status < 300,
          status,
          statusText: res.statusMessage ?? "",
          url: parsed.toString(),
          headers: new SimpleHeaders(headerMap),
          text: async () => buffer.toString("utf-8"),
          json: async () => JSON.parse(buffer.toString("utf-8")),
        });
      });

      res.on("error", (err) => {
        if (!aborted) reject(err);
      });
    });

    req.on("error", (err) => reject(err));

    if (init.body) req.write(init.body);
    req.end();
  });
}

/**
 * Drop-in replacement for `fetch` that internal callers use instead of bare
 * `fetch` wherever a user/tenant-supplied URL is involved. Validates the URL
 * (and every redirect hop) via the same DNS A/AAAA check as `assertSafeUrl`,
 * and pins the actual TCP connection to the validated IP so a DNS-rebinding
 * attack between validation and connect time can't redirect the request
 * somewhere unsafe. Redirects are never auto-followed by the transport —
 * they're followed here, one at a time, re-validated, bounded to
 * `maxRedirects`.
 */
export async function safeFetch(
  url: string,
  init: SafeFetchInit = {},
  opts: SafeFetchOptions = {},
): Promise<SafeFetchResponse> {
  const resolver = opts.resolver ?? defaultResolver;
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const maxResponseBytes = opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let currentUrl = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const parsed = parseHttpUrl(currentUrl);
    const target = await resolveValidatedTarget(bareHostname(parsed), resolver);
    const response = await performPinnedRequest(parsed, target, init, maxResponseBytes, timeoutMs);

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) return response; // malformed redirect with no target — return as-is
      if (hop === maxRedirects) {
        throw new SsrfBlockedError(`Too many redirects (max ${maxRedirects}) while fetching "${url}".`);
      }
      // Resolve relative Location headers against the current URL, then
      // re-validate the new absolute target through the exact same guard
      // before ever following it — a redirect to an unsafe destination is
      // never silently trusted.
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }

    return response;
  }

  throw new SsrfBlockedError(`Too many redirects (max ${maxRedirects}) while fetching "${url}".`);
}
