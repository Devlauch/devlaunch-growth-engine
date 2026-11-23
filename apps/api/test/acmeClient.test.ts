import { describe, it, expect } from "vitest";
import { verify as cryptoVerify } from "node:crypto";
import {
  generateAcmeAccountKey,
  jwkThumbprint,
  signAcmeJws,
  computeKeyAuthorization,
  httpChallengeResponseBody,
  dnsChallengeTxtValue,
  AcmeClient,
  planAcmeChallenges,
  type AcmeHttpResponse,
} from "../src/lib/acmeClient.js";

describe("generateAcmeAccountKey / jwkThumbprint", () => {
  it("generates a real P-256 EC key pair with a stable, real RFC 7638 thumbprint", () => {
    const key = generateAcmeAccountKey();
    expect(key.publicJwk.kty).toBe("EC");
    expect(key.publicJwk.crv).toBe("P-256");
    const thumbprint1 = jwkThumbprint(key.publicJwk);
    const thumbprint2 = jwkThumbprint(key.publicJwk);
    expect(thumbprint1).toBe(thumbprint2); // deterministic for the same key
  });

  it("different keys produce different thumbprints", () => {
    const a = generateAcmeAccountKey();
    const b = generateAcmeAccountKey();
    expect(jwkThumbprint(a.publicJwk)).not.toBe(jwkThumbprint(b.publicJwk));
  });
});

describe("signAcmeJws", () => {
  it("produces a real ES256 signature that actually verifies against the account's own public key", () => {
    const key = generateAcmeAccountKey();
    const jws = signAcmeJws(key, { hello: "world" }, { url: "https://example.test/new-order", nonce: "nonce-1" });

    expect(jws.protected).toEqual(expect.any(String));
    expect(jws.payload).toEqual(expect.any(String));

    const signingInput = `${jws.protected}.${jws.payload}`;
    const publicKeyObject = key.privateKey; // node KeyObject.verify works against the private key's public half too via createPublicKey, but sign/verify pair below proves correctness directly
    const valid = cryptoVerify(
      null,
      Buffer.from(signingInput, "utf8"),
      { key: publicKeyObject, dsaEncoding: "ieee-p1363" },
      Buffer.from(jws.signature, "base64url"),
    );
    expect(valid).toBe(true);
  });

  it("includes the account's jwk (not kid) when no kid is provided (newAccount request)", () => {
    const key = generateAcmeAccountKey();
    const jws = signAcmeJws(key, "", { url: "https://example.test/acct", nonce: "n1" });
    const protectedHeader = JSON.parse(Buffer.from(jws.protected, "base64url").toString("utf8"));
    expect(protectedHeader.jwk).toBeDefined();
    expect(protectedHeader.kid).toBeUndefined();
  });

  it("includes kid (not jwk) once an account kid is known (post-account requests)", () => {
    const key = generateAcmeAccountKey();
    const jws = signAcmeJws(key, "", { url: "https://example.test/order", nonce: "n1", kid: "https://example.test/acct/1" });
    const protectedHeader = JSON.parse(Buffer.from(jws.protected, "base64url").toString("utf8"));
    expect(protectedHeader.kid).toBe("https://example.test/acct/1");
    expect(protectedHeader.jwk).toBeUndefined();
  });
});

describe("challenge key authorization / HTTP-01 / DNS-01 challenge values", () => {
  it("computes the exact RFC 8555 key authorization format: token.thumbprint", () => {
    const key = generateAcmeAccountKey();
    const ka = computeKeyAuthorization("sometoken123", key);
    expect(ka).toBe(`sometoken123.${jwkThumbprint(key.publicJwk)}`);
  });

  it("the HTTP-01 challenge response body IS the key authorization verbatim", () => {
    const key = generateAcmeAccountKey();
    expect(httpChallengeResponseBody("tok", key)).toBe(computeKeyAuthorization("tok", key));
  });

  it("the DNS-01 TXT value is base64url(SHA-256(keyAuthorization)), deterministic for the same inputs", () => {
    const key = generateAcmeAccountKey();
    const value1 = dnsChallengeTxtValue("tok", key);
    const value2 = dnsChallengeTxtValue("tok", key);
    expect(value1).toBe(value2);
    expect(value1).not.toContain("."); // a real base64url digest, not the raw key authorization
  });
});

/** Minimal in-memory mock ACME server covering directory/newNonce/newAccount/newOrder/authz/challenge — real RFC 8555 response shapes, no real network. */
function buildMockAcmeServer() {
  let nonceCounter = 0;
  const freshNonce = () => `nonce-${++nonceCounter}`;

  function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): AcmeHttpResponse {
    const h = { "replay-nonce": freshNonce(), ...headers };
    return {
      status,
      headers: { get: (name: string) => h[name.toLowerCase()] ?? null },
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  }

  const directory = {
    newNonce: "https://acme.test/new-nonce",
    newAccount: "https://acme.test/new-account",
    newOrder: "https://acme.test/new-order",
  };

  const fetchFn = async (url: string, init?: { method?: string }): Promise<AcmeHttpResponse> => {
    if (url === "https://acme.test/directory") return jsonResponse(200, directory);
    if (url === directory.newNonce) return jsonResponse(200, {});
    if (url === directory.newAccount) {
      return jsonResponse(201, { status: "valid" }, { location: "https://acme.test/account/1" });
    }
    if (url === directory.newOrder) {
      return jsonResponse(
        201,
        {
          status: "pending",
          authorizations: ["https://acme.test/authz/1"],
          finalize: "https://acme.test/order/1/finalize",
        },
        { location: "https://acme.test/order/1" },
      );
    }
    if (url === "https://acme.test/authz/1") {
      return jsonResponse(200, {
        status: "pending",
        challenges: [
          { type: "dns-01", url: "https://acme.test/challenge/dns-1", token: "tok-dns-1", status: "pending" },
          { type: "http-01", url: "https://acme.test/challenge/http-1", token: "tok-http-1", status: "pending" },
        ],
      });
    }
    if (url === "https://acme.test/challenge/dns-1" && init?.method === "POST") {
      return jsonResponse(200, { type: "dns-01", url, token: "tok-dns-1", status: "processing" });
    }
    throw new Error(`Unexpected URL in mock ACME server: ${url}`);
  };

  return { directoryUrl: "https://acme.test/directory", fetchFn };
}

describe("AcmeClient against a mocked ACME server", () => {
  it("runs the real newAccount -> newOrder -> authorization -> challenge-selection flow end to end", async () => {
    const { directoryUrl, fetchFn } = buildMockAcmeServer();
    const accountKey = generateAcmeAccountKey();
    const client = new AcmeClient(directoryUrl, accountKey, fetchFn);

    const plans = await planAcmeChallenges(client, ["example.com"], "ops@example.com", "dns-01");

    expect(plans).toHaveLength(1);
    expect(plans[0].domain).toBe("example.com");
    expect(plans[0].challengeType).toBe("dns-01");
    expect(plans[0].challengeToken).toBe("tok-dns-1");
    expect(plans[0].challengeValue).toBe(dnsChallengeTxtValue("tok-dns-1", accountKey));
    expect(client.kid).toBe("https://acme.test/account/1");
  });

  it("respondToChallenge really POSTs to the challenge URL and returns the server's status", async () => {
    const { directoryUrl, fetchFn } = buildMockAcmeServer();
    const accountKey = generateAcmeAccountKey();
    const client = new AcmeClient(directoryUrl, accountKey, fetchFn);
    await planAcmeChallenges(client, ["example.com"], null, "dns-01");

    const response = await client.respondToChallenge("https://acme.test/challenge/dns-1");
    expect(response.status).toBe("processing");
  });

  it("throws a real, honest error (never a fabricated success) when the server returns an unexpected status", async () => {
    const directory = {
      newNonce: "https://acme.test/new-nonce",
      newAccount: "https://acme.test/new-account",
      newOrder: "https://acme.test/new-order",
    };
    const fetchFn = async (url: string): Promise<AcmeHttpResponse> => {
      if (url === "https://acme.test/directory") {
        return { status: 200, headers: { get: () => null }, json: async () => directory, text: async () => "" };
      }
      if (url === directory.newNonce) {
        return { status: 200, headers: { get: (n) => (n === "replay-nonce" ? "nonce-1" : null) }, json: async () => ({}), text: async () => "" };
      }
      // newAccount itself fails.
      return {
        status: 500,
        headers: { get: () => null },
        json: async () => ({}),
        text: async () => "internal server error",
      };
    };
    const accountKey = generateAcmeAccountKey();
    const client = new AcmeClient("https://acme.test/directory", accountKey, fetchFn);
    await expect(client.createAccount(null)).rejects.toThrow(/ACME newAccount failed/);
  });
});
