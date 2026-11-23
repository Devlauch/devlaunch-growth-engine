/**
 * Thin health-check adapter matching the generic contract
 * `routes/integrations.ts`'s `POST /:provider/health-check` route expects
 * (dynamic-imports `../lib/${provider}Client.js` and calls `checkHealth` if
 * exported — see that file's own doc comment for the contract), following
 * the exact same pattern as `apolloClient.ts`/`hunterClient.ts`.
 *
 * Deliberately self-contained (does NOT import `peopleDataLabsProvider.ts`):
 * a minimal, independent real HTTP call against PDL's Company Enrichment
 * endpoint with a harmless, well-known domain, so this module has no
 * build-time dependency on the provider-adapter file.
 *
 * No real People Data Labs API key is available in this environment — this
 * function is real, working code, but has only ever been exercised against
 * mocked `fetch` responses (see test/peopleDataLabsClient.test.ts), never
 * PDL's live API. That gap is honestly reported, not hidden.
 */
const PDL_COMPANY_ENRICH_ENDPOINT = "https://api.peopledatalabs.com/v5/company/enrich";
const HEALTH_CHECK_TIMEOUT_MS = 8000;

export async function checkHealth(credential: {
  config: Record<string, unknown>;
  secret: string | null;
}): Promise<{ status: string; detail?: string }> {
  if (!credential.secret) {
    return { status: "not_configured", detail: "No People Data Labs API key stored for this tenant/project." };
  }

  const url = new URL(PDL_COMPANY_ENRICH_ENDPOINT);
  url.searchParams.set("website", "peopledatalabs.com");
  url.searchParams.set("api_key", credential.secret);

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
    });
  } catch (err) {
    return {
      status: "error",
      detail: `Network error reaching People Data Labs' API: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (response.status === 401) {
    return { status: "error", detail: "People Data Labs authentication failed (HTTP 401) — the stored API key is missing or invalid." };
  }
  if (response.status === 402) {
    return { status: "error", detail: "People Data Labs match quota exhausted (HTTP 402)." };
  }
  if (response.status === 429) {
    return { status: "error", detail: "People Data Labs rate limit exceeded (HTTP 429)." };
  }
  // A real 404 ("no matching company") still proves the API key itself
  // authenticated successfully — a genuinely connected, working credential.
  if (response.status === 404) {
    return { status: "connected" };
  }
  if (!response.ok) {
    return { status: "error", detail: `People Data Labs API returned HTTP ${response.status}.` };
  }
  return { status: "connected" };
}
