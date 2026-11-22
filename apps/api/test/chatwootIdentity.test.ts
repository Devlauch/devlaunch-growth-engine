import { createHmac } from "node:crypto";
import { describe, it, expect } from "vitest";
import {
  buildChatwootIdentity,
  buildNamespacedIdentifier,
  ChatwootIdentityNotConfiguredError,
  computeIdentifierHash,
  parseChatwootSecret,
  verifyIdentifierHash,
} from "../src/lib/chatwootIdentity.js";

describe("parseChatwootSecret — backward-compatible secret envelope", () => {
  it("treats a bare api_access_token string as apiAccessToken with no widgetHmacToken (every pre-existing tenant)", () => {
    expect(parseChatwootSecret("plain-token-abc123")).toEqual({
      apiAccessToken: "plain-token-abc123",
      widgetHmacToken: null,
    });
  });

  it("parses a JSON envelope with both fields", () => {
    const secret = JSON.stringify({ apiAccessToken: "tok-1", widgetHmacToken: "hmac-tok-1" });
    expect(parseChatwootSecret(secret)).toEqual({ apiAccessToken: "tok-1", widgetHmacToken: "hmac-tok-1" });
  });

  it("parses a JSON envelope missing widgetHmacToken as null (opted out)", () => {
    const secret = JSON.stringify({ apiAccessToken: "tok-1" });
    expect(parseChatwootSecret(secret)).toEqual({ apiAccessToken: "tok-1", widgetHmacToken: null });
  });

  it("falls back to treating malformed JSON-looking strings as a bare token, never throwing", () => {
    const weird = '{not-real-json-but-starts-with-brace';
    expect(parseChatwootSecret(weird)).toEqual({ apiAccessToken: weird, widgetHmacToken: null });
  });

  it("returns all-null for null/undefined/empty secret", () => {
    expect(parseChatwootSecret(null)).toEqual({ apiAccessToken: null, widgetHmacToken: null });
    expect(parseChatwootSecret(undefined)).toEqual({ apiAccessToken: null, widgetHmacToken: null });
    expect(parseChatwootSecret("")).toEqual({ apiAccessToken: null, widgetHmacToken: null });
  });
});

describe("computeIdentifierHash — exact Chatwoot hmac_concern.rb scheme", () => {
  it("matches an independently computed HMAC-SHA256(hmacToken, identifier)", () => {
    const hmacToken = "inbox-hmac-token-xyz";
    const identifier = "platform-user:tenant-1:project-1:user-42";
    const expected = createHmac("sha256", hmacToken).update(identifier).digest("hex");
    expect(computeIdentifierHash(hmacToken, identifier)).toBe(expected);
  });

  it("produces a different hash for a different identifier (no collision for adjacent inputs)", () => {
    const hmacToken = "inbox-hmac-token-xyz";
    const a = computeIdentifierHash(hmacToken, "user-1");
    const b = computeIdentifierHash(hmacToken, "user-2");
    expect(a).not.toBe(b);
  });

  it("produces a different hash for the same identifier under a different hmac token", () => {
    const identifier = "user-1";
    const a = computeIdentifierHash("token-a", identifier);
    const b = computeIdentifierHash("token-b", identifier);
    expect(a).not.toBe(b);
  });
});

describe("buildNamespacedIdentifier — tenant isolation of the signed identifier", () => {
  it("embeds tenantId and projectId so the same raw user id differs across tenants/projects", () => {
    const idA = buildNamespacedIdentifier("tenant-A", "project-1", "42");
    const idB = buildNamespacedIdentifier("tenant-B", "project-1", "42");
    const idC = buildNamespacedIdentifier("tenant-A", "project-2", "42");
    expect(idA).not.toBe(idB);
    expect(idA).not.toBe(idC);
    expect(idA).toContain("tenant-A");
    expect(idA).toContain("project-1");
    expect(idA).toContain("42");
  });

  it("means a hash valid for one tenant's namespaced identifier is NOT valid for another tenant's, even under a shared hmac token", () => {
    const sharedHmacToken = "shared-token-across-two-inboxes";
    const identifierA = buildNamespacedIdentifier("tenant-A", "project-1", "42");
    const identifierB = buildNamespacedIdentifier("tenant-B", "project-1", "42");

    const hashForA = computeIdentifierHash(sharedHmacToken, identifierA);

    // An attacker who captured tenant A's {identifier, hash} pair cannot
    // replay it against tenant B's namespace: Chatwoot's own verification
    // (hmac_concern.rb) requires params[:identifier] == contact.identifier,
    // and even if it didn't, the hash itself is only valid for identifierA.
    expect(verifyIdentifierHash(sharedHmacToken, identifierB, hashForA)).toBe(false);
  });
});

describe("buildChatwootIdentity / verifyIdentifierHash — forged vs. correctly-signed", () => {
  const HMAC_TOKEN = "real-inbox-hmac-token";
  const TENANT = "tenant-1";
  const PROJECT = "project-1";
  const RAW_USER_ID = "user-42";

  it("a correctly-signed identifier/hash pair is accepted", () => {
    const { identifier, identifierHash } = buildChatwootIdentity(HMAC_TOKEN, TENANT, PROJECT, RAW_USER_ID);
    expect(verifyIdentifierHash(HMAC_TOKEN, identifier, identifierHash)).toBe(true);
  });

  it("a forged hash (attacker guesses/fabricates a hex string) is rejected", () => {
    const { identifier } = buildChatwootIdentity(HMAC_TOKEN, TENANT, PROJECT, RAW_USER_ID);
    const forgedHash = "0".repeat(64); // same length as a real sha256 hex digest, but not the real HMAC
    expect(verifyIdentifierHash(HMAC_TOKEN, identifier, forgedHash)).toBe(false);
  });

  it("a hash computed with the WRONG hmac token (attacker doesn't know the real secret) is rejected", () => {
    const { identifier, identifierHash: wrongHash } = buildChatwootIdentity(
      "attacker-guessed-token",
      TENANT,
      PROJECT,
      RAW_USER_ID,
    );
    expect(verifyIdentifierHash(HMAC_TOKEN, identifier, wrongHash)).toBe(false);
  });

  it("a correctly-signed hash for a DIFFERENT identifier is rejected (tampered identifier after signing)", () => {
    const { identifierHash } = buildChatwootIdentity(HMAC_TOKEN, TENANT, PROJECT, RAW_USER_ID);
    const tamperedIdentifier = buildNamespacedIdentifier(TENANT, PROJECT, "user-99");
    expect(verifyIdentifierHash(HMAC_TOKEN, tamperedIdentifier, identifierHash)).toBe(false);
  });

  it("a missing hash is rejected (empty string never matches a real digest)", () => {
    const { identifier } = buildChatwootIdentity(HMAC_TOKEN, TENANT, PROJECT, RAW_USER_ID);
    expect(verifyIdentifierHash(HMAC_TOKEN, identifier, "")).toBe(false);
  });

  it("throws ChatwootIdentityNotConfiguredError when no widgetHmacToken is configured, never fabricating a hash", () => {
    expect(() => buildChatwootIdentity(null, TENANT, PROJECT, RAW_USER_ID)).toThrow(
      ChatwootIdentityNotConfiguredError,
    );
    expect(() => buildChatwootIdentity(undefined, TENANT, PROJECT, RAW_USER_ID)).toThrow(
      ChatwootIdentityNotConfiguredError,
    );
    expect(() => buildChatwootIdentity("", TENANT, PROJECT, RAW_USER_ID)).toThrow(
      ChatwootIdentityNotConfiguredError,
    );
  });
});
