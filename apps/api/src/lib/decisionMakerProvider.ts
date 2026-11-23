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

import type { PoolClient } from "pg";
import { runProviderWaterfall } from "./providerWaterfall.js";
import { ApolloDecisionMakerProvider } from "./apolloDecisionMakerProvider.js";
import { resolveApolloApiKey } from "./providerCredentials.js";

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
 * The decision-maker provider waterfall used in production. When a tenant's
 * Apollo credential resolves (via `providerCredentials.ts#resolveApolloApiKey`
 * — tenant's own stored credential first, `env.apolloApiKey` fallback second,
 * same convention as every other real provider in this codebase), a real
 * `ApolloDecisionMakerProvider` is prepended ahead of the honest stub; when it
 * doesn't resolve (or no tenant context is supplied at all, e.g. a caller with
 * no request scope), the stub alone is returned exactly as before. Callers
 * with tenant context (discoveryRun.ts) pass it; `findDecisionMakers`'s own
 * no-args default below deliberately does not, since it has no tenant scope
 * to resolve a credential against.
 */
export async function buildDecisionMakerWaterfall(
  tenantDb?: Pick<PoolClient, "query">,
  tenantId?: string,
  projectId?: string,
): Promise<DecisionMakerProvider[]> {
  const providers: DecisionMakerProvider[] = [];
  if (tenantDb && tenantId && projectId) {
    const apiKey = await resolveApolloApiKey(tenantDb, tenantId, projectId);
    if (apiKey) {
      providers.push(new ApolloDecisionMakerProvider(apiKey));
    }
  }
  providers.push(new NotConfiguredDecisionMakerProvider());
  return providers;
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
  providers?: DecisionMakerProvider[],
): Promise<DecisionMakerLookupOutcome> {
  const resolvedProviders = providers ?? (await buildDecisionMakerWaterfall());
  const outcome = await runProviderWaterfall(
    resolvedProviders.map((p) => ({
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
