/**
 * credentialEncryption: envelope encryption for third-party integration
 * credentials (listmonk API key, chatwoot access token, postiz API key/OAuth
 * tokens) stored in `integrations.encrypted_credential_ref`.
 *
 * AES-256-GCM, key from env.integrationCredentialsKey (base64, 32 bytes).
 * Each ciphertext carries its own random IV and auth tag so the stored
 * string is self-contained: base64("v1." + iv(12) + tag(16) + ciphertext).
 *
 * Honest-failure convention (matches NotConfiguredError elsewhere in this
 * codebase): with no key configured, encrypt/decrypt throw
 * CredentialEncryptionNotConfiguredError rather than silently storing
 * plaintext or a weak default key. There is no fallback dev key, unlike
 * JWT secrets — this key protects real third-party secrets a tenant enters.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "../config/env.js";

export class CredentialEncryptionNotConfiguredError extends Error {
  constructor() {
    super("INTEGRATION_CREDENTIALS_KEY is not configured — cannot encrypt/decrypt integration credentials");
    this.name = "CredentialEncryptionNotConfiguredError";
  }
}

const ALGO = "aes-256-gcm";
const IV_LENGTH = 12;
const VERSION_PREFIX = "v1.";

function loadKey(): Buffer {
  if (!env.integrationCredentialsKey) throw new CredentialEncryptionNotConfiguredError();
  const key = Buffer.from(env.integrationCredentialsKey, "base64");
  if (key.length !== 32) {
    throw new Error(
      `INTEGRATION_CREDENTIALS_KEY must decode to exactly 32 bytes (got ${key.length}) — generate one with e.g. \`openssl rand -base64 32\``,
    );
  }
  return key;
}

/** Encrypts an arbitrary JSON-serializable credential payload (e.g. {apiKey, baseUrl}). */
export function encryptCredential(payload: unknown): string {
  const key = loadKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGO, key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return VERSION_PREFIX + Buffer.concat([iv, tag, ciphertext]).toString("base64");
}

/** Decrypts a value produced by encryptCredential, returning the original payload. */
export function decryptCredential<T = unknown>(stored: string): T {
  const key = loadKey();
  if (!stored.startsWith(VERSION_PREFIX)) {
    throw new Error("Unrecognized credential envelope format (missing v1. prefix)");
  }
  const raw = Buffer.from(stored.slice(VERSION_PREFIX.length), "base64");
  const iv = raw.subarray(0, IV_LENGTH);
  const tag = raw.subarray(IV_LENGTH, IV_LENGTH + 16);
  const ciphertext = raw.subarray(IV_LENGTH + 16);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8")) as T;
}

/** Whether encryption is actually usable right now — check before offering a "connect" UI action. */
export function isCredentialEncryptionConfigured(): boolean {
  try {
    loadKey();
    return true;
  } catch {
    return false;
  }
}
