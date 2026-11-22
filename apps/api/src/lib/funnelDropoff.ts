/**
 * Real funnel drop-off computation (Phase 2 item 5, "Conversion
 * Optimization Agent", "funnel drop-off detection").
 *
 * Deliberately queries the SAME tables apps/api/src/routes/analytics.ts's
 * `GET /funnel` endpoint already defines (discovered_organizations, leads,
 * lead_scores, message_drafts, lead_replies, sequence_enrollments) with
 * equivalent SQL — there is nothing importable from analytics.ts (it's
 * route handlers, not a library), so this is intentional duplication of a
 * read query, same precedent as scoreLead.ts duplicating leadScoring.ts's
 * pure logic.
 *
 * Only the four always-real, always-available stages analytics.ts itself
 * defines are used here: discovered, qualified, contacted, replied. demo
 * and won are skipped on purpose — analytics.ts documents both as proxies
 * (demo) or entirely absent from the schema (won), and a drop-off
 * computation built on top of a proxy/empty stage would invent better data
 * than the source endpoint honestly has.
 *
 * Degrades gracefully, same SAVEPOINT-catch convention as
 * apps/api/src/routes/analytics.ts's runOptional / onboarding.ts's
 * SAVEPOINT usage: a missing dependent table (42P01) rolls back only its
 * own SAVEPOINT, so the shared per-request transaction (see
 * middleware/tenant.ts) is never poisoned, and that stage reports a real
 * zero instead of aborting the whole computation.
 */

const QUALIFIED_SCORE_THRESHOLD = 50;
const UNDEFINED_TABLE_ERROR_CODE = "42P01";
let dropoffSavepointCounter = 0;

export type FunnelStageName = "discovered" | "qualified" | "contacted" | "replied";

export interface FunnelStageCount {
  stage: FunnelStageName;
  count: number;
}

export interface FunnelStageDropoff {
  fromStage: FunnelStageName;
  toStage: FunnelStageName;
  dropoffPercent: number;
}

export interface FunnelDropoffResult {
  stages: FunnelStageCount[];
  dropoffs: FunnelStageDropoff[];
}

interface OptionalQueryResult<T> {
  rows: T[];
  degraded: boolean;
}

async function runOptional<T>(
  tenantDb: import("pg").PoolClient,
  sql: string,
  params: unknown[],
): Promise<OptionalQueryResult<T>> {
  const savepoint = `dropoff_sp_${dropoffSavepointCounter++}`;
  await tenantDb.query(`SAVEPOINT ${savepoint}`);
  try {
    const result = await tenantDb.query(sql, params);
    await tenantDb.query(`RELEASE SAVEPOINT ${savepoint}`);
    return { rows: result.rows as T[], degraded: false };
  } catch (err) {
    const code = (err as { code?: string } | undefined)?.code;
    if (code === UNDEFINED_TABLE_ERROR_CODE) {
      await tenantDb.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      await tenantDb.query(`RELEASE SAVEPOINT ${savepoint}`);
      return { rows: [], degraded: true };
    }
    throw err;
  }
}

function firstCount(result: OptionalQueryResult<{ count: number }>): number {
  return result.rows[0]?.count ?? 0;
}

/** (fromCount - toCount) / fromCount * 100, guarded against div-by-zero. */
export function computeDropoffPercent(fromCount: number, toCount: number): number {
  if (fromCount === 0) return 0;
  return ((fromCount - toCount) / fromCount) * 100;
}

/**
 * Computes real stage counts and consecutive-stage drop-off percentages for
 * one tenant+project, using the same four real funnel stages
 * analytics.ts's `/funnel` endpoint reports (discovered/qualified/
 * contacted/replied). Must be called with queries run sequentially (not
 * via Promise.all), since SAVEPOINT/RELEASE must be issued in order on the
 * one shared tenant-scoped client — same constraint as analytics.ts's
 * runOptional.
 */
export async function computeFunnelDropoff(
  tenantDb: import("pg").PoolClient,
  tenantId: string,
  projectId: string,
): Promise<FunnelDropoffResult> {
  // --- discovered: discovered_organizations count (optional table) ---
  const discovered = await runOptional<{ count: number }>(
    tenantDb,
    `SELECT count(*)::int AS count FROM discovered_organizations WHERE tenant_id = $1 AND project_id = $2`,
    [tenantId, projectId],
  );

  // --- qualified: union of leads.status = 'qualified' OR lead_scores.total_score >= threshold ---
  const qualifiedCombined = await runOptional<{ count: number }>(
    tenantDb,
    `SELECT count(*)::int AS count
     FROM leads l
     WHERE l.tenant_id = $1 AND l.project_id = $2
       AND (
         l.status = 'qualified'
         OR EXISTS (
           SELECT 1 FROM lead_scores ls
           WHERE ls.lead_id = l.id AND ls.total_score >= ${QUALIFIED_SCORE_THRESHOLD}
         )
       )`,
    [tenantId, projectId],
  );
  let qualifiedCount: number;
  if (qualifiedCombined.degraded) {
    // lead_scores isn't there yet — fall back to the half of the union
    // that IS always real: leads.status alone.
    const statusOnly = await tenantDb.query(
      `SELECT count(*)::int AS count FROM leads WHERE tenant_id = $1 AND project_id = $2 AND status = 'qualified'`,
      [tenantId, projectId],
    );
    qualifiedCount = statusOnly.rows[0]?.count ?? 0;
  } else {
    qualifiedCount = firstCount(qualifiedCombined);
  }

  // --- contacted: distinct leads with an approved message draft ---
  const contacted = await runOptional<{ count: number }>(
    tenantDb,
    `SELECT count(DISTINCT lead_id)::int AS count
     FROM message_drafts
     WHERE tenant_id = $1 AND project_id = $2 AND status = 'approved'`,
    [tenantId, projectId],
  );

  // --- replied: distinct leads with any logged reply ---
  const replied = await runOptional<{ count: number }>(
    tenantDb,
    `SELECT count(DISTINCT lead_id)::int AS count FROM lead_replies WHERE tenant_id = $1 AND project_id = $2`,
    [tenantId, projectId],
  );

  const stages: FunnelStageCount[] = [
    { stage: "discovered", count: firstCount(discovered) },
    { stage: "qualified", count: qualifiedCount },
    { stage: "contacted", count: firstCount(contacted) },
    { stage: "replied", count: firstCount(replied) },
  ];

  const dropoffs: FunnelStageDropoff[] = [];
  for (let i = 0; i < stages.length - 1; i++) {
    const from = stages[i];
    const to = stages[i + 1];
    dropoffs.push({
      fromStage: from.stage,
      toStage: to.stage,
      dropoffPercent: computeDropoffPercent(from.count, to.count),
    });
  }

  return { stages, dropoffs };
}
