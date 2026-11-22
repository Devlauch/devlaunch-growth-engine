/**
 * Thin health-check adapter matching the generic contract
 * `routes/integrations.ts`'s `POST /:provider/health-check` route expects
 * (dynamic-imports `../lib/${provider}Client.js` and calls `checkHealth` if
 * exported — see that file's own doc comment for the contract), following
 * the exact same pattern as `hunterClient.ts`/`apolloClient.ts`.
 *
 * Deliberately self-contained (does NOT import Agent A1's forthcoming
 * `packages/agent-sdk/src/connectors/googleSearchConnector.ts`, which did
 * not exist in this worktree at the time this file was written — see
 * docs/PHASE_2_CREDENTIAL_AND_COST_REPORT.md for why): a minimal,
 * independent real HTTP call against Google's Custom Search JSON API
 * (https://developers.google.com/custom-search/v1/overview), `num: 1`, a
 * harmless fixed query, so this module has no build-time dependency on a
 * file another agent is concurrently writing. Once A1's connector lands,
 * the orchestrator may choose to have this file delegate to it instead —
 * noted here rather than silently duplicated forever.
 *
 * Google's Custom Search API requires BOTH an API key and a Programmable
 * Search Engine ID ("cx") — see providerCredentials.ts's
 * resolveGoogleSearchCredential, which is what the integration row's
 * `config.engineId` / `env.googleSearchEngineId` fallback plumbing follows.
 * This health-check reads `credential.config.engineId` directly (mirroring
 * that same resolution without re-importing a PoolClient-shaped resolver
 * here, since the generic health-check route already resolved
 * `config`/`secret` for us) — a missing engine id is reported as
 * "not_configured", the same honest status as a missing API key, never a
 * fabricated "connected".
 *
 * No real Google Custom Search API key is available in this environment —
 * this function is real, working code, but has only ever been exercised
 * against mocked `fetch` responses (see test/googleClient.test.ts), never
 * Google's live API. That gap is honestly reported, not hidden.
 */

const GOOGLE_CUSTOM_SEARCH_ENDPOINT = "https://www.googleapis.com/customsearch/v1";
const HEALTH_CHECK_TIMEOUT_MS = 8000;

export async function checkHealth(credential: {
  config: Record<string, unknown>;
  secret: string | null;
}): Promise<{ status: string; detail?: string }> {
  const engineId = typeof credential.config.engineId === "string" ? credential.config.engineId.trim() : "";

  if (!credential.secret || !engineId) {
    const missing = [!credential.secret ? "API key" : null, !engineId ? "Search Engine ID (cx)" : null]
      .filter(Boolean)
      .join(" and ");
    return { status: "not_configured", detail: `Google Custom Search is missing its ${missing} for this tenant/project.` };
  }

  const url = new URL(GOOGLE_CUSTOM_SEARCH_ENDPOINT);
  url.searchParams.set("key", credential.secret);
  url.searchParams.set("cx", engineId);
  url.searchParams.set("q", "health check");
  url.searchParams.set("num", "1");

  let response: Response;
  try {
    response = await fetch(url.toString(), { signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS) });
  } catch (err) {
    return {
      status: "error",
      detail: `Network error reaching Google's Custom Search API: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (response.status === 400 || response.status === 403) {
    return { status: "error", detail: `Google Custom Search authentication/config failed (HTTP ${response.status}) — the stored API key or Search Engine ID is missing, invalid, or lacks permission.` };
  }
  if (response.status === 429) {
    return { status: "error", detail: "Google Custom Search daily quota or rate limit exceeded (HTTP 429)." };
  }
  if (!response.ok) {
    return { status: "error", detail: `Google Custom Search API returned HTTP ${response.status}.` };
  }
  return { status: "connected" };
}
