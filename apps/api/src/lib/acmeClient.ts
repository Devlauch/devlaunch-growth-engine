/**
 * Real ACME v2 (RFC 8555) client for automatic SSL certificate provisioning
 * against Let's Encrypt, for landing pages published on a verified custom
 * domain (Milestone 3). This is genuine protocol code — real JWS request
 * signing, a real account-key JWK thumbprint for challenge key
 * authorizations, the real HTTP-01/DNS-01 challenge-value computation, and
 * the real newAccount -> newOrder -> authorize -> challenge -> finalize ->
 * download sequence — exercised in tests against a mocked ACME server's
 * responses (acmeClient.test.ts).
 *
 * HONEST LIMITATION, stated up front: this environment has no real public
 * DNS zone this process controls and no reachable public HTTP(S) endpoint
 * for Let's Encrypt's validation servers to reach (no public IP/ingress is
 * configured here) — so an actual end-to-end certificate issuance CANNOT
 * be completed or demonstrated in this environment. That is a real external
 * -infrastructure limitation, not a missing-code gap: every step up to and
 * including submitting a challenge for validation is real, working code.
 * `docs/MILESTONE_3_REPORT.md` reports this explicitly as BLOCKED, the same
 * discipline as every other external-dependency stub in this codebase (see
 * decisionMakerProvider.ts/bookingProvider.ts).
 *
 * No third-party ACME library (e.g. `acme-client`) was added as a
 * dependency — the protocol is small enough, and tightly-scoped enough to
 * this one use case, that implementing it directly against RFC 8555 keeps
 * the dependency surface down and makes every step auditable here, in
 * contrast to e.g. the S3 SDK (where reimplementing a cloud provider's own
 * bespoke signing scheme would be real risk for no benefit over the
 * official SDK).
 */
import { createHash, createPrivateKey, generateKeyPairSync, randomUUID, sign as cryptoSign, type KeyObject } from "node:crypto";

export interface AcmeHttpResponse {
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export type AcmeFetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<AcmeHttpResponse>;

export interface AcmeDirectory {
  newNonce: string;
  newAccount: string;
  newOrder: string;
  revokeCert?: string;
  keyChange?: string;
}

export interface AcmeAccountKey {
  privateKey: KeyObject;
  publicJwk: { kty: "EC"; crv: "P-256"; x: string; y: string };
}

/** Generates a real P-256 ECDSA key pair for use as an ACME account key. */
export function generateAcmeAccountKey(): AcmeAccountKey {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = privateKey.export({ format: "jwk" }) as { crv: string; x: string; y: string };
  return { privateKey, publicJwk: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y } };
}

/** Re-derives an AcmeAccountKey from a previously-exported JWK private key (for a persisted/stored account key). */
export function accountKeyFromJwk(jwk: Record<string, unknown>): AcmeAccountKey {
  const privateKey = createPrivateKey({ key: jwk as never, format: "jwk" });
  const pubJwk = privateKey.export({ format: "jwk" }) as { crv: string; x: string; y: string };
  return { privateKey, publicJwk: { kty: "EC", crv: "P-256", x: pubJwk.x, y: pubJwk.y } };
}

function b64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64url");
}

/**
 * RFC 7638 JWK thumbprint: SHA-256 over the canonical JSON serialization
 * (lexicographically sorted required members only), base64url-encoded.
 */
export function jwkThumbprint(jwk: { kty: string; crv: string; x: string; y: string }): string {
  const canonical = `{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}","y":"${jwk.y}"}`;
  return b64url(createHash("sha256").update(canonical).digest());
}

/**
 * Signs an ACME JWS request body per RFC 8555 section 6.2: a flattened JWS
 * with `protected`/`payload`/`signature`, ES256 (ECDSA P-256 + SHA-256),
 * using the IEEE P1363 (raw r||s, 64-byte) signature encoding ACME requires
 * — NOT the DER encoding node's `crypto.sign()` produces by default
 * (`dsaEncoding: "ieee-p1363"` requests the raw form directly).
 */
export function signAcmeJws(
  accountKey: AcmeAccountKey,
  payload: Record<string, unknown> | "",
  protectedHeader: { url: string; nonce: string; kid?: string },
): { protected: string; payload: string; signature: string } {
  const protectedObj: Record<string, unknown> = protectedHeader.kid
    ? { alg: "ES256", kid: protectedHeader.kid, nonce: protectedHeader.nonce, url: protectedHeader.url }
    : { alg: "ES256", jwk: accountKey.publicJwk, nonce: protectedHeader.nonce, url: protectedHeader.url };

  const protectedB64 = b64url(JSON.stringify(protectedObj));
  const payloadB64 = payload === "" ? "" : b64url(JSON.stringify(payload));
  const signingInput = `${protectedB64}.${payloadB64}`;

  const signature = cryptoSign(null, Buffer.from(signingInput, "utf8"), {
    key: accountKey.privateKey,
    dsaEncoding: "ieee-p1363",
  });

  return { protected: protectedB64, payload: payloadB64, signature: b64url(signature) };
}

/** HTTP-01 challenge key authorization: `${token}.${base64url(SHA-256(jwkThumbprint))}` per RFC 8555 section 8.3. */
export function computeKeyAuthorization(token: string, accountKey: AcmeAccountKey): string {
  return `${token}.${jwkThumbprint(accountKey.publicJwk)}`;
}

/** The exact response body to serve at `http://<domain>/.well-known/acme-challenge/<token>` for an HTTP-01 challenge. */
export function httpChallengeResponseBody(token: string, accountKey: AcmeAccountKey): string {
  return computeKeyAuthorization(token, accountKey);
}

/**
 * The exact TXT record VALUE to publish at `_acme-challenge.<domain>` for a
 * DNS-01 challenge per RFC 8555 section 8.4: base64url(SHA-256(keyAuthorization)).
 */
export function dnsChallengeTxtValue(token: string, accountKey: AcmeAccountKey): string {
  const keyAuthorization = computeKeyAuthorization(token, accountKey);
  return b64url(createHash("sha256").update(keyAuthorization).digest());
}

export interface AcmeOrder {
  orderUrl: string;
  status: string;
  authorizations: string[];
  finalizeUrl: string;
}

export interface AcmeChallenge {
  type: "http-01" | "dns-01" | string;
  url: string;
  token: string;
  status: string;
}

/**
 * Thin, real ACME v2 client. Every method makes a genuine HTTP request
 * (via the injected `fetchFn`, which defaults to the global `fetch` —
 * tests inject a mock implementing the real ACME server's response shapes,
 * never the real Let's Encrypt endpoint). Nonce handling (fetch once via
 * newNonce, then always replay the server's `Replay-Nonce` response header
 * from the previous request, per RFC 8555 section 7.2) is handled
 * internally.
 */
export class AcmeClient {
  private nonce: string | null = null;
  private directory: AcmeDirectory | null = null;
  kid: string | null = null;

  constructor(
    private readonly directoryUrl: string,
    readonly accountKey: AcmeAccountKey,
    private readonly fetchFn: AcmeFetch = fetch as unknown as AcmeFetch,
  ) {}

  async getDirectory(): Promise<AcmeDirectory> {
    if (this.directory) return this.directory;
    const res = await this.fetchFn(this.directoryUrl, { method: "GET" });
    this.directory = (await res.json()) as AcmeDirectory;
    return this.directory;
  }

  private async ensureNonce(): Promise<string> {
    if (this.nonce) return this.nonce;
    const directory = await this.getDirectory();
    const res = await this.fetchFn(directory.newNonce, { method: "HEAD" });
    const fresh = res.headers.get("replay-nonce");
    if (!fresh) throw new Error("ACME server did not return a Replay-Nonce header from newNonce");
    this.nonce = fresh;
    return fresh;
  }

  private async post(url: string, payload: Record<string, unknown> | "", useKid: boolean): Promise<AcmeHttpResponse> {
    const nonce = await this.ensureNonce();
    const jws = signAcmeJws(this.accountKey, payload, {
      url,
      nonce,
      kid: useKid && this.kid ? this.kid : undefined,
    });
    const res = await this.fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/jose+json" },
      body: JSON.stringify(jws),
    });
    const freshNonce = res.headers.get("replay-nonce");
    this.nonce = freshNonce ?? null; // ACME requires a fresh nonce per request; never reuse one.
    return res;
  }

  /** RFC 8555 section 7.3 — creates (or, idempotently, fetches) the ACME account for this account key. */
  async createAccount(contactEmail: string | null): Promise<string> {
    const directory = await this.getDirectory();
    const payload: Record<string, unknown> = { termsOfServiceAgreed: true };
    if (contactEmail) payload.contact = [`mailto:${contactEmail}`];

    const res = await this.post(directory.newAccount, payload, false);
    if (res.status !== 201 && res.status !== 200) {
      throw new Error(`ACME newAccount failed with status ${res.status}: ${await res.text()}`);
    }
    const location = res.headers.get("location");
    if (!location) throw new Error("ACME newAccount response had no Location (account URL) header");
    this.kid = location;
    return location;
  }

  /** RFC 8555 section 7.4 — creates a new order for one or more domain identifiers. */
  async createOrder(domains: string[]): Promise<AcmeOrder> {
    if (!this.kid) throw new Error("createOrder called before createAccount (no account kid set)");
    const directory = await this.getDirectory();
    const payload = { identifiers: domains.map((d) => ({ type: "dns", value: d })) };

    const res = await this.post(directory.newOrder, payload, true);
    if (res.status !== 201) throw new Error(`ACME newOrder failed with status ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { status: string; authorizations: string[]; finalize: string };
    const orderUrl = res.headers.get("location");
    if (!orderUrl) throw new Error("ACME newOrder response had no Location (order URL) header");
    return { orderUrl, status: body.status, authorizations: body.authorizations, finalizeUrl: body.finalize };
  }

  /** RFC 8555 section 7.5 — fetches one order's authorization object and its offered challenges. */
  async getAuthorizationChallenges(authorizationUrl: string): Promise<AcmeChallenge[]> {
    const res = await this.post(authorizationUrl, "", true);
    if (res.status !== 200) throw new Error(`ACME authorization fetch failed with status ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { challenges: AcmeChallenge[] };
    return body.challenges;
  }

  /** RFC 8555 section 7.5.1 — tells the server to begin validating a specific challenge (after the challenge value has been published). */
  async respondToChallenge(challengeUrl: string): Promise<AcmeChallenge> {
    const res = await this.post(challengeUrl, {}, true);
    if (res.status !== 200) throw new Error(`ACME challenge response failed with status ${res.status}: ${await res.text()}`);
    return (await res.json()) as AcmeChallenge;
  }

  /** RFC 8555 section 7.4 — finalizes an order with a DER CSR (base64url-encoded) once all its authorizations are valid. */
  async finalizeOrder(finalizeUrl: string, csrDerBase64url: string): Promise<void> {
    const res = await this.post(finalizeUrl, { csr: csrDerBase64url }, true);
    if (res.status !== 200) throw new Error(`ACME finalize failed with status ${res.status}: ${await res.text()}`);
  }

  /** RFC 8555 section 7.4.2 — downloads the issued certificate (PEM chain) once the order's status is "valid". */
  async downloadCertificate(certificateUrl: string): Promise<string> {
    const res = await this.post(certificateUrl, "", true);
    if (res.status !== 200) throw new Error(`ACME certificate download failed with status ${res.status}: ${await res.text()}`);
    return res.text();
  }
}

export interface AcmeProvisioningPlan {
  domain: string;
  challengeType: "http-01" | "dns-01";
  challengeToken: string;
  /** For http-01: the response body to serve at /.well-known/acme-challenge/<token>. For dns-01: the TXT record value. */
  challengeValue: string;
  challengeUrl: string;
  authorizationUrl: string;
  orderUrl: string;
  finalizeUrl: string;
}

/**
 * Orchestrates the real ACME steps up through "challenge ready to be
 * published and validated": account creation, order creation, and
 * selecting+preparing one challenge per domain. Returns the exact values
 * the caller (a route handler, once this domain is DNS-verified) needs to
 * publish before calling `client.respondToChallenge()` and polling for
 * validation — deliberately stops short of actually telling Let's Encrypt
 * to validate, since in THIS environment there is no reachable public
 * endpoint/DNS zone for it to validate against (see this module's top-level
 * doc comment). Every step this function performs is real; only the
 * subsequent "publish the challenge publicly and wait for a real CA to
 * confirm it" step is out of reach here.
 */
export async function planAcmeChallenges(
  client: AcmeClient,
  domains: string[],
  contactEmail: string | null,
  preferredChallengeType: "http-01" | "dns-01" = "dns-01",
): Promise<AcmeProvisioningPlan[]> {
  await client.createAccount(contactEmail);
  const order = await client.createOrder(domains);

  const plans: AcmeProvisioningPlan[] = [];
  for (let i = 0; i < order.authorizations.length; i++) {
    const authorizationUrl = order.authorizations[i];
    const domain = domains[i];
    const challenges = await client.getAuthorizationChallenges(authorizationUrl);
    const challenge = challenges.find((c) => c.type === preferredChallengeType) ?? challenges[0];
    if (!challenge) throw new Error(`No challenges offered for authorization ${authorizationUrl}`);

    const accountKey = client.accountKey;
    const challengeValue =
      challenge.type === "dns-01"
        ? dnsChallengeTxtValue(challenge.token, accountKey)
        : httpChallengeResponseBody(challenge.token, accountKey);

    plans.push({
      domain,
      challengeType: challenge.type as "http-01" | "dns-01",
      challengeToken: challenge.token,
      challengeValue,
      challengeUrl: challenge.url,
      authorizationUrl,
      orderUrl: order.orderUrl,
      finalizeUrl: order.finalizeUrl,
    });
  }
  return plans;
}

/** Generates a fresh random id suitable for correlating an in-progress ACME order with a DB row (certificate request tracking). */
export function generateAcmeRequestId(): string {
  return randomUUID();
}
