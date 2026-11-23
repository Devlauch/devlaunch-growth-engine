/**
 * Thin health-check adapter matching the generic contract
 * `routes/integrations.ts`'s `POST /:provider/health-check` route expects
 * (dynamic-imports `../lib/${provider}Client.js` and calls `checkHealth` if
 * exported — see that file's own doc comment for the contract), following
 * the exact same pattern as `apolloClient.ts`/`peopleDataLabsClient.ts`.
 *
 * Deliberately self-contained (does NOT import `abstractApiProvider.ts`): a
 * minimal, independent real HTTP call against Abstract API's Email
 * Validation endpoint with a harmless, well-known address, so this module
 * has no build-time dependency on the provider-adapter file.
 *
 * No real Abstract API key is available in this environment — this
 * function is real, working code, but has only ever been exercised against
 * mocked `fetch` responses (see test/abstractApiClient.test.ts), never
 * Abstract API's live API. That gap is honestly reported, not hidden.
 */
const EMAIL_VALIDATION_ENDPOINT = "https://emailvalidation.abstractapi.com/v1/";
const HEALTH_CHECK_TIMEOUT_MS = 8000;

export async function checkHealth(credential: {
  config: Record<string, unknown>;
  secret: string | null;
}): Promise<{ status: string; detail?: string }> {
  if (!credential.secret) {
    return { status: "not_configured", detail: "No Abstract API key stored for this tenant/project." };
  }

  const url = new URL(EMAIL_VALIDATION_ENDPOINT);
  url.searchParams.set("api_key", credential.secret);
  url.searchParams.set("email", "health-check@abstractapi.com");

  let response: Response;
  try {
    response = await fetch(url.toString(), { signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS) });
  } catch (err) {
    return {
      status: "error",
      detail: `Network error reaching Abstract API: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (response.status === 401) {
    return { status: "error", detail: "Abstract API authentication failed (HTTP 401) — the stored API key is missing or invalid." };
  }
  if (response.status === 429) {
    return { status: "error", detail: "Abstract API rate limit exceeded (HTTP 429)." };
  }
  if (!response.ok) {
    return { status: "error", detail: `Abstract API returned HTTP ${response.status}.` };
  }
  return { status: "connected" };
}
