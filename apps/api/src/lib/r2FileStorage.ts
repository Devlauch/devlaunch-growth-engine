/**
 * Real Cloudflare R2 FileStorage backend — implements the EXACT SAME
 * `FileStorage` interface fileStorage.ts already defines (see
 * `NotConfiguredS3FileStorage`'s doc comment there for the prior honest gap
 * this closes). R2 exposes an S3-API-compatible endpoint, so this is a
 * hand-rolled AWS Signature Version 4 (SigV4) signing client against that
 * endpoint — NOT the `@aws-sdk/client-s3` package. Dependency choice:
 * matches this codebase's established convention that EVERY third-party API
 * client (llmProvider.ts, crawl4aiClient.ts, hunterProvider.ts,
 * chatwootClient.ts, postizClient.ts) is a hand-rolled `fetch` client with
 * zero HTTP/cloud SDK dependency, using only Node's built-in `crypto`
 * (createHmac/createHash) for the signing math.
 *
 * ENDPOINT / REQUEST SHAPE (verified against Cloudflare's own docs,
 * developers.cloudflare.com/r2/api/s3/api/, fetched and cross-checked during
 * this work):
 *   - Path-style (NOT virtual-hosted-style) endpoint:
 *     `https://<ACCOUNT_ID>.r2.cloudflarestorage.com/<bucket>/<key>`.
 *   - Region for SigV4 purposes is the literal string `"auto"` (R2's own
 *     docs: "When using the S3 API, the region for an R2 bucket is `auto`.
 *     ... an empty value and `us-east-1` will alias to the `auto` region.").
 *   - Service is `"s3"` (same as real AWS S3 — R2 implements the S3 API
 *     surface, it does not invent its own SigV4 service name).
 *   - PutObject / GetObject / DeleteObject / HeadObject are all confirmed
 *     implemented by R2 (same page).
 *   - Auth-failure status codes: R2's pricing-page FAQ
 *     (developers.cloudflare.com/r2/pricing/) explicitly documents
 *     "HTTP 401 (Unauthorized) — missing or invalid credentials" and
 *     "HTTP 403 when caused by an authentication failure such as
 *     SignatureDoesNotMatch, ExpiredRequest, or RequestTimeTooSkewed" /
 *     "HTTP 403 (AccessDenied)" as not billed — i.e. standard S3-style
 *     error codes under 401/403. 404 for a missing object is standard S3
 *     GetObject/HeadObject/DeleteObject behavior (R2's S3-API page does not
 *     itself restate this, since it is inherited, not R2-specific).
 *
 * SIGV4 ALGORITHM (verified against AWS's own SigV4 reference docs,
 * docs.aws.amazon.com/general/latest/gr/sigv4-create-canonical-request.html
 * and .../sigv4-calculate-signature.html, fetched and cross-checked during
 * this work):
 *
 *   1. CanonicalRequest = HTTPMethod + "\n" + CanonicalURI + "\n" +
 *      CanonicalQueryString + "\n" + CanonicalHeaders + "\n" +
 *      SignedHeaders + "\n" + HashedPayload
 *        - CanonicalURI: the URI-encoded absolute path; each path SEGMENT is
 *          percent-encoded, the `/` separators themselves are never encoded.
 *        - CanonicalQueryString: each param name/value percent-encoded
 *          individually, then sorted alphabetically by (encoded) key.
 *        - CanonicalHeaders: `lower(name) + ":" + trim(value) + "\n"` per
 *          header, headers sorted alphabetically by lowercase name.
 *        - HashedPayload: lowercase-hex SHA-256 of the request body (empty
 *          string hashes to the well-known
 *          e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855),
 *          or the literal string `UNSIGNED-PAYLOAD` for presigned-URL GETs
 *          (AWS's own doc: "For Amazon S3, include the literal string
 *          UNSIGNED-PAYLOAD ... and set the same value as the
 *          x-amz-content-sha256 header value").
 *   2. StringToSign = "AWS4-HMAC-SHA256" + "\n" + AmzDate (YYYYMMDDTHHMMSSZ)
 *      + "\n" + CredentialScope (YYYYMMDD/auto/s3/aws4_request) + "\n" +
 *      lowercase-hex SHA-256 of CanonicalRequest.
 *   3. Signing key derivation (HMAC-SHA256 chain):
 *        kDate    = HMAC("AWS4" + secretAccessKey, YYYYMMDD)
 *        kRegion  = HMAC(kDate, "auto")
 *        kService = HMAC(kRegion, "s3")
 *        kSigning = HMAC(kService, "aws4_request")
 *      signature = lowercase-hex HMAC-SHA256(kSigning, StringToSign).
 *   4. Header-based auth:
 *      `Authorization: AWS4-HMAC-SHA256 Credential=<accessKeyId>/<scope>, SignedHeaders=<signed>, Signature=<sig>`
 *      plus required `x-amz-date` and `x-amz-content-sha256` headers.
 *   5. Presigned-URL (query-string) auth, used for getSignedDownloadUrl():
 *      same canonical-request/string-to-sign/signing-key math, but the
 *      "headers" signed are just `host`, and
 *      X-Amz-Algorithm/X-Amz-Credential/X-Amz-Date/X-Amz-Expires/
 *      X-Amz-SignedHeaders are themselves part of the canonical query
 *      string (sorted in with any other query params), with
 *      X-Amz-Signature appended to the URL only AFTER the signature is
 *      computed (it is never part of what gets signed).
 *
 * Every method does a REAL signed HTTP call against the R2 S3-compatible
 * endpoint — there is no real Cloudflare account/bucket in this environment
 * to exercise it against live, so (same convention as hunterProvider.ts /
 * llmProvider.ts) this is real, working client code verified only against
 * injected fake `fetch` responses in test/r2FileStorage.test.ts, not the
 * live R2 API.
 */
import { createHash, createHmac, randomUUID } from "node:crypto";
import path from "node:path";
import type { FileStorage, FileStorageUploadResult } from "./fileStorage.js";

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** Optional public dev URL / custom domain for directly serving objects (e.g. https://pub-xxxx.r2.dev or a custom domain). Null = no public URL; getSignedDownloadUrl always mints a presigned GET URL instead. */
  publicBaseUrl?: string | null;
}

const REGION = "auto";
const SERVICE = "s3";
const ALGORITHM = "AWS4-HMAC-SHA256";
const EMPTY_PAYLOAD_HASH = createHash("sha256").update("").digest("hex");

export class R2Error extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(message: string, status: number, code: string | null) {
    super(message);
    this.name = "R2Error";
    this.status = status;
    this.code = code;
  }
}

/** 403: bad/invalid credentials, signature mismatch, or valid creds lacking permission. */
export class R2AuthError extends R2Error {
  constructor(message: string, code: string | null) {
    super(message, 403, code);
    this.name = "R2AuthError";
  }
}

/** 404: the requested object does not exist in the bucket. */
export class R2NotFoundError extends R2Error {
  constructor(message: string, code: string | null) {
    super(message, 404, code);
    this.name = "R2NotFoundError";
  }
}

/** 5xx: a real failure on Cloudflare's side — never treated as "file not found" or swallowed into a fake success. */
export class R2ServerError extends R2Error {
  constructor(message: string, status: number, code: string | null) {
    super(message, status, code);
    this.name = "R2ServerError";
  }
}

export interface R2Fetcher {
  (url: string, init: { method: string; headers: Record<string, string>; body?: Buffer }): Promise<Response>;
}

function defaultFetcher(): R2Fetcher {
  return (url, init) => fetch(url, init);
}

function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

function amzDateStamp(date: Date): { amzDate: string; dateStamp: string } {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, ""); // 2026-11-23T01:02:03.000Z -> 20261123T010203Z
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

/** RFC 3986 URI-encoding per AWS's SigV4 spec: unreserved chars (A-Za-z0-9-_.~) pass through unescaped, everything else is %XX (uppercase hex), space is %20 (never "+"). */
function awsUriEncode(value: string, encodeSlash = true): string {
  return Array.from(Buffer.from(value, "utf8"))
    .map((byte) => {
      const ch = String.fromCharCode(byte);
      if (/[A-Za-z0-9\-_.~]/.test(ch)) return ch;
      if (ch === "/" && !encodeSlash) return "/";
      return `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    })
    .join("");
}

/** Canonical URI: each path segment individually percent-encoded; the `/` separators are never encoded. */
function canonicalUri(bucket: string, key: string): string {
  const segments = `${bucket}/${key}`.split("/").map((seg) => awsUriEncode(seg, true));
  return `/${segments.join("/")}`;
}

/** Canonical query string: each param percent-encoded, then sorted alphabetically by encoded key. */
function canonicalQueryString(params: Record<string, string>): string {
  return Object.keys(params)
    .map((k) => [awsUriEncode(k), awsUriEncode(params[k])])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

function signingKey(secretAccessKey: string, dateStamp: string): Buffer {
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, REGION);
  const kService = hmac(kRegion, SERVICE);
  return hmac(kService, "aws4_request");
}

interface SignedRequest {
  url: string;
  headers: Record<string, string>;
}

/** Builds a fully header-signed request (used for PUT/GET/DELETE/HEAD against the object itself). */
function signRequest(
  config: R2Config,
  method: string,
  key: string,
  opts: { body?: Buffer; extraHeaders?: Record<string, string>; now?: Date } = {},
): SignedRequest {
  const host = `${config.accountId}.r2.cloudflarestorage.com`;
  const now = opts.now ?? new Date();
  const { amzDate, dateStamp } = amzDateStamp(now);
  const payloadHash = opts.body ? sha256Hex(opts.body) : EMPTY_PAYLOAD_HASH;

  const headers: Record<string, string> = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    ...(opts.extraHeaders ?? {}),
  };

  const signedHeaderNames = Object.keys(headers)
    .map((h) => h.toLowerCase())
    .sort();
  const canonicalHeaders = signedHeaderNames.map((h) => `${h}:${String(headers[h]).trim()}\n`).join("");
  const signedHeaders = signedHeaderNames.join(";");

  const canonicalRequest = [
    method,
    canonicalUri(config.bucket, key),
    "", // no query string for object PUT/GET/DELETE/HEAD
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const stringToSign = [ALGORITHM, amzDate, credentialScope, sha256Hex(canonicalRequest)].join("\n");
  const signature = hmac(signingKey(config.secretAccessKey, dateStamp), stringToSign).toString("hex");

  const authorization = `${ALGORITHM} Credential=${config.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    url: `https://${host}${canonicalUri(config.bucket, key)}`,
    headers: { ...headers, Authorization: authorization },
  };
}

/** Builds a presigned (query-string-authenticated) GET URL, valid for `expirySeconds`. Only `host` is a signed header, per AWS's presigned-URL convention. */
function presignGetUrl(config: R2Config, key: string, expirySeconds: number, now: Date = new Date()): string {
  const host = `${config.accountId}.r2.cloudflarestorage.com`;
  const { amzDate, dateStamp } = amzDateStamp(now);
  const credentialScope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;

  const query: Record<string, string> = {
    "X-Amz-Algorithm": ALGORITHM,
    "X-Amz-Credential": `${config.accessKeyId}/${credentialScope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(Math.max(1, Math.floor(expirySeconds))),
    "X-Amz-SignedHeaders": "host",
  };

  const canonicalRequest = [
    "GET",
    canonicalUri(config.bucket, key),
    canonicalQueryString(query),
    `host:${host}\n`,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const stringToSign = [ALGORITHM, amzDate, credentialScope, sha256Hex(canonicalRequest)].join("\n");
  const signature = hmac(signingKey(config.secretAccessKey, dateStamp), stringToSign).toString("hex");

  return `https://${host}${canonicalUri(config.bucket, key)}?${canonicalQueryString(query)}&X-Amz-Signature=${signature}`;
}

/** Keeps only safe characters from a client-supplied filename for use in a path segment / Content-Disposition — mirrors fileStorage.ts's sanitizeFilename exactly. */
function sanitizeFilename(filename: string): string {
  const base = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, "_");
  return base.length > 0 ? base.slice(0, 180) : "file";
}

/** Classifies a non-2xx R2 response into the right thrown error type — never swallowed into a fake success. */
async function throwForErrorResponse(res: Response, action: string): Promise<never> {
  const bodyText = await res.text().catch(() => "");
  // R2/S3 error bodies are XML: <Error><Code>...</Code><Message>...</Message></Error>
  const codeMatch = /<Code>([^<]+)<\/Code>/.exec(bodyText);
  const code = codeMatch ? codeMatch[1] : null;
  const message = `R2 ${action} failed with HTTP ${res.status}${code ? ` (${code})` : ""}`;

  if (res.status === 404) throw new R2NotFoundError(message, code);
  if (res.status === 403 || res.status === 401) throw new R2AuthError(message, code);
  if (res.status >= 500) throw new R2ServerError(message, res.status, code);
  throw new R2Error(message, res.status, code);
}

/**
 * R2FileStorage implements the FileStorage interface (fileStorage.ts)
 * against a real Cloudflare R2 bucket via hand-rolled SigV4 — see this
 * file's header comment for the full citation trail.
 */
export class R2FileStorage implements FileStorage {
  constructor(
    private readonly config: R2Config,
    private readonly fetcher: R2Fetcher = defaultFetcher(),
  ) {}

  /** Real PUT Object. Key scheme mirrors LocalDiskFileStorage exactly: `<sha256-of-random-uuid-prefix>/<sanitized-filename>`. */
  async upload(buffer: Buffer, filename: string, contentType: string): Promise<FileStorageUploadResult> {
    const prefix = createHash("sha256").update(randomUUID()).digest("hex").slice(0, 16);
    const key = `${prefix}/${sanitizeFilename(filename)}`;

    const signed = signRequest(this.config, "PUT", key, {
      body: buffer,
      extraHeaders: contentType ? { "content-type": contentType } : {},
    });

    const res = await this.fetcher(signed.url, { method: "PUT", headers: signed.headers, body: buffer });
    if (!res.ok) await throwForErrorResponse(res, `PutObject(${key})`);

    const url = await this.getSignedDownloadUrl(key, 3600);
    return { key, url };
  }

  /**
   * A real, cloud-native signed download URL: the public base URL (if
   * configured — an R2 bucket's r2.dev dev URL or a custom domain) when set,
   * otherwise a genuine SigV4 presigned GET URL straight to R2's
   * S3-compatible endpoint. Never routes through this app's own
   * HMAC-signed-path scheme (that scheme exists only because
   * LocalDiskFileStorage has no native signed-URL concept — R2 does).
   */
  async getSignedDownloadUrl(key: string, expirySeconds: number): Promise<string> {
    if (this.config.publicBaseUrl) {
      const base = this.config.publicBaseUrl.replace(/\/+$/, "");
      return `${base}/${key.split("/").map((seg) => encodeURIComponent(seg)).join("/")}`;
    }
    return presignGetUrl(this.config, key, expirySeconds);
  }

  /** Real DELETE Object. R2/S3 DeleteObject is idempotent (204 even if the key never existed) — this never throws R2NotFoundError on delete. */
  async delete(key: string): Promise<void> {
    const signed = signRequest(this.config, "DELETE", key);
    const res = await this.fetcher(signed.url, { method: "DELETE", headers: signed.headers });
    if (!res.ok && res.status !== 404) await throwForErrorResponse(res, `DeleteObject(${key})`);
  }

  /**
   * Real GET Object — fetches actual bytes. Not part of the FileStorage
   * interface contract (mirrors LocalDiskFileStorage's own extra
   * `readFile`/`fileSize` methods, which are also not part of the
   * interface); kept as a direct, header-signed call (not the presigned
   * query-string URL) since this process already holds real R2 credentials.
   */
  async readFile(key: string): Promise<Buffer> {
    const signed = signRequest(this.config, "GET", key);
    const res = await this.fetcher(signed.url, { method: "GET", headers: signed.headers });
    if (!res.ok) await throwForErrorResponse(res, `GetObject(${key})`);
    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
}

// Exported for test-only verification of the signing math itself.
export const __testing = { signRequest, presignGetUrl, canonicalUri, canonicalQueryString, awsUriEncode, signingKey, amzDateStamp };
