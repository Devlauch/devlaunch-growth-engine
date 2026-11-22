/**
 * Shared helper for running a query against a table that may not exist yet
 * in a given environment, without poisoning the caller's shared
 * tenant-scoped transaction. Same SAVEPOINT-based degrade-gracefully
 * pattern documented at length in apps/api/src/routes/analytics.ts's
 * `runOptional` and used by apps/api/src/routes/learningLoop.ts — pulled out
 * here as one small shared file (not a route) so the three new
 * marketing-intelligence libs (marketingQa.ts, nextBestAction.ts,
 * reportGenerator.ts) don't each need their own copy of the savepoint
 * bookkeeping. This does not import from, or get imported by, any route
 * file.
 */

export const UNDEFINED_TABLE_ERROR_CODE = "42P01";

export interface OptionalQueryResult<T> {
  rows: T[];
  degraded: boolean;
  note?: string;
}

let savepointCounter = 0;

/**
 * Runs `sql` inside its own SAVEPOINT. If Postgres reports `42P01`
 * (undefined_table — the referenced table doesn't exist in this
 * environment yet), rolls back just that savepoint and returns an honest
 * empty/degraded result with an explanatory note instead of throwing.
 * Any other error is rethrown. Callers on the same shared client must run
 * these sequentially (not via Promise.all).
 */
export async function runOptional<T>(
  tenantDb: import("pg").PoolClient,
  sql: string,
  params: unknown[],
  tableLabel: string,
): Promise<OptionalQueryResult<T>> {
  const savepoint = `mi_sp_${savepointCounter++}`;
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
      return {
        rows: [],
        degraded: true,
        note: `${tableLabel} table does not exist yet in this environment — reporting an honest empty result instead of fabricating data.`,
      };
    }
    throw err;
  }
}

export function isMissingRelationError(err: unknown): boolean {
  return (err as { code?: string } | undefined)?.code === UNDEFINED_TABLE_ERROR_CODE;
}

export function firstCount(result: OptionalQueryResult<{ count: number }>): number {
  return result.rows[0]?.count ?? 0;
}
