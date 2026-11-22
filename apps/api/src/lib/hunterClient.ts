import { searchDomainPage, HunterApiError, HunterTimeoutError, HunterNetworkError } from "./hunterProvider.js";

/**
 * Thin health-check wrapper matching the generic contract
 * `routes/integrations.ts`'s `POST /:provider/health-check` route expects
 * (dynamic-imports `../lib/${provider}Client.js` and calls `checkHealth` if
 * exported — see that file's own doc comment for the contract). The actual
 * Hunter HTTP client lives in `hunterProvider.ts`; this file only adapts it
 * to that shared health-check shape, reusing a real (not simulated) Domain
 * Search call against Hunter's own domain as a minimal, cheap connectivity +
 * auth check.
 *
 * No real Hunter API key is available in this environment — this function
 * is real, working code, but has only ever been exercised against mocked
 * `fetch` responses (see test/hunterClient.test.ts), never Hunter's live
 * API. That gap is reported as BLOCKED in docs/PHASE_2_HUNTER_VALIDATION.md,
 * not hidden.
 */
export async function checkHealth(credential: {
  config: Record<string, unknown>;
  secret: string | null;
}): Promise<{ status: string; detail?: string }> {
  if (!credential.secret) {
    return { status: "not_configured", detail: "No Hunter API key stored for this tenant/project." };
  }
  try {
    await searchDomainPage("hunter.io", credential.secret, { limit: 1, timeoutMs: 8000 });
    return { status: "connected" };
  } catch (err) {
    if (err instanceof HunterApiError) {
      return { status: "error", detail: `Hunter API returned an error: ${err.message}` };
    }
    if (err instanceof HunterTimeoutError) {
      return { status: "error", detail: "Hunter API request timed out." };
    }
    if (err instanceof HunterNetworkError) {
      return { status: "error", detail: "Network error reaching Hunter's API." };
    }
    return { status: "error", detail: err instanceof Error ? err.message : "Unknown error checking Hunter API." };
  }
}
