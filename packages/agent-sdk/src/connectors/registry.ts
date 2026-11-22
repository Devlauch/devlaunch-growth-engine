import type { SourceConnector } from "./types.js";
import { CsvUploadConnector } from "./csvConnector.js";
import { PublicDirectoryConnector } from "./publicDirectoryConnector.js";
import { GoogleSearchConnector } from "./googleSearchConnector.js";
import { ApolloConnector } from "./apolloConnector.js";

/**
 * Registry of lead-SOURCE connectors (public directories, website crawls,
 * CSV uploads, licensed APIs). This is a separate, parallel concept to
 * `apps/worker/src/agents/registry.ts` (the agent-run registry) — do not
 * conflate the two. A tenant's `discovery_sources` row references a
 * connector by `id` here; the API/worker layer looks it up via
 * `getConnector` before invoking `discover`.
 */
const connectors: Map<string, SourceConnector> = new Map();

function register(connector: SourceConnector): void {
  connectors.set(connector.id, connector);
}

register(new CsvUploadConnector());
register(new PublicDirectoryConnector());
// Milestone 3 Phase 2 port: real, paid/quota-limited licensed_api
// connectors. Both are self-contained (read their own API key from
// process.env, exactly like OverpassDirectoryApiClient needs no key at all)
// and honestly report NotConfiguredError via their `discover()` when unset,
// rather than ever being skipped from registration — the registry always
// has one entry per known connector id so getConnector() reliably resolves
// it. Credential resolution is currently a raw process.env read in both
// classes; wiring these through the tenant credential-encryption system
// (credentialEncryption.ts/integrations.ts) is tracked separately.
register(new GoogleSearchConnector());
register(new ApolloConnector());

export function getConnector(id: string): SourceConnector | undefined {
  return connectors.get(id);
}

export function listConnectors(): SourceConnector[] {
  return Array.from(connectors.values());
}
