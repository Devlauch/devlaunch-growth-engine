/**
 * Generic provider waterfall: tries a list of providers, in configured
 * priority order, for one piece of work, and falls through to the next
 * provider on failure or "no result" rather than giving up after the first.
 *
 * This is deliberately NOT specific to decision-maker lookups (see
 * decisionMakerProvider.ts) or any one data source — it's the same shape of
 * orchestration a future company-enrichment waterfall, a future
 * public-directory-vs-licensed-API discovery waterfall, etc. can reuse
 * as-is. Only one real connector (public_directory/Overpass) plus honest
 * NotConfigured* stubs exist in this codebase today, so in production this
 * will mostly either land on that one real provider or exhaust into
 * "nothing answered" — but the waterfall logic itself (try in order, record
 * who actually answered, keep going past a thrown error or an empty result)
 * is real and is exercised here with plain in-memory stub providers so the
 * fallthrough behavior is actually proven, independent of any one provider's
 * implementation.
 */

export type WaterfallOutcomeStatus = "success" | "no_result" | "error";

export interface WaterfallAttempt {
  provider: string;
  status: WaterfallOutcomeStatus;
  /** Present only when status === "error". */
  error?: string;
  durationMs: number;
}

export interface WaterfallResult<TResult> {
  /** The first non-empty result produced, or null if every provider was
   * tried and none produced one. */
  result: TResult | null;
  /** The name of the provider that produced `result`, or null if none did. */
  answeredBy: string | null;
  /** One entry per provider actually tried, in the order they were tried.
   * A provider later in the list that was never reached (because an
   * earlier one already succeeded) has no entry here. */
  attempts: WaterfallAttempt[];
}

export interface WaterfallProvider<TInput, TResult> {
  /** Stable, human-readable provider name — recorded in `answeredBy` /
   * `attempts` so callers (and persisted cache rows) can show which
   * provider actually answered. */
  readonly name: string;
  run(input: TInput): Promise<TResult>;
}

/** Default "did this provider actually find something" check: treats
 * null/undefined and empty arrays as no result; anything else (including an
 * empty string, 0, or false) counts as a real result, since a provider's
 * result type may legitimately be a scalar. */
function defaultIsEmpty(result: unknown): boolean {
  if (result === null || result === undefined) return true;
  if (Array.isArray(result)) return result.length === 0;
  return false;
}

/**
 * Tries each provider in `providers`, in order, until one returns a
 * non-empty result. A provider that throws is recorded as an "error"
 * attempt and the waterfall moves on to the next provider — it never lets
 * one provider's failure take down the whole lookup. A provider that
 * resolves to an empty result (by `isEmpty`, default: null/undefined/[]) is
 * recorded as "no_result" and the waterfall also moves on. If every
 * provider is exhausted without a result, `result`/`answeredBy` are both
 * null — callers should treat that as "nothing available right now", never
 * synthesize a fallback value themselves.
 */
export async function runProviderWaterfall<TInput, TResult>(
  providers: ReadonlyArray<WaterfallProvider<TInput, TResult>>,
  input: TInput,
  options?: { isEmpty?: (result: TResult) => boolean },
): Promise<WaterfallResult<TResult>> {
  const isEmpty = options?.isEmpty ?? (defaultIsEmpty as (result: TResult) => boolean);
  const attempts: WaterfallAttempt[] = [];

  for (const provider of providers) {
    const startedAt = Date.now();
    try {
      const result = await provider.run(input);
      const durationMs = Date.now() - startedAt;
      if (!isEmpty(result)) {
        attempts.push({ provider: provider.name, status: "success", durationMs });
        return { result, answeredBy: provider.name, attempts };
      }
      attempts.push({ provider: provider.name, status: "no_result", durationMs });
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      attempts.push({
        provider: provider.name,
        status: "error",
        error: err instanceof Error ? err.message : String(err),
        durationMs,
      });
    }
  }

  return { result: null, answeredBy: null, attempts };
}
