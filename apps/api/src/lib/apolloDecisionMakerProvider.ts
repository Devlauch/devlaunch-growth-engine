import { SlidingWindowRateLimiter } from "@devlaunch/agent-sdk";
import type {
  DecisionMakerCandidate,
  DecisionMakerLookupInput,
  DecisionMakerProvider,
} from "./decisionMakerProvider.js";

/**
 * Real DecisionMakerProvider backed by Apollo.io's People Search API
 * (api.apollo.io/api/v1/mixed_people/search).
 *
 * HONESTY NOTE (per docs/PROSPECTING_ENGINE_STATUS.md's hard rule): the
 * exact response shape coded below is based on Apollo's public API
 * documentation as of this writing, NOT verified against a live call with a
 * real API key (no APOLLO_API_KEY is available in this environment). Every
 * field is read defensively (typeof-checked) rather than trusted blindly,
 * and this provider NEVER fabricates a name/title/email/phone that Apollo's
 * response didn't actually contain — if a field isn't present, it is left
 * `null`, exactly like `DecisionMakerCandidate`'s own doc comment requires.
 *
 * A known Apollo product behavior (not a bug in this code): Apollo's search
 * endpoint frequently returns a redacted/locked placeholder email (a shape
 * like "email_not_unlocked@domain.com") rather than a real address,
 * reserving real-email reveal for a separate, credit-consuming enrichment
 * call this provider does not make. `extractRealEmail` below detects and
 * discards that placeholder shape rather than ever surfacing it as if it
 * were a real email.
 *
 * `NotConfiguredError` is defined locally (not imported from
 * decisionMakerProvider.ts) so this module only needs a type-only import
 * from there — decisionMakerProvider.ts in turn imports this class as a
 * value (to prepend it in the waterfall), and a value import in one
 * direction + a type-only import in the other avoids an actual circular
 * runtime dependency between the two files.
 */

export class NotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotConfiguredError";
  }
}

export class RateLimitedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitedError";
  }
}

export class MalformedResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedResponseError";
  }
}

/** Distinct from a generic request failure — see apolloConnector.ts's
 * AuthenticationError for the same reasoning (a bad/expired key calls for
 * different caller action than a transient failure). */
export class AuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthenticationError";
  }
}

const APOLLO_PEOPLE_SEARCH_ENDPOINT = "https://api.apollo.io/api/v1/mixed_people/search";
const FETCH_TIMEOUT_MS = 15_000;
const MAX_TRANSIENT_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 300;

/**
 * Caller-supplied filters for a decision-maker search — per the spec's
 * explicit "Do not hardcode a single ICP" requirement, every field here is
 * optional and overridable per call. When omitted, `jobTitles` falls back
 * to DEFAULT_DECISION_MAKER_TITLES below (a reasonable small-business
 * default, not a forced ICP), and every other filter is simply not sent
 * (matching Apollo's own "absent = no filter" convention, same as
 * apolloConnector.ts's company-search filters).
 */
export interface ApolloDecisionMakerFilters {
  /** Apollo's `person_titles` param — e.g. ["CTO", "VP Engineering", "Head of Engineering"]. */
  jobTitles?: string[];
  /** Apollo's `person_seniorities` param — e.g. ["founder", "c_suite", "vp", "director"]. */
  seniorities?: string[];
  /** Apollo's `person_departments` param — e.g. ["engineering", "information_technology"]. */
  departments?: string[];
  /** Apollo's `person_locations` param — e.g. ["California, US", "London, UK"]. */
  locations?: string[];
  /** Apollo's `organization_num_employees_ranges` param, same format as
   * apolloConnector.ts's company-search equivalent. */
  companySizeRanges?: string[];
}

/** Conservative heuristic list of title keywords passed to Apollo's own
 * `person_titles` search param (an OR filter on Apollo's side) to bias
 * results toward likely decision-makers at a small/medium business. This is
 * a narrowing filter, NOT a guarantee any one of these titles exists at a
 * given organization, and never a substitute for a real returned title. */
const DEFAULT_DECISION_MAKER_TITLES = [
  "owner",
  "founder",
  "co-founder",
  "ceo",
  "president",
  "managing director",
  "general manager",
  "director",
  "vp",
  "vice president",
  "head of",
];

interface ApolloPhoneNumber {
  sanitized_number?: unknown;
}

interface ApolloPersonRecord {
  name?: unknown;
  first_name?: unknown;
  last_name?: unknown;
  title?: unknown;
  email?: unknown;
  linkedin_url?: unknown;
  sanitized_phone?: unknown;
  phone_numbers?: unknown;
}

interface ApolloPeopleSearchResponse {
  people?: unknown;
  error?: unknown;
}

export class ApolloDecisionMakerProvider implements DecisionMakerProvider {
  readonly name = "apollo";

  private readonly limiter: SlidingWindowRateLimiter;

  constructor(
    private readonly apiKey: string | null,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly clock: () => number = Date.now,
    requestsPerMinute = 50,
    private readonly filters: ApolloDecisionMakerFilters = {},
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    this.limiter = new SlidingWindowRateLimiter(requestsPerMinute);
  }

  async findDecisionMakers(input: DecisionMakerLookupInput): Promise<DecisionMakerCandidate[]> {
    if (!this.apiKey) {
      throw new NotConfiguredError(
        "Apollo.io is not configured (APOLLO_API_KEY is unset in this environment). Refusing to " +
          "fabricate a decision-maker contact.",
      );
    }
    if (!input.organizationName && !input.domain) {
      throw new Error("ApolloDecisionMakerProvider requires organizationName or domain");
    }

    await this.limiter.acquire(this.clock);

    const requestBody: Record<string, unknown> = {
      page: 1,
      per_page: 10,
      // Caller-configurable (constructor-supplied) filters only — falls
      // back to a reasonable small-business title list, never forces one
      // fixed ICP across every tenant/campaign. See
      // docs/PHASE_2_APOLLO_VALIDATION.md for why this is a constructor
      // option rather than a per-call DecisionMakerLookupInput field (that
      // shared interface is out of this track's edit scope without
      // orchestrator approval).
      person_titles: this.filters.jobTitles ?? DEFAULT_DECISION_MAKER_TITLES,
    };
    if (this.filters.seniorities && this.filters.seniorities.length > 0) {
      requestBody.person_seniorities = this.filters.seniorities;
    }
    if (this.filters.departments && this.filters.departments.length > 0) {
      requestBody.person_departments = this.filters.departments;
    }
    if (this.filters.locations && this.filters.locations.length > 0) {
      requestBody.person_locations = this.filters.locations;
    }
    if (this.filters.companySizeRanges && this.filters.companySizeRanges.length > 0) {
      requestBody.organization_num_employees_ranges = this.filters.companySizeRanges;
    }
    if (input.domain) {
      requestBody.q_organization_domains = input.domain;
    } else {
      requestBody.q_organization_name = input.organizationName;
    }

    const body = await this.fetchWithRetry(requestBody);
    const rawPeople = Array.isArray(body.people) ? body.people : [];
    const candidates: DecisionMakerCandidate[] = [];

    for (const raw of rawPeople) {
      if (!raw || typeof raw !== "object") continue; // Never trust a malformed item.
      const person = raw as ApolloPersonRecord;
      const name = extractName(person);
      if (!name) continue; // No real name in the response — never fabricate a candidate.

      candidates.push({
        name,
        title: typeof person.title === "string" && person.title.trim() ? person.title.trim() : null,
        email: extractRealEmail(person.email),
        phone: extractPhone(person),
        sourceUrl: typeof person.linkedin_url === "string" ? person.linkedin_url : null,
        // Apollo's search endpoint returning a named person at a matched
        // organization is a direct, provider-confirmed record — not a
        // best-guess inference — so this is 'verified' per
        // DecisionMakerCandidate's own doc comment, independent of whether
        // the email happened to be unlocked.
        sourceConfidence: "verified",
      });
    }

    return candidates;
  }

  /** Same retry/auth-classification policy as apolloConnector.ts's
   * fetchWithRetry — kept independent (not shared) since the two files are
   * in different packages (apps/api vs packages/agent-sdk) and this
   * module's ownership boundary (Apollo-specific, apps/api/src/lib) is
   * deliberately not supposed to introduce a new cross-package shared
   * util without orchestrator approval. */
  private async fetchWithRetry(requestBody: Record<string, unknown>): Promise<ApolloPeopleSearchResponse> {
    for (let attempt = 0; attempt <= MAX_TRANSIENT_RETRIES; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(APOLLO_PEOPLE_SEARCH_ENDPOINT, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": this.apiKey as string,
          },
          body: JSON.stringify(requestBody),
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
      } catch (err) {
        if (attempt < MAX_TRANSIENT_RETRIES) {
          await this.sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
          continue;
        }
        throw new Error(
          `Apollo people-search request failed after ${attempt + 1} attempt(s): ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }

      if (res.status === 401 || res.status === 403) {
        throw new AuthenticationError(
          `Apollo people-search authentication failed (HTTP ${res.status}) — the configured ` +
            `APOLLO_API_KEY is missing, invalid, or lacks permission for this endpoint.`,
        );
      }
      if (res.status === 429) {
        throw new RateLimitedError("Apollo people-search rate limit exceeded (HTTP 429).");
      }
      if (res.status >= 500 && attempt < MAX_TRANSIENT_RETRIES) {
        await this.sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
        continue;
      }

      let body: ApolloPeopleSearchResponse;
      try {
        body = (await res.json()) as ApolloPeopleSearchResponse;
      } catch (err) {
        throw new MalformedResponseError(
          `Could not parse Apollo response as JSON: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      if (!res.ok) {
        const message = typeof body.error === "string" ? body.error : `HTTP ${res.status}`;
        throw new Error(`Apollo people-search request failed: ${message}`);
      }
      return body;
    }
    throw new Error("Apollo people-search request failed (unreachable)");
  }
}

function extractName(person: ApolloPersonRecord): string | null {
  if (typeof person.name === "string" && person.name.trim()) return person.name.trim();
  const first = typeof person.first_name === "string" ? person.first_name.trim() : "";
  const last = typeof person.last_name === "string" ? person.last_name.trim() : "";
  const combined = `${first} ${last}`.trim();
  return combined || null;
}

function extractRealEmail(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const email = raw.trim();
  // Apollo's documented placeholder shape for a locked/un-revealed email —
  // never surface this as if it were a real address.
  if (/not_unlocked/i.test(email)) return null;
  if (!email.includes("@")) return null;
  return email;
}

function extractPhone(person: ApolloPersonRecord): string | null {
  if (typeof person.sanitized_phone === "string" && person.sanitized_phone.trim()) {
    return person.sanitized_phone.trim();
  }
  if (Array.isArray(person.phone_numbers) && person.phone_numbers.length > 0) {
    const first = person.phone_numbers[0] as ApolloPhoneNumber | undefined;
    if (first && typeof first.sanitized_number === "string" && first.sanitized_number.trim()) {
      return first.sanitized_number.trim();
    }
  }
  return null;
}
