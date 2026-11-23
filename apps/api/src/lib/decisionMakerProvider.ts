/**
 * Decision-maker search: given a discovered_organizations row, find likely
 * decision-maker contacts (name/title/email/phone) at that organization.
 *
 * There is no authorized paid data-provider API key available in this
 * environment (Apollo, ZoomInfo, Clearbit, etc. all require one). This
 * mirrors the exact NotConfiguredError / NotConfiguredRankingProvider
 * pattern in keywordRankingStub.ts (itself modeled on
 * NotConfiguredDirectoryApiClient in
 * packages/agent-sdk/src/connectors/publicDirectoryConnector.ts):
 *
 *   1. `DecisionMakerProvider` — the stable pluggable interface a real
 *      provider client implements later, without any caller needing to
 *      change (see providerWaterfall.ts for how multiple providers,
 *      including a future real one, are tried in priority order).
 *   2. `NotConfiguredDecisionMakerProvider` — the one concrete
 *      implementation available today. It throws rather than ever
 *      returning a fabricated name/title/email — there is nothing honest
 *      it can return.
 *
 * Swapping in a real provider later is a drop-in: implement
 * `DecisionMakerProvider` against Apollo/ZoomInfo/etc, and either replace or
 * prepend it in the waterfall built by `findDecisionMakers` below.
 */

import { runProviderWaterfall } from "./providerWaterfall.js";

export class NotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotConfiguredError";
  }
}

/** A single candidate decision-maker. Never fabricated — every field here
 * must trace back to something a real provider actually returned. */
export interface DecisionMakerCandidate {
  name: string;
  title: string | null;
  email: string | null;
  phone: string | null;
  /** Where this candidate came from (a profile URL, a directory listing,
   * etc.), when the provider exposes one. */
  sourceUrl: string | null;
  /** How this candidate's data was obtained. A direct, provider-confirmed
   * record is 'verified'; a provider's best-guess match (e.g. "likely the
   * person holding this title, inferred from a title/seniority heuristic")
   * is 'inferred'. Never 'verified' unless the provider itself stands
   * behind the record. */
  sourceConfidence: "verified" | "inferred" | "unconfirmed";
}

export interface DecisionMakerLookupInput {
  organizationName: string;
  domain: string | null;
}

/** Pluggable backend for decision-maker search. Implement this against a
 * real provider (Apollo, ZoomInfo, Clearbit, etc.) to back decision-maker
 * lookup with that provider — the rest of the app only ever depends on this
 * interface. */
export interface DecisionMakerProvider {
  /** Stable, human-readable provider name, recorded in the waterfall's
   * `answeredBy` / in decision_maker_cache.provider. */
  readonly name: string;
  findDecisionMakers(input: DecisionMakerLookupInput): Promise<DecisionMakerCandidate[]>;
}

/**
 * Honest stand-in for a licensed decision-maker data provider we don't have
 * credentials for in this environment. Always throws — never returns a
 * fabricated name/title/email, and never silently returns an empty array
 * pretending that's a confirmed "no decision-makers found" result (an empty
 * array from a provider implies it genuinely looked and found nothing;
 * "not configured" is a different, honest outcome and is surfaced as such).
 */
export class NotConfiguredDecisionMakerProvider implements DecisionMakerProvider {
  constructor(private readonly providerName = "decision-maker data provider (e.g. Apollo/ZoomInfo/Clearbit)") {}

  readonly name = "not_configured";

  async findDecisionMakers(_input: DecisionMakerLookupInput): Promise<never> {
    throw new NotConfiguredError(
      `${this.providerName} is not configured (no API key available in this environment). ` +
        `Implement DecisionMakerProvider against a real provider and add it to the waterfall ` +
        `once credentials are available. Refusing to fabricate a decision-maker contact.`,
    );
  }
}

/**
 * The decision-maker provider waterfall used in production. A real provider
 * (Apollo/ZoomInfo/etc), once credentials exist, is added here ahead of the
 * stub — `findDecisionMakers` below doesn't change at all when that
 * happens, since it only ever depends on the `DecisionMakerProvider`
 * interface via `runProviderWaterfall`. Exported (rather than inlined) so a
 * test or an alternate caller can swap it out without reimplementing the
 * wiring.
 */
export function buildDecisionMakerWaterfall(): DecisionMakerProvider[] {
  return [new NotConfiguredDecisionMakerProvider()];
}

/**
 * Tenant-aware waterfall (Milestone 6 / P5): composes the real providers
 * this codebase has built so far — Hunter (hunterProvider.ts), Clearbit
 * (clearbitProvider.ts), then Apollo (apolloProvider.ts, Phase 2 provider
 * validation) — ahead of the honest NotConfiguredDecisionMakerProvider
 * stub, each resolved per-tenant via integrationCredentials.ts. Each entry
 * independently falls back to its own NotConfigured* stub when that
 * specific provider has no credential for this tenant/project, so a
 * waterfall run always has at least one real attempt recorded even when
 * every provider is unconfigured (all "not configured" errors, same
 * `findDecisionMakers()` classification as before).
 *
 * This is additive — `buildDecisionMakerWaterfall()` above is unchanged and
 * still used wherever a synchronous, env-only waterfall is wanted (e.g.
 * tests). Callers that have a tenantDb/tenantId/projectId in hand (the
 * discovery/enrichment pipeline) should prefer this function instead.
 */
export async function buildDecisionMakerWaterfallForTenant(
  tenantDb: Parameters<typeof import("./hunterProvider.js").buildHunterProvider>[0],
  tenantId: string,
  projectId: string,
): Promise<DecisionMakerProvider[]> {
  const { buildHunterProvider } = await import("./hunterProvider.js");
  const { buildClearbitProvider } = await import("./clearbitProvider.js");
  const { buildApolloProvider } = await import("./apolloProvider.js");
  const [hunter, clearbit, apollo] = await Promise.all([
    buildHunterProvider(tenantDb, tenantId, projectId),
    buildClearbitProvider(tenantDb, tenantId, projectId),
    buildApolloProvider(tenantDb, tenantId, projectId),
  ]);
  return [hunter, clearbit, apollo, new NotConfiguredDecisionMakerProvider()];
}

export interface DecisionMakerLookupOutcome {
  status: "found" | "not_configured" | "no_result";
  provider: string | null;
  contacts: DecisionMakerCandidate[];
  attempts: { provider: string; status: "success" | "no_result" | "error"; error?: string }[];
}

/**
 * Runs the decision-maker provider waterfall (see buildDecisionMakerWaterfall)
 * against one organization and classifies the outcome for persistence into
 * decision_maker_cache:
 *   - "found": a provider actually returned one or more candidates.
 *   - "not_configured": every provider that was tried failed with
 *     NotConfiguredError (i.e. nothing real was ever consulted) — distinct
 *     from a provider genuinely looking and finding nobody.
 *   - "no_result": at least one provider ran without a NotConfiguredError
 *     and still came back empty (a genuine "looked, found nothing").
 */
export async function findDecisionMakers(
  input: DecisionMakerLookupInput,
  providers: DecisionMakerProvider[] = buildDecisionMakerWaterfall(),
): Promise<DecisionMakerLookupOutcome> {
  const outcome = await runProviderWaterfall(
    providers.map((p) => ({
      name: p.name,
      run: (i: DecisionMakerLookupInput) => p.findDecisionMakers(i),
    })),
    input,
  );

  if (outcome.result && outcome.answeredBy) {
    return { status: "found", provider: outcome.answeredBy, contacts: outcome.result, attempts: outcome.attempts };
  }

  const allNotConfigured =
    outcome.attempts.length > 0 &&
    outcome.attempts.every((a) => a.status === "error" && a.error?.includes("not configured"));

  return {
    status: allNotConfigured ? "not_configured" : "no_result",
    provider: null,
    contacts: [],
    attempts: outcome.attempts,
  };
}
