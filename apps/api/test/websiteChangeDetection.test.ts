import { describe, it, expect, vi } from "vitest";
import { detectChanges, diffExtractedData } from "../src/lib/websiteChangeDetection.js";

function fakeTenantDb(rows: unknown[]) {
  return { query: vi.fn(async () => ({ rows, rowCount: rows.length })) } as unknown as import("pg").PoolClient;
}

describe("diffExtractedData (pure hash/field diffing)", () => {
  it("returns no changes for identical payloads", () => {
    expect(diffExtractedData({ a: 1, b: [1, 2] }, { a: 1, b: [1, 2] })).toEqual([]);
  });

  it("detects a changed leaf field by dotted path", () => {
    const changes = diffExtractedData({ plans: [{ priceText: "$29/mo" }] }, { plans: [{ priceText: "$39/mo" }] });
    expect(changes).toEqual([{ kind: "changed", path: "plans[0].priceText", before: "$29/mo", after: "$39/mo" }]);
  });

  it("detects an added array element", () => {
    const changes = diffExtractedData({ plans: [{ name: "Starter" }] }, { plans: [{ name: "Starter" }, { name: "Growth" }] });
    expect(changes).toEqual([{ kind: "added", path: "plans[1]", after: { name: "Growth" } }]);
  });

  it("detects a removed array element", () => {
    const changes = diffExtractedData({ plans: [{ name: "Starter" }, { name: "Growth" }] }, { plans: [{ name: "Starter" }] });
    expect(changes).toEqual([{ kind: "removed", path: "plans[1]", before: { name: "Growth" } }]);
  });

  it("detects an added object key", () => {
    const changes = diffExtractedData({ a: 1 }, { a: 1, b: 2 });
    expect(changes).toEqual([{ kind: "added", path: "b", after: 2 }]);
  });
});

describe("detectChanges (DB-backed)", () => {
  it("honestly reports no previous snapshot when zero rows exist", async () => {
    const tenantDb = fakeTenantDb([]);
    const result = await detectChanges(tenantDb, "tenant-1", "project-1", "https://example.com/pricing", "pricing");
    expect(result.hasPreviousSnapshot).toBe(false);
    expect(result.hasChanged).toBe(false);
    expect(result.fieldChanges).toEqual([]);
  });

  it("honestly reports no previous snapshot when only one row exists yet", async () => {
    const tenantDb = fakeTenantDb([
      { id: "snap-1", extracted_data: { plans: [] }, content_hash: "abc", created_at: "2026-01-01T00:00:00Z" },
    ]);
    const result = await detectChanges(tenantDb, "tenant-1", "project-1", "https://example.com/pricing", "pricing");
    expect(result.hasPreviousSnapshot).toBe(false);
    expect(result.latestSnapshotId).toBe("snap-1");
  });

  it("reports hasChanged: false when the two latest hashes are identical", async () => {
    const tenantDb = fakeTenantDb([
      { id: "snap-2", extracted_data: { plans: [{ name: "Starter" }] }, content_hash: "same", created_at: "2026-01-02T00:00:00Z" },
      { id: "snap-1", extracted_data: { plans: [{ name: "Starter" }] }, content_hash: "same", created_at: "2026-01-01T00:00:00Z" },
    ]);
    const result = await detectChanges(tenantDb, "tenant-1", "project-1", "https://example.com/pricing", "pricing");
    expect(result.hasPreviousSnapshot).toBe(true);
    expect(result.hasChanged).toBe(false);
    expect(result.fieldChanges).toEqual([]);
  });

  it("computes a real field diff when hashes differ", async () => {
    const tenantDb = fakeTenantDb([
      { id: "snap-2", extracted_data: { plans: [{ name: "Starter", priceText: "$39/mo" }] }, content_hash: "hash-new", created_at: "2026-01-02T00:00:00Z" },
      { id: "snap-1", extracted_data: { plans: [{ name: "Starter", priceText: "$29/mo" }] }, content_hash: "hash-old", created_at: "2026-01-01T00:00:00Z" },
    ]);
    const result = await detectChanges(tenantDb, "tenant-1", "project-1", "https://example.com/pricing", "pricing");
    expect(result.hasChanged).toBe(true);
    expect(result.fieldChanges).toEqual([
      { kind: "changed", path: "plans[0].priceText", before: "$29/mo", after: "$39/mo" },
    ]);
  });
});
