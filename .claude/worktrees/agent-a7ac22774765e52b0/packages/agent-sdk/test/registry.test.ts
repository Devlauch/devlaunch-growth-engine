import { describe, it, expect } from "vitest";
import { AgentRegistry } from "../src/registry.js";
import type { AgentDefinition } from "../src/types.js";

const def: AgentDefinition = {
  id: "demo",
  version: "1",
  name: "Demo",
  description: "demo agent",
  inputSchema: {},
  outputSchema: {},
  requiredPermissions: [],
  tools: [],
};

describe("AgentRegistry", () => {
  it("registers and retrieves a definition by id", () => {
    const registry = new AgentRegistry();
    registry.register(def);
    expect(registry.get("demo")).toEqual(def);
    expect(registry.has("demo")).toBe(true);
    expect(registry.list()).toHaveLength(1);
  });

  it("throws when the same id@version is registered twice", () => {
    const registry = new AgentRegistry();
    registry.register(def);
    expect(() => registry.register(def)).toThrow();
  });

  it("returns undefined for an unknown agent id", () => {
    const registry = new AgentRegistry();
    expect(registry.get("missing")).toBeUndefined();
    expect(registry.has("missing")).toBe(false);
  });
});
