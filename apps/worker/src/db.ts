import pg from "pg";
import { logger } from "./logger.js";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? "postgres://devlaunch:devlaunch@localhost:5432/devlaunch_dev",
  max: Number(process.env.WORKER_DB_POOL_MAX ?? 5),
});

/**
 * Milestone 3 Phase 1 fix — see apps/api/src/db/pool.ts's identical check
 * for the full writeup. Same real finding (the app connected as a
 * Postgres superuser, defeating RLS), same fix (docker-compose.yml now
 * points both api and worker at the non-superuser `devlaunch_app` role
 * from packages/db/migrations/321_create_app_role.sql), duplicated here
 * rather than shared via a new package dependency, matching this
 * codebase's existing small-pure-function-duplication convention between
 * apps/api and apps/worker.
 */
export async function assertDatabaseRoleRespectsRls(): Promise<void> {
  const result = await pool.query<{ rolsuper: boolean; rolbypassrls: boolean; current_user: string }>(
    "SELECT rolsuper, rolbypassrls, current_user FROM pg_roles WHERE rolname = current_user",
  );
  const row = result.rows[0];
  if (!row) return;
  if (row.rolsuper || row.rolbypassrls) {
    const message = `Database role '${row.current_user}' has rolsuper=${row.rolsuper}/rolbypassrls=${row.rolbypassrls} — Row-Level Security tenant isolation is NOT enforced at the database level for this connection. See docker-compose.yml's worker service DATABASE_URL comment.`;
    if (process.env.NODE_ENV === "production") {
      throw new Error(message);
    }
    logger.error({ role: row.current_user, rolsuper: row.rolsuper, rolbypassrls: row.rolbypassrls }, message);
  }
}

/**
 * Runs `fn` inside a transaction with app.current_tenant_id set (tx-local)
 * to `tenantId`, so the tenant-isolated RLS policies (packages/db
 * migrations 013/017) apply exactly as they do for API requests. The
 * worker is a trusted internal process, but it still goes through the
 * same RLS path rather than bypassing it, so a bug can never cross tenant
 * boundaries when writing execution results.
 */
export async function withTenantContext<T>(tenantId: string, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
