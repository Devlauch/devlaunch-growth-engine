import type {
  ConnectorConfig,
  ConnectorDiscoveryResult,
  DiscoveredOrganization,
  SourceConnector,
} from "./types.js";
import { SlidingWindowRateLimiter } from "./rateLimiter.js";

/**
 * Connector for public business/institution directories.
 *
 * This connector is deliberately split into:
 *   1. `PublicDirectoryConnector` — the stable SourceConnector shape the
 *      rest of the platform talks to (input validation, rate limiting,
 *      mapping into ConnectorDiscoveryResult).
 *   2. `DirectoryApiClient` — a small pluggable interface for *where the
 *      listings actually come from*. A future licensed directory API (one
 *      that needs an API key we don't have in this environment) can be
 *      wired in by implementing this interface and passing it to the
 *      connector's constructor — no other code needs to change.
 *
 * WHAT'S REAL vs. WHAT NEEDS A FUTURE KEY:
 *   - `OverpassDirectoryApiClient` (the default client, used when no
 *     client is explicitly supplied) is a REAL, WORKING implementation.
 *     It queries the public, no-auth-required Overpass API
 *     (https://overpass-api.de/api/interpreter), which serves OpenStreetMap
 *     data under the Overpass API's usage policy
 *     (https://operations.osmfoundation.org/policies/overpass/ — no API
 *     key, reasonable-use rate limits, attribution required). It only
 *     supports the fixed set of business/institution categories in
 *     `INDUSTRY_TO_OSM_TAG` below (restaurants, schools, hospitals, etc.)
 *     because mapping an arbitrary free-text "industry" string to an OSM
 *     tag reliably is not something we can do honestly without a real
 *     taxonomy — for anything outside that set it throws a clear
 *     `UnsupportedIndustryError` rather than guessing or fabricating
 *     results.
 *   - A licensed, paid directory/data-provider API (e.g. a commercial
 *     firmographic/B2B directory) is NOT implemented here — we have no
 *     API key for one in this environment. `NotConfiguredDirectoryApiClient`
 *     is provided as the documented extension point: swap it in (or
 *     implement a new `DirectoryApiClient` against the real provider) once
 *     a key is available. It throws `NotConfiguredError` rather than
 *     silently returning empty or fabricated "looks real" data.
 */

export class NotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotConfiguredError";
  }
}

export class UnsupportedIndustryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedIndustryError";
  }
}

/** One raw listing as returned by a directory backend, before mapping into
 * the platform's DiscoveredOrganization shape. */
export interface RawDirectoryListing {
  name: string;
  domain?: string;
  sourceUrl: string;
  rawMetadata: Record<string, unknown>;
}

export interface PublicDirectorySearchInput {
  industry: string;
  geography: string;
  limit?: number;
}

/** Pluggable backend for `PublicDirectoryConnector`. Implement this against
 * a real directory API (free or licensed) to back the connector with that
 * source. */
export interface DirectoryApiClient {
  search(input: PublicDirectorySearchInput): Promise<RawDirectoryListing[]>;
}

/**
 * Honest stand-in for a licensed directory API we don't have credentials
 * for in this environment. Throws rather than returning fake "real-looking"
 * organizations. Wire in a real client (implementing `DirectoryApiClient`)
 * once an API key exists.
 */
export class NotConfiguredDirectoryApiClient implements DirectoryApiClient {
  constructor(private readonly providerName = "licensed directory provider") {}

  async search(): Promise<RawDirectoryListing[]> {
    throw new NotConfiguredError(
      `${this.providerName} is not configured (no API key available in this environment). ` +
        `Implement DirectoryApiClient against the real provider and pass it to ` +
        `PublicDirectoryConnector's constructor once credentials are available. ` +
        `Refusing to fabricate organizations.`,
    );
  }
}

/** Common business/institution categories mapped to their OpenStreetMap
 * `amenity`/`shop`/`office` tag. Deliberately a small, honest, fixed list —
 * NOT a general industry classifier. */
export const INDUSTRY_TO_OSM_TAG: Record<string, { key: string; value: string }> = {
  restaurant: { key: "amenity", value: "restaurant" },
  cafe: { key: "amenity", value: "cafe" },
  school: { key: "amenity", value: "school" },
  university: { key: "amenity", value: "university" },
  hospital: { key: "amenity", value: "hospital" },
  clinic: { key: "amenity", value: "clinic" },
  dentist: { key: "amenity", value: "dentist" },
  pharmacy: { key: "amenity", value: "pharmacy" },
  bank: { key: "amenity", value: "bank" },
  hotel: { key: "tourism", value: "hotel" },
  gym: { key: "leisure", value: "fitness_centre" },
  lawyer: { key: "office", value: "lawyer" },
  accountant: { key: "office", value: "accountant" },
  library: { key: "amenity", value: "library" },
  childcare: { key: "amenity", value: "childcare" },
};

interface OverpassElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

interface OverpassResponse {
  elements: OverpassElement[];
}

/**
 * REAL, working DirectoryApiClient backed by the public Overpass API
 * (OpenStreetMap). No API key required. `fetchFn` is injectable so tests
 * can run without a live network call.
 */
export class OverpassDirectoryApiClient implements DirectoryApiClient {
  constructor(
    private readonly endpoint = "https://overpass-api.de/api/interpreter",
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async search(input: PublicDirectorySearchInput): Promise<RawDirectoryListing[]> {
    const tag = INDUSTRY_TO_OSM_TAG[input.industry.trim().toLowerCase()];
    if (!tag) {
      throw new UnsupportedIndustryError(
        `No OSM tag mapping for industry "${input.industry}". Supported: ` +
          `${Object.keys(INDUSTRY_TO_OSM_TAG).join(", ")}.`,
      );
    }
    if (!input.geography || !input.geography.trim()) {
      throw new Error("geography is required for a public directory search");
    }

    const limit = Math.min(Math.max(input.limit ?? 25, 1), 100);
    const areaName = input.geography.trim().replace(/"/g, '\\"');
    const query = `
      [out:json][timeout:25];
      area["name"="${areaName}"]->.searchArea;
      (
        nwr["${tag.key}"="${tag.value}"](area.searchArea);
      );
      out center ${limit};
    `.trim();

    const res = await this.fetchFn(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        // Overpass's public instance returns 406 Not Acceptable for
        // requests with no/default User-Agent (confirmed live) — required
        // for identification per the Overpass usage policy this module's
        // header comment already references.
        "User-Agent": "DevLaunchGrowthEngine-PublicDirectoryConnector/0.1 (+https://github.com/devlaunch; contact: devlaunch-dev@example.com)",
      },
      body: `data=${encodeURIComponent(query)}`,
    });

    if (!res.ok) {
      throw new Error(`Overpass API request failed: ${res.status} ${res.statusText}`);
    }

    const body = (await res.json()) as OverpassResponse;
    const listings: RawDirectoryListing[] = [];

    for (const el of body.elements ?? []) {
      const tags = el.tags ?? {};
      const name = tags.name;
      if (!name) continue; // Skip unnamed OSM elements — not a usable lead.

      const domain = extractDomain(tags.website ?? tags["contact:website"]);
      const lat = el.lat ?? el.center?.lat;
      const lon = el.lon ?? el.center?.lon;
      const sourceUrl =
        tags.website ?? tags["contact:website"] ?? `https://www.openstreetmap.org/${el.type}/${el.id}`;

      listings.push({
        name,
        domain,
        sourceUrl,
        rawMetadata: {
          source: "openstreetmap-overpass",
          osmType: el.type,
          osmId: el.id,
          lat,
          lon,
          tags,
        },
      });
    }

    return listings;
  }
}

function extractDomain(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url.startsWith("http") ? url : `https://${url}`);
    return u.hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

export class PublicDirectoryConnector implements SourceConnector {
  readonly id = "public-directory";
  readonly type = "public_directory" as const;
  readonly termsNote =
    "Default backend is OpenStreetMap via the Overpass API: free, no API key, data under the " +
    "Open Database License (attribution required if republished), subject to the Overpass API " +
    "fair-use policy (https://operations.osmfoundation.org/policies/overpass/) — no bulk scraping, " +
    "respect rate limits. A licensed commercial directory backend (not configured in this " +
    "environment) would carry its own, separate terms — see that provider's agreement before " +
    "enabling it for a tenant.";
  readonly defaultRateLimitPerMinute = 10;

  constructor(private readonly client: DirectoryApiClient = new OverpassDirectoryApiClient()) {}

  async discover(input: unknown, config: ConnectorConfig): Promise<ConnectorDiscoveryResult> {
    if (!config.enabled) {
      throw new Error("public-directory connector is disabled for this tenant");
    }
    const parsed = parseInput(input);

    const limiter = new SlidingWindowRateLimiter(
      config.rateLimitPerMinute || this.defaultRateLimitPerMinute,
    );
    await limiter.acquire();

    const listings = await this.client.search(parsed);

    const now = new Date().toISOString();
    const organizations: DiscoveredOrganization[] = listings.map((l) => ({
      name: l.name,
      domain: l.domain,
      sourceUrl: l.sourceUrl,
      discoveredAt: now,
      rawMetadata: l.rawMetadata,
    }));

    // Directory search results are organization-level only; contact
    // discovery for these orgs is out of scope for this connector (a
    // website-crawl connector or licensed API may enrich contacts later).
    return { organizations, contacts: {} };
  }
}

function parseInput(input: unknown): PublicDirectorySearchInput {
  if (
    input &&
    typeof input === "object" &&
    typeof (input as Record<string, unknown>).industry === "string" &&
    typeof (input as Record<string, unknown>).geography === "string"
  ) {
    const obj = input as Record<string, unknown>;
    return {
      industry: obj.industry as string,
      geography: obj.geography as string,
      limit: typeof obj.limit === "number" ? obj.limit : undefined,
    };
  }
  throw new Error(
    "public-directory connector expects { industry: string, geography: string, limit?: number }",
  );
}
