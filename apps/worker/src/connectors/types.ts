/**
 * Plug-in interface for lead-source connectors.
 *
 * Each real-world data source (a public business directory, an institution
 * website crawled via Crawl4AI, a CSV upload, a licensed data-provider API,
 * ...) implements `SourceConnector` once. The rest of the platform (queue
 * workers, the API layer that persists into `discovery_sources` /
 * `discovered_organizations` / `discovered_contacts`) only ever talks to
 * this interface, so adding a new source never requires touching callers.
 *
 * Every connector carries its own terms note, default rate limit, and is
 * invoked with a `ConnectorConfig` so a tenant can be switched on/off and
 * tuned without code changes (the on/off switch and per-tenant rate limit
 * are expected to live in the `discovery_sources` table managed by the API
 * layer; this package only defines the shape connectors must honor).
 */

/** A business/institution discovered by a connector. Mirrors the shape the
 * API layer inserts into `discovered_organizations`. */
export interface DiscoveredOrganization {
  name: string;
  domain?: string;
  sourceUrl: string;
  /** ISO-8601 timestamp of when this connector run discovered the org. */
  discoveredAt: string;
  /** Arbitrary source-specific metadata preserved for later inspection. */
  rawMetadata: Record<string, unknown>;
}

/** A contact at a discovered organization. Mirrors the shape the API layer
 * inserts into `discovered_contacts`. */
export interface DiscoveredContact {
  name?: string;
  roleTitle?: string;
  email?: string;
  phone?: string;
  contactChannel: "role_based" | "named_person" | "contact_form" | "phone";
  sourceUrl?: string;
}

/**
 * Result of a single connector discovery run. `contacts` is keyed by a
 * stable key for the organization it belongs to — callers should use the
 * org's `name` when no more stable key (e.g. domain) is available, and
 * connectors should document which key they use.
 */
export interface ConnectorDiscoveryResult {
  organizations: DiscoveredOrganization[];
  contacts: Record<string, DiscoveredContact[]>;
}

/** Per-tenant configuration a connector is invoked with. */
export interface ConnectorConfig {
  /** Self-throttle ceiling; connectors must not exceed this. */
  rateLimitPerMinute: number;
  /** Per-tenant on/off switch. Connectors should treat `enabled: false` as
   * caller error (callers are expected to gate on this before invoking
   * `discover`), but may also defensively refuse to run. */
  enabled: boolean;
  /** Human-readable note on what this source's terms of use allow/forbid.
   * Typically a copy of `SourceConnector.termsNote`, but a tenant-specific
   * override (e.g. a signed licensing agreement) may be supplied instead. */
  termsNote: string;
}

/**
 * One plug-in lead-source connector.
 *
 * `discover`'s `input` is intentionally `unknown` because each connector
 * type takes a different shape of input (raw CSV text, a directory search
 * query, a licensed API's query params, ...) — connectors are expected to
 * validate/parse their own input and throw a descriptive error on
 * malformed input rather than silently returning an empty result.
 */
export interface SourceConnector {
  /** Stable identifier, e.g. "csv-upload", "public-directory". */
  readonly id: string;
  readonly type: "public_directory" | "website_crawl" | "csv_upload" | "licensed_api";
  /** What this source's terms of use allow/forbid. Shown to operators so a
   * tenant can make an informed on/off decision. */
  readonly termsNote: string;
  /** Sane default if no tenant-specific override is configured. */
  readonly defaultRateLimitPerMinute: number;

  discover(input: unknown, config: ConnectorConfig): Promise<ConnectorDiscoveryResult>;
}
