import type pg from "pg";
import { decryptCredential, isCredentialEncryptionConfigured } from "./credentialEncryption.js";
import { logger } from "./logger.js";

/**
 * Shared read-side resolver for the `integrations` table, for other
 * modules (the real listmonk/chatwoot/postiz clients other agents are
 * building concurrently — see docs/INTEGRATION_STATUS.md) to fetch a
 * tenant's stored config + decrypted secret for a provider, without each
 * one re-implementing the lookup/decrypt dance.
 *
 * Returns null when no integration row exists for this
 * (tenantId, projectId, provider) yet — callers must treat that as
 * "not connected", never throw.
 *
 * `secret` is null when the row has no `encrypted_credential_ref` (e.g. a
 * provider that doesn't need one, or a pre-Milestone-2 placeholder row) OR
 * when credential encryption isn't configured in this environment — in the
 * latter case this logs a warning rather than throwing, because a caller
 * asking "what's connected" should still get the row's config/status; it
 * is the caller's job (e.g. a health-check or outbound-sync route) to
 * decide that a missing secret means it can't proceed.
 */
export interface ResolvedIntegrationCredential {
  config: Record<string, unknown>;
  secret: string | null;
  status: string;
}

export async function getIntegrationCredential(
  tenantDb: pg.PoolClient,
  tenantId: string,
  projectId: string,
  provider: string,
): Promise<ResolvedIntegrationCredential | null> {
  const result = await tenantDb.query(
    `SELECT config, encrypted_credential_ref, status
     FROM integrations
     WHERE tenant_id = $1 AND project_id = $2 AND provider = $3`,
    [tenantId, projectId, provider],
  );
  if (result.rowCount === 0) return null;

  const row = result.rows[0] as { config: Record<string, unknown> | null; encrypted_credential_ref: string | null; status: string };

  let secret: string | null = null;
  if (row.encrypted_credential_ref) {
    if (!isCredentialEncryptionConfigured()) {
      logger.warn(
        { tenantId, projectId, provider },
        "integration has a stored credential but INTEGRATION_CREDENTIALS_KEY is not configured — cannot decrypt",
      );
    } else {
      try {
        // The connect route (apps/api/src/routes/integrations.ts) always
        // encrypts the raw secret string directly — encryptCredential(secret)
        // — so decryption yields that same string back.
        secret = decryptCredential<string>(row.encrypted_credential_ref);
      } catch (err) {
        logger.error({ tenantId, projectId, provider, err }, "failed to decrypt stored integration credential");
        secret = null;
      }
    }
  }

  return {
    config: row.config ?? {},
    secret,
    status: row.status,
  };
}
