/**
 * Chatwoot "Identity Validation" (HMAC contact-identifier signing) support.
 *
 * Milestone 3, Phase 1 — closes the gap docs/INTEGRATION_STATUS.md section
 * 7/10 and docs/SECURITY_REVIEW.md explicitly flagged as open:
 * "anonymous-visitor-only this phase (no per-user HMAC contact-identifier
 * signing yet)". This module is ADDITIVE — the existing anonymous-visitor
 * widget path (packages/embed-widget/chatwootWidget.js with no
 * identifier/identifier_hash) is completely untouched and keeps working
 * exactly as before. This only adds a way for an AUTHENTICATED platform
 * user's chat session to also assert a cryptographically-verifiable
 * identity to Chatwoot, when the tenant has opted in by configuring a
 * widget HMAC token.
 *
 * Exact scheme confirmed directly against the reference clone
 * (~/project/Growth/chatwoot, read-only, never modified):
 *   - `swagger/parameters/public/identifier_hash.yml`: "HMAC-SHA256 of the
 *     contact identifier, signed with the inbox HMAC token. Required when
 *     the inbox enforces identity validation."
 *   - `app/controllers/public/api/v1/inboxes/contacts_controller.rb`'s
 *     `valid_hmac?` / `app/controllers/concerns/hmac_concern.rb`'s
 *     `hmac_verified?`: both compute
 *       expected = OpenSSL::HMAC.hexdigest('sha256', inbox_channel.hmac_token, identifier)
 *     and compare it to the client-supplied `identifier_hash` with
 *     `ActiveSupport::SecurityUtils.secure_compare` (constant-time) — i.e.
 *     HMAC-SHA256(key = the INBOX's own hmac_token, message = the plain
 *     identifier string), hex-encoded. Not JSON, not salted with a
 *     timestamp — just that one HMAC over the identifier string, exactly
 *     mirrored here.
 *   - Chatwoot's own widget SDK (`app/javascript/entrypoints/sdk.js`'s
 *     `setUser(identifier, user)`) sends `identifier_hash` as one of
 *     `user`'s allowed keys (`app/javascript/sdk/cookieHelpers.js`'s
 *     `ALLOWED_USER_ATTRIBUTES`), fired after the `chatwoot:ready` event
 *     (`app/javascript/widget/constants/sdkEvents.js`'s `CHATWOOT_READY =
 *     'chatwoot:ready'`) — see chatwootWidget.js's updated doc comment for
 *     the exact client-side call this module's output feeds.
 *
 * Where the HMAC token lives: Chatwoot's own per-inbox "Identity
 * Validation" HMAC token is a SECOND secret, distinct from the account-wide
 * `api_access_token` chatwootClient.ts already stores as
 * `integrations.encrypted_credential_ref`'s single `secret` string. Rather
 * than widen the shared `integrations` table's credential contract (that
 * schema and apps/api/src/routes/integrations.ts's generic connect/
 * health-check routes are shared foundation this agent does not own — see
 * docs/INTEGRATION_STATUS.md section 6), this module reuses the existing
 * single opaque `secret` string as a small JSON envelope:
 *   secret = JSON.stringify({ apiAccessToken: "...", widgetHmacToken: "..." })
 * `parseChatwootSecret` below is fully backward compatible: a secret that
 * is NOT that JSON shape (every tenant connected before this change, and
 * every existing test) is treated as a bare apiAccessToken with no
 * widgetHmacToken configured — zero behavior change for anyone not opting
 * in to identity verification.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export interface ParsedChatwootSecret {
  apiAccessToken: string | null;
  /** The per-inbox "Identity Validation" HMAC token, if this tenant has opted in. */
  widgetHmacToken: string | null;
}

/**
 * Accepts either:
 *   - a bare api_access_token string (back-compat — every credential
 *     connected before this change, and the shape every existing test in
 *     chatwootClient.test.ts/chatwootIntegration.test.ts uses), or
 *   - a JSON envelope `{ apiAccessToken, widgetHmacToken }`.
 * Never throws — a malformed/unexpected JSON string is honestly treated as
 * a bare token (the whole original string), never silently dropped.
 */
export function parseChatwootSecret(secret: string | null | undefined): ParsedChatwootSecret {
  if (!secret) return { apiAccessToken: null, widgetHmacToken: null };

  const trimmed = secret.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (parsed && typeof parsed === "object" && "apiAccessToken" in parsed) {
        return {
          apiAccessToken: typeof parsed.apiAccessToken === "string" ? parsed.apiAccessToken : null,
          widgetHmacToken: typeof parsed.widgetHmacToken === "string" ? parsed.widgetHmacToken : null,
        };
      }
    } catch {
      // Not actually JSON (e.g. a real api_access_token that happens to
      // start with "{") — fall through to the bare-token path below.
    }
  }

  return { apiAccessToken: secret, widgetHmacToken: null };
}

export class ChatwootIdentityNotConfiguredError extends Error {
  constructor() {
    super(
      "No Chatwoot widget HMAC token is configured for this tenant/project — identity verification is opt-in; " +
        "connect with secret = JSON.stringify({ apiAccessToken, widgetHmacToken }) (widgetHmacToken from Chatwoot's " +
        "Inbox Settings > Configuration > 'Enable Identity Validation') to enable it.",
    );
    this.name = "ChatwootIdentityNotConfiguredError";
  }
}

/**
 * Computes the exact `identifier_hash` Chatwoot's own `hmac_concern.rb`
 * expects: HMAC-SHA256(key = widgetHmacToken, message = identifier), hex.
 */
export function computeIdentifierHash(widgetHmacToken: string, identifier: string): string {
  return createHmac("sha256", widgetHmacToken).update(identifier).digest("hex");
}

/**
 * Namespaces a platform user's raw id/email into a per-tenant-and-project
 * identifier string before it is ever signed or sent to Chatwoot.
 *
 * Why this matters for tenant isolation specifically: several platform
 * tenants/projects can be mapped onto Chatwoot inboxes that share the SAME
 * widgetHmacToken (e.g. one Chatwoot account, several inboxes under it, an
 * operator who reuses one HMAC token across inboxes for convenience).
 * Without namespacing, a correctly-signed identifier for tenant A's user
 * "42" would also be a valid, correctly-signed identifier for tenant B's
 * own contact lookup if tenant B also happens to have a contact literally
 * identified "42" — the HMAC proves the STRING wasn't forged, it says
 * nothing about which tenant "owns" that string. Folding tenantId/
 * projectId into the identifier itself (not just the hash) means a replayed
 * or copy-pasted {identifier, identifier_hash} pair from one tenant/project
 * can never resolve to a different tenant/project's contact namespace, even
 * under a shared HMAC token.
 */
export function buildNamespacedIdentifier(tenantId: string, projectId: string, rawUserId: string): string {
  return `platform-user:${tenantId}:${projectId}:${rawUserId}`;
}

export interface ChatwootIdentityResult {
  identifier: string;
  identifierHash: string;
}

/** Throws ChatwootIdentityNotConfiguredError if widgetHmacToken is missing/empty. */
export function buildChatwootIdentity(
  widgetHmacToken: string | null | undefined,
  tenantId: string,
  projectId: string,
  rawUserId: string,
): ChatwootIdentityResult {
  if (!widgetHmacToken) throw new ChatwootIdentityNotConfiguredError();
  const identifier = buildNamespacedIdentifier(tenantId, projectId, rawUserId);
  return { identifier, identifierHash: computeIdentifierHash(widgetHmacToken, identifier) };
}

/**
 * Verifies a client-asserted {identifier, identifierHash} pair against a
 * widgetHmacToken, mirroring Chatwoot's own constant-time comparison
 * (`ActiveSupport::SecurityUtils.secure_compare` -> Node's
 * `timingSafeEqual`, length-checked first since timingSafeEqual throws on
 * mismatched buffer lengths rather than returning false).
 *
 * Not called by Chatwoot itself (that verification happens inside
 * Chatwoot's own Rails code, already confirmed above, and is out of this
 * platform's process) — this exists so platform's own tests, and any
 * future platform-side re-verification of a client-supplied hash, don't
 * have to re-derive the scheme ad hoc.
 */
export function verifyIdentifierHash(widgetHmacToken: string, identifier: string, providedHash: string): boolean {
  const expected = computeIdentifierHash(widgetHmacToken, identifier);
  const expectedBuf = Buffer.from(expected, "utf8");
  const providedBuf = Buffer.from(providedHash, "utf8");
  if (expectedBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(expectedBuf, providedBuf);
}
