import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Unit tests for apps/api/src/lib/experimentEngine.ts, mocking a tenant-db
 * PoolClient directly (same mocked-pg convention as test/agentRuns.test.ts
 * / test/campaigns.test.ts -- a fake query() function fed scripted
 * responses in call order) rather than hitting a real Postgres, since this
 * module's exported functions all take a PoolClient as their first
 * argument instead of going through an HTTP route.
 */

const { assignVariant, recordConversion, evaluateExperiment, applyWinningVariant, hashToUnitInterval, pickVariantForWeights, twoProportionZTest, standardNormalCdf } =
  await import("../src/lib/experimentEngine.js");

const TENANT_ID = "11111111-1111-1111-1111-111111111111";
const PROJECT_ID = "22222222-2222-2222-2222-222222222222";
const EXPERIMENT_ID = "33333333-3333-3333-3333-333333333333";
const VISITOR_A = "visitor-aaaaaaaaaaaaaaaa";
const VISITOR_B = "visitor-bbbbbbbbbbbbbbbb";
const USER_ID = "user-1";

function makeExperimentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: EXPERIMENT_ID,
    tenant_id: TENANT_ID,
    project_id: PROJECT_ID,
    name: "Hero headline test",
    hypothesis: "A benefit-led headline converts better",
    target_entity_type: "landing_page",
    target_entity_id: "44444444-4444-4444-4444-444444444444",
    status: "running",
    variants: [
      { key: "control", label: "Control", weight: 50 },
      { key: "challenger", label: "Challenger", weight: 50, headline: "New headline" },
    ],
    primary_metric_event: "form_submit",
    min_sample_size: 200,
    started_at: new Date().toISOString(),
    concluded_at: null,
    winning_variant_key: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeClient() {
  const query = vi.fn();
  return { query } as unknown as { query: ReturnType<typeof vi.fn> };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("hashToUnitInterval / pickVariantForWeights -- deterministic assignment math", () => {
  it("hashToUnitInterval returns the exact same value for the same input every time", () => {
    const first = hashToUnitInterval(`${EXPERIMENT_ID}:${VISITOR_A}`);
    const second = hashToUnitInterval(`${EXPERIMENT_ID}:${VISITOR_A}`);
    const third = hashToUnitInterval(`${EXPERIMENT_ID}:${VISITOR_A}`);
    expect(first).toBe(second);
    expect(second).toBe(third);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(1);
  });

  it("different visitors generally hash to different unit values (not a constant function)", () => {
    const a = hashToUnitInterval(`${EXPERIMENT_ID}:${VISITOR_A}`);
    const b = hashToUnitInterval(`${EXPERIMENT_ID}:${VISITOR_B}`);
    expect(a).not.toBe(b);
  });

  it("pickVariantForWeights is a pure deterministic function of (variants, unit)", () => {
    const variants = [
      { key: "control", label: "Control", weight: 50 },
      { key: "challenger", label: "Challenger", weight: 50 },
    ];
    const unit = hashToUnitInterval(`${EXPERIMENT_ID}:${VISITOR_A}`);
    const first = pickVariantForWeights(variants, unit);
    const second = pickVariantForWeights(variants, unit);
    expect(first).toBe(second);
    expect(["control", "challenger"]).toContain(first);
  });
});

describe("assignVariant -- stable per-visitor assignment, not re-rolled", () => {
  it("returns the already-recorded variant_key on a repeat call, without recomputing a new assignment", async () => {
    const client = makeClient();
    // First call: no existing exposure row yet.
    client.query
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // existing exposure check
      .mockResolvedValueOnce({ rowCount: 1, rows: [makeExperimentRow()] }) // loadExperimentOr404
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ variant_key: "control" }] }); // INSERT ... RETURNING

    const firstAssignment = await assignVariant(client as any, TENANT_ID, EXPERIMENT_ID, VISITOR_A);
    expect(["control", "challenger"]).toContain(firstAssignment);

    // Second call for the SAME visitor: an exposure row now exists, so the
    // function must short-circuit to it and never recompute/re-insert.
    client.query.mockReset();
    client.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ variant_key: firstAssignment }] });

    const secondAssignment = await assignVariant(client as any, TENANT_ID, EXPERIMENT_ID, VISITOR_A);
    expect(secondAssignment).toBe(firstAssignment);
    // Only ONE query (the existing-exposure check) was issued -- no
    // re-computation, no second INSERT.
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it("a concurrent-insert race still converges on one shared variant_key (re-reads the row that actually won)", async () => {
    const client = makeClient();
    client.query
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // existing exposure check: none yet
      .mockResolvedValueOnce({ rowCount: 1, rows: [makeExperimentRow()] }) // loadExperimentOr404
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // INSERT ... ON CONFLICT DO NOTHING: lost the race
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ variant_key: "challenger" }] }); // re-read: the real winner

    const assignment = await assignVariant(client as any, TENANT_ID, EXPERIMENT_ID, VISITOR_A);
    expect(assignment).toBe("challenger");
  });
});

describe("twoProportionZTest / standardNormalCdf -- real significance math", () => {
  it("reports a significant difference for a large, clearly-different sample", () => {
    // 1000 exposures/variant, 50 vs 150 conversions -- a stark, real gap.
    const { z, p } = twoProportionZTest(50, 1000, 150, 1000);
    expect(Math.abs(z)).toBeGreaterThan(1.96);
    expect(p).toBeLessThan(0.05);
  });

  it("reports no significance for near-identical conversion rates", () => {
    const { p } = twoProportionZTest(100, 1000, 102, 1000);
    expect(p).toBeGreaterThan(0.05);
  });

  it("standardNormalCdf(0) is exactly 0.5 and is monotonically increasing", () => {
    expect(standardNormalCdf(0)).toBeCloseTo(0.5, 3);
    expect(standardNormalCdf(2)).toBeGreaterThan(standardNormalCdf(1));
    expect(standardNormalCdf(-2)).toBeLessThan(standardNormalCdf(-1));
  });

  it("degenerate input (zero exposures) never divides by zero or returns NaN", () => {
    const { z, p } = twoProportionZTest(0, 0, 0, 0);
    expect(Number.isFinite(z)).toBe(true);
    expect(Number.isFinite(p)).toBe(true);
  });
});

describe("evaluateExperiment -- never claims significance below min_sample_size", () => {
  it("returns isSignificant:false with reason insufficient_sample_size when total exposures are below min_sample_size, even for a dramatic-looking gap", async () => {
    const client = makeClient();
    const tinyExperiment = makeExperimentRow({ min_sample_size: 1000 });
    client.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [tinyExperiment] })
      .mockResolvedValueOnce({
        rowCount: 2,
        rows: [
          { variant_key: "control", exposures: 10 },
          { variant_key: "challenger", exposures: 10 },
        ],
      })
      .mockResolvedValueOnce({
        rowCount: 2,
        rows: [
          { variant_key: "control", conversions: 0 },
          { variant_key: "challenger", conversions: 10 },
        ],
      });

    const evaluation = await evaluateExperiment(client as any, TENANT_ID, EXPERIMENT_ID);

    expect(evaluation.sampleSize).toBe(20);
    expect(evaluation.sampleSize).toBeLessThan(evaluation.minSampleSize);
    expect(evaluation.isSignificant).toBe(false);
    expect(evaluation.reason).toBe("insufficient_sample_size");
    expect(evaluation.bestVariantKey).toBeNull();
  });

  it("reports a real significant winner once the sample size requirement is met and the gap is large", async () => {
    const client = makeClient();
    const readyExperiment = makeExperimentRow({ min_sample_size: 200 });
    client.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [readyExperiment] })
      .mockResolvedValueOnce({
        rowCount: 2,
        rows: [
          { variant_key: "control", exposures: 500 },
          { variant_key: "challenger", exposures: 500 },
        ],
      })
      .mockResolvedValueOnce({
        rowCount: 2,
        rows: [
          { variant_key: "control", conversions: 50 },
          { variant_key: "challenger", conversions: 150 },
        ],
      });

    const evaluation = await evaluateExperiment(client as any, TENANT_ID, EXPERIMENT_ID);

    expect(evaluation.sampleSize).toBe(1000);
    expect(evaluation.isSignificant).toBe(true);
    expect(evaluation.bestVariantKey).toBe("challenger");
    expect(evaluation.pValue).not.toBeNull();
    expect(evaluation.pValue as number).toBeLessThan(0.05);
  });
});

describe("applyWinningVariant -- approval-gated, never mutates the live entity directly", () => {
  it("refuses (throws) when the experiment is not yet statistically significant, and drafts nothing", async () => {
    const client = makeClient();
    const tinyExperiment = makeExperimentRow({ min_sample_size: 1000, status: "running" });
    client.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [tinyExperiment] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [tinyExperiment] })
      .mockResolvedValueOnce({
        rowCount: 2,
        rows: [
          { variant_key: "control", exposures: 10 },
          { variant_key: "challenger", exposures: 10 },
        ],
      })
      .mockResolvedValueOnce({
        rowCount: 2,
        rows: [
          { variant_key: "control", conversions: 0 },
          { variant_key: "challenger", conversions: 10 },
        ],
      });

    await expect(applyWinningVariant(client as any, TENANT_ID, EXPERIMENT_ID, USER_ID)).rejects.toThrow(
      /insufficient|sample size/i,
    );

    const queriedSql = client.query.mock.calls.map((call) => String(call[0]));
    expect(queriedSql.some((sql) => sql.includes("INSERT INTO approvals"))).toBe(false);
    expect(queriedSql.some((sql) => sql.includes("INSERT INTO growth_experiment_actions"))).toBe(false);
    expect(queriedSql.some((sql) => sql.includes("UPDATE landing_pages"))).toBe(false);
  });
});

describe("applyWinningVariant -- drafting a real approval on a genuine winner", () => {
  it("on a real significant winner, drafts a growth_experiment_actions row and a paired approvals row -- and STILL never touches landing_pages directly", async () => {
    const client = makeClient();
    const readyExperiment = makeExperimentRow({ min_sample_size: 200, status: "running" });
    client.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [readyExperiment] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [readyExperiment] })
      .mockResolvedValueOnce({
        rowCount: 2,
        rows: [
          { variant_key: "control", exposures: 500 },
          { variant_key: "challenger", exposures: 500 },
        ],
      })
      .mockResolvedValueOnce({
        rowCount: 2,
        rows: [
          { variant_key: "control", conversions: 50 },
          { variant_key: "challenger", conversions: 150 },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "action-1", status: "pending_approval" }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "approval-1", status: "pending" }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const outcome = await applyWinningVariant(client as any, TENANT_ID, EXPERIMENT_ID, USER_ID);

    expect(outcome.action).toEqual({ id: "action-1", status: "pending_approval" });
    expect(outcome.approval).toEqual({ id: "approval-1", status: "pending" });
    expect(outcome.evaluation.isSignificant).toBe(true);

    const queriedSql = client.query.mock.calls.map((call) => String(call[0]));
    expect(queriedSql.some((sql) => sql.includes("INSERT INTO growth_experiment_actions"))).toBe(true);
    expect(queriedSql.some((sql) => sql.includes("INSERT INTO approvals"))).toBe(true);
    expect(queriedSql.some((sql) => sql.includes("UPDATE landing_pages"))).toBe(false);
  });

  it("refuses to apply a winner for an experiment that is not currently running", async () => {
    const client = makeClient();
    const draftExperiment = makeExperimentRow({ status: "draft" });
    client.query.mockResolvedValueOnce({ rowCount: 1, rows: [draftExperiment] });

    await expect(applyWinningVariant(client as any, TENANT_ID, EXPERIMENT_ID, USER_ID)).rejects.toThrow(/running/i);
  });
});

describe("recordConversion -- writes a real conversion row for an existing experiment", () => {
  it("throws 404 for an experiment that does not belong to this tenant", async () => {
    const client = makeClient();
    client.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await expect(recordConversion(client as any, TENANT_ID, EXPERIMENT_ID, VISITOR_A)).rejects.toThrow(/not found/i);
  });

  it("inserts a real experiment_conversions row when the experiment exists", async () => {
    const client = makeClient();
    client.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [makeExperimentRow()] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    await recordConversion(client as any, TENANT_ID, EXPERIMENT_ID, VISITOR_A, 42);

    const insertCall = client.query.mock.calls[1];
    expect(String(insertCall[0])).toContain("INSERT INTO experiment_conversions");
    expect(insertCall[1]).toEqual([TENANT_ID, EXPERIMENT_ID, VISITOR_A, 42]);
  });
});
