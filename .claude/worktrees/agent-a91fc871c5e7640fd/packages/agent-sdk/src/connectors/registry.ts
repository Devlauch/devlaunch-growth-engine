import type { SourceConnector } from "./types.js";
import { CsvUploadConnector } from "./csvConnector.js";
import { PublicDirectoryConnector } from "./publicDirectoryConnector.js";

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

export function getConnector(id: string): SourceConnector | undefined {
  return connectors.get(id);
}

export function listConnectors(): SourceConnector[] {
  return Array.from(connectors.values());
}
