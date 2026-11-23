/**
 * Thin health-check adapter matching the generic contract
 * `routes/integrations.ts`'s `POST /:provider/health-check` route expects
 * (dynamic-imports `../lib/${provider}Client.js` and calls `checkHealth` if
 * exported — see that file's own doc comment for the contract), following
 * the exact same pattern as `hunterClient.ts`.
 *
 * Deliberately self-contained (does NOT import Agent A1's forthcoming
 * `apolloDecisionMakerProvider.ts`, which did not exist in this worktree at
 * the time this file was written — see
 * docs/PHASE_2_CREDENTIAL_AND_COST_REPORT.md for why): a minimal,
 * independent real HTTP call against Apollo's People Search endpoint
 * (`per_page: 1`, no filters beyond a harmless generic title), the same
 * endpoint Phase 2's own `ApolloDecisionMakerProvider` used, so this
 * module has no build-time dependency on a file another agent is
 * concurrently writing. Once A1's provider class lands, the orchestrator
 * may choose to have this file delegate to it instead — noted here rather
 * than silently duplicated forever.
 *
 * No real Apollo API key is available in this environment — this function
 * is real, working code, but has only ever been exercised against mocked
 * `fetch` responses (see test/apolloClient.test.ts), never Apollo's live
 * API. That gap is honestly reported, not hidden.
 */
const APOLLO_PEOPLE_SEARCH_ENDPOINT = "https://api.apollo.io/api/v1/mixed_people/search";
const HEALTH_CHECK_TIMEOUT_MS = 8000;

export async function checkHealth(credential: {
  config: Record<string, unknown>;
  secret: string | null;
}): Promise<{ status: string; detail?: string }> {
  if (!credential.secret) {
    return { status: "not_configured", detail: "No Apollo API key stored for this tenant/project." };
  }

  let response: Response;
  try {
    response = await fetch(APOLLO_PEOPLE_SEARCH_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": credential.secret },
      body: JSON.stringify({ page: 1, per_page: 1, person_titles: ["owner"] }),
      signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
    });
  } catch (err) {
    return {
      status: "error",
      detail: `Network error reaching Apollo's API: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (response.status === 401 || response.status === 403) {
    return { status: "error", detail: `Apollo authentication failed (HTTP ${response.status}) — the stored API key is missing, invalid, or lacks permission.` };
  }
  if (response.status === 429) {
    return { status: "error", detail: "Apollo rate limit exceeded (HTTP 429)." };
  }
  if (!response.ok) {
    return { status: "error", detail: `Apollo API returned HTTP ${response.status}.` };
  }
  return { status: "connected" };
}
