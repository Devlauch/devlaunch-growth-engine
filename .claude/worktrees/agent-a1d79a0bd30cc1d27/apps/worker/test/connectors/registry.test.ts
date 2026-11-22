import { describe, it, expect } from "vitest";
import { getConnector, listConnectors } from "../../src/connectors/registry.js";

describe("connector registry", () => {
  it("registers the csv-upload and public-directory connectors", () => {
    expect(getConnector("csv-upload")).toBeDefined();
    expect(getConnector("public-directory")).toBeDefined();
    expect(getConnector("nonexistent")).toBeUndefined();
  });

  it("lists all registered connectors", () => {
    const ids = listConnectors().map((c) => c.id);
    expect(ids).toContain("csv-upload");
    expect(ids).toContain("public-directory");
  });
});
