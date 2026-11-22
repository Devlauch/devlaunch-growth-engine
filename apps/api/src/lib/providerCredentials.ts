import type { PoolClient } from "pg";
import { env } from "../config/env.js";
import { getIntegrationCredential } from "./integrationCredentials.js";

/**
 * Phase 2 reconciliation (Agent A2): shared credential-resolution helpers
 * for Apollo and Google, following the EXACT same convention
 * `hunterProvider.ts`'s `resolveHunterApiKey` already established — a thin
 * wrapper over `integrationCredentials.ts`'s `getIntegrationCredential`
 * (which itself is the only consumer of `credentialEncryption.ts` outside
 * `routes/integrations.ts`), never a parallel credential system.
 *
 * Intended consumers: Agent A1's `apolloDecisionMakerProvider.ts` and
 * `googleSearchConnector.ts` (business logic — out of this agent's scope)
 * should call these instead of reading `process.env.APOLLO_API_KEY` /
 * `process.env.GOOGLE_SEARCH_API_KEY` directly, so a tenant's own stored
 * credential (via POST /integrations/apollo/connect or .../google/connect)
 * takes priority over the env-var fallback, exactly like every other real
 * provider in this codebase. `apps/api/src/lib/apolloClient.ts` /
 * `googleClient.ts` (this agent's own health-check adapters) already use
 * them — see those files.
 *
 * Resolution order (never silently different per provider): tenant's own
 * encrypted credential first, `env.*` fallback second, `null` (never
 * thrown, never guessed) when neither is configured — callers decide
 * whether that's a hard error or an honest "not configured" status.
 */

export async function resolveApolloApiKey(
  tenantDb: Pick<PoolClient, "query">,
  tenantId: string,
  projectId: string,
): Promise<string | null> {
  const resolved = await getIntegrationCredential(tenantDb as PoolClient, tenantId, projectId, "apollo");
  return resolved?.secret ?? env.apolloApiKey ?? null;
}

export interface GoogleSearchCredential {
  apiKey: string;
  engineId: string;
}

/**
 * Google's Custom Search JSON API requires BOTH an API key and a
 * Programmable Search Engine ID ("cx") — neither alone is a usable
 * credential. The engine id is not a secret (it's safe to echo back / store
 * as plain `config.engineId`, same non-secret-settings convention as
 * listmonk's `config.baseUrl`); only the API key goes through
 * `encryptCredential`. Returns `null` (never a half-populated object) unless
 * BOTH are resolvable, from either the tenant's own stored row or the
 * `env.googleSearch*` fallback — never mixing a tenant's key with a
 * different tenant's/env's engine id implicitly, since both come from the
 * same resolved source per call.
 */
export async function resolveGoogleSearchCredential(
  tenantDb: Pick<PoolClient, "query">,
  tenantId: string,
  projectId: string,
): Promise<GoogleSearchCredential | null> {
  const resolved = await getIntegrationCredential(tenantDb as PoolClient, tenantId, projectId, "google");
  const apiKey = resolved?.secret ?? env.googleSearchApiKey ?? null;
  const configEngineId = resolved?.config?.engineId;
  const engineId = (typeof configEngineId === "string" && configEngineId.trim() ? configEngineId : null) ?? env.googleSearchEngineId ?? null;
  if (!apiKey || !engineId) return null;
  return { apiKey, engineId };
}
