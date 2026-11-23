/**
 * Website structured-change detection (Workstream E). Compares the two
 * most recent website_intelligence_snapshots rows for the same
 * (tenant, project, target_url, snapshot_type) by their `content_hash`
 * (sha256 of `extracted_data` — see structuredExtraction.ts's
 * hashExtractedData) and, when they differ, computes a real field-level
 * diff of the two `extracted_data` payloads. Mirrors the pure/DB-free
 * shape of ../lib/competitorChangeDetection.ts (that one diffs crawled
 * PAGE sets; this one diffs STRUCTURED FIELD sets within one page type),
 * so `detectChanges` itself takes a `tenantDb`-like query function rather
 * than assuming a specific pg client, matching routes/competitors.ts's
 * `req.tenantDb!.query(...)` convention.
 */
import type { PoolClient } from "pg";
import { hashExtractedData } from "./structuredExtraction.js";

export interface WebsiteIntelligenceSnapshotRow {
  id: string;
  target_url: string;
  snapshot_type: string;
  extracted_data: unknown;
  source_evidence: unknown;
  content_hash: string;
  created_at: string;
}

export type FieldChangeKind = "added" | "removed" | "changed";

export interface FieldChange {
  kind: FieldChangeKind;
  /** Dotted path into extracted_data, e.g. "plans[0].priceText". */
  path: string;
  before?: unknown;
  after?: unknown;
}

export interface ChangeResult {
  hasPreviousSnapshot: boolean;
  hasChanged: boolean;
  previousSnapshotId: string | null;
  latestSnapshotId: string | null;
  previousHash: string | null;
  latestHash: string | null;
  fieldChanges: FieldChange[];
}

/** Minimal query surface this module needs — satisfied by `req.tenantDb!` (a pg PoolClient) in routes. */
export interface TenantQueryable {
  query: PoolClient["query"];
}

/**
 * Loads the two most recent website_intelligence_snapshots rows for this
 * (tenantId, projectId, targetUrl, snapshotType) and returns a real
 * change-detection result. Honestly reports `hasPreviousSnapshot: false`
 * (never a fabricated "no changes") when fewer than two snapshots exist
 * yet.
 */
export async function detectChanges(
  tenantDb: TenantQueryable,
  tenantId: string,
  projectId: string,
  targetUrl: string,
  snapshotType: string,
): Promise<ChangeResult> {
  const result = await tenantDb.query(
    `SELECT id, target_url, snapshot_type, extracted_data, source_evidence, content_hash, created_at
     FROM website_intelligence_snapshots
     WHERE tenant_id = $1 AND project_id = $2 AND target_url = $3 AND snapshot_type = $4
     ORDER BY created_at DESC
     LIMIT 2`,
    [tenantId, projectId, targetUrl, snapshotType],
  );
  const rows = result.rows as WebsiteIntelligenceSnapshotRow[];

  if (rows.length === 0) {
    return {
      hasPreviousSnapshot: false,
      hasChanged: false,
      previousSnapshotId: null,
      latestSnapshotId: null,
      previousHash: null,
      latestHash: null,
      fieldChanges: [],
    };
  }

  if (rows.length === 1) {
    return {
      hasPreviousSnapshot: false,
      hasChanged: false,
      previousSnapshotId: null,
      latestSnapshotId: rows[0].id,
      previousHash: null,
      latestHash: rows[0].content_hash,
      fieldChanges: [],
    };
  }

  const [latest, previous] = rows;
  const hasChanged = latest.content_hash !== previous.content_hash;

  return {
    hasPreviousSnapshot: true,
    hasChanged,
    previousSnapshotId: previous.id,
    latestSnapshotId: latest.id,
    previousHash: previous.content_hash,
    latestHash: latest.content_hash,
    fieldChanges: hasChanged ? diffExtractedData(previous.extracted_data, latest.extracted_data) : [],
  };
}

/**
 * Pure structural diff between two already-parsed extracted_data payloads
 * (exported separately so it's unit-testable without a DB). Walks both
 * objects/arrays together and records every leaf value that was added,
 * removed, or changed, by dotted path.
 */
export function diffExtractedData(before: unknown, after: unknown, path = ""): FieldChange[] {
  if (deepEqual(before, after)) return [];

  const beforeIsObj = isPlainObject(before);
  const afterIsObj = isPlainObject(after);
  const beforeIsArr = Array.isArray(before);
  const afterIsArr = Array.isArray(after);

  if (beforeIsArr && afterIsArr) {
    return diffArrays(before as unknown[], after as unknown[], path);
  }

  if (beforeIsObj && afterIsObj) {
    return diffObjects(before as Record<string, unknown>, after as Record<string, unknown>, path);
  }

  // Leaf (or type-mismatch) difference — record the whole subtree as changed.
  if (before === undefined && after !== undefined) {
    return [{ kind: "added", path, after }];
  }
  if (before !== undefined && after === undefined) {
    return [{ kind: "removed", path, before }];
  }
  return [{ kind: "changed", path, before, after }];
}

function diffObjects(before: Record<string, unknown>, after: Record<string, unknown>, path: string): FieldChange[] {
  const changes: FieldChange[] = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    const childPath = path ? `${path}.${key}` : key;
    changes.push(...diffExtractedData(before[key], after[key], childPath));
  }
  return changes;
}

function diffArrays(before: unknown[], after: unknown[], path: string): FieldChange[] {
  const changes: FieldChange[] = [];
  const maxLen = Math.max(before.length, after.length);
  for (let i = 0; i < maxLen; i++) {
    const childPath = `${path}[${i}]`;
    if (i >= before.length) {
      changes.push({ kind: "added", path: childPath, after: after[i] });
    } else if (i >= after.length) {
      changes.push({ kind: "removed", path: childPath, before: before[i] });
    } else {
      changes.push(...diffExtractedData(before[i], after[i], childPath));
    }
  }
  return changes;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return hashExtractedData(a) === hashExtractedData(b);
  } catch {
    return false;
  }
}
