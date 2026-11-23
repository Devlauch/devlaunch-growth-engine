import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const ORIGINAL_KEY = process.env.INTEGRATION_CREDENTIALS_KEY;

describe("credentialEncryption", () => {
  afterEach(() => {
    vi.resetModules();
    if (ORIGINAL_KEY === undefined) delete process.env.INTEGRATION_CREDENTIALS_KEY;
    else process.env.INTEGRATION_CREDENTIALS_KEY = ORIGINAL_KEY;
  });

  it("round-trips an arbitrary JSON payload", async () => {
    process.env.INTEGRATION_CREDENTIALS_KEY = Buffer.alloc(32, 7).toString("base64");
    vi.resetModules();
    const { encryptCredential, decryptCredential } = await import("../src/lib/credentialEncryption.js");
    const payload = { apiKey: "sk_live_abc123", baseUrl: "https://listmonk.example.com" };
    const stored = encryptCredential(payload);
    expect(stored.startsWith("v1.")).toBe(true);
    expect(stored).not.toContain("sk_live_abc123");
    expect(decryptCredential(stored)).toEqual(payload);
  });

  it("produces a different ciphertext each time (random IV) for the same payload", async () => {
    process.env.INTEGRATION_CREDENTIALS_KEY = Buffer.alloc(32, 7).toString("base64");
    vi.resetModules();
    const { encryptCredential } = await import("../src/lib/credentialEncryption.js");
    const a = encryptCredential({ x: 1 });
    const b = encryptCredential({ x: 1 });
    expect(a).not.toEqual(b);
  });

  it("throws CredentialEncryptionNotConfiguredError when no key is set", async () => {
    delete process.env.INTEGRATION_CREDENTIALS_KEY;
    vi.resetModules();
    const { encryptCredential, CredentialEncryptionNotConfiguredError, isCredentialEncryptionConfigured } =
      await import("../src/lib/credentialEncryption.js");
    expect(isCredentialEncryptionConfigured()).toBe(false);
    expect(() => encryptCredential({ x: 1 })).toThrow(CredentialEncryptionNotConfiguredError);
  });

  it("rejects a key that doesn't decode to exactly 32 bytes", async () => {
    process.env.INTEGRATION_CREDENTIALS_KEY = Buffer.alloc(16, 1).toString("base64");
    vi.resetModules();
    const { encryptCredential } = await import("../src/lib/credentialEncryption.js");
    expect(() => encryptCredential({ x: 1 })).toThrow(/32 bytes/);
  });

  it("fails to decrypt a tampered ciphertext (auth tag mismatch)", async () => {
    process.env.INTEGRATION_CREDENTIALS_KEY = Buffer.alloc(32, 7).toString("base64");
    vi.resetModules();
    const { encryptCredential, decryptCredential } = await import("../src/lib/credentialEncryption.js");
    const stored = encryptCredential({ x: 1 });
    const tampered = stored.slice(0, -4) + "abcd";
    expect(() => decryptCredential(tampered)).toThrow();
  });
});
