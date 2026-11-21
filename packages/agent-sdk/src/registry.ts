import type { AgentDefinition } from "./types.js";

/**
 * In-memory registry of AgentDefinitions, keyed by `${id}@${version}`.
 * Both the API (to list agent-templates / validate agent-run requests)
 * and the worker (to look up how to execute an agent) can hold their own
 * instance of this registry and register the same AgentDefinitions into it.
 *
 * This is intentionally a plain in-memory map, not a runtime: it does not
 * execute anything itself (see apps/worker/src/agents for execution).
 */
export class AgentRegistry {
  private readonly definitions = new Map<string, AgentDefinition>();

  private key(id: string, version: string): string {
    return `${id}@${version}`;
  }

  register(definition: AgentDefinition): void {
    const key = this.key(definition.id, definition.version);
    if (this.definitions.has(key)) {
      throw new Error(`AgentDefinition already registered: ${key}`);
    }
    this.definitions.set(key, definition);
  }

  /** Get a specific version, or the latest registered version if omitted. */
  get(id: string, version?: string): AgentDefinition | undefined {
    if (version) {
      return this.definitions.get(this.key(id, version));
    }
    const candidates = this.list().filter((d) => d.id === id);
    if (candidates.length === 0) return undefined;
    return candidates.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))[0];
  }

  has(id: string, version?: string): boolean {
    return this.get(id, version) !== undefined;
  }

  list(): AgentDefinition[] {
    return Array.from(this.definitions.values());
  }
}
