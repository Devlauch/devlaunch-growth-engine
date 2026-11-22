import pg from "pg";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: env.databaseUrl,
  max: Number(process.env.API_DB_POOL_MAX ?? 10),
});

/**
 * Milestone 3 Phase 1 fix: a real tenant-isolation hole was found where this
 * app connected as a Postgres superuser (`devlaunch`, the Docker image's
 * bootstrap role) — superusers unconditionally bypass Row-Level Security,
 * regardless of FORCE ROW LEVEL SECURITY, making every RLS policy in this
 * codebase a no-op for the API's own connection. Fixed by connecting as the
 * dedicated `devlaunch_app` role instead (see docker-compose.yml and
 * packages/db/migrations/321_create_app_role.sql). This check makes that
 * regression impossible to reintroduce silently: it verifies, at boot,
 * against the real connected role — not configuration, which could drift
 * from reality — that RLS genuinely applies. Called once from src/index.ts.
 */
export async function assertDatabaseRoleRespectsRls(): Promise<void> {
  const result = await pool.query<{ rolsuper: boolean; rolbypassrls: boolean; current_user: string }>(
    "SELECT rolsuper, rolbypassrls, current_user FROM pg_roles WHERE rolname = current_user",
  );
  const row = result.rows[0];
  if (!row) return;
  if (row.rolsuper || row.rolbypassrls) {
    const message = `Database role '${row.current_user}' has rolsuper=${row.rolsuper}/rolbypassrls=${row.rolbypassrls} — Row-Level Security tenant isolation is NOT enforced at the database level for this connection. See docker-compose.yml's api service DATABASE_URL comment.`;
    if (env.nodeEnv === "production") {
      throw new Error(message);
    }
    logger.error({ role: row.current_user, rolsuper: row.rolsuper, rolbypassrls: row.rolbypassrls }, message);
  }
}

/**
 * Runs `fn` inside a transaction with no tenant context set — used only
 * for genuinely tenant-less operations (auth, creating a brand-new
 * tenant, listing a user's own memberships across tenants). Everything
 * tenant-scoped must go through `withTenantContext` in
 * src/middleware/tenant.ts instead, never this.
 */
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
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

/**
 * Like withTransaction, but also sets app.current_user_id (tx-local) to
 * `userId`. This exists ONLY to let a request look up its own
 * memberships/tenants across tenants (see packages/db migration 018 and
 * the `memberships_isolation` / `tenants_isolation` RLS policies) — `userId`
 * must always come from the authenticated request (req.userId), never a
 * client-supplied "which user" parameter, or this would let a caller
 * enumerate another user's tenant memberships.
 */
export async function withUserContext<T>(userId: string, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_user_id', $1, true)", [userId]);
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

/**
 * Runs `fn` inside a transaction with app.current_tenant_id set (tx-local)
 * to `tenantId` — the same pattern as requireTenantMembership
 * (src/middleware/tenant.ts), for the rare write that happens outside any
 * HTTP request and so has no req.tenantDb to reuse (currently: the
 * periodic api_request usage-event flush in src/lib/usageTracking.ts).
 * Mirrors apps/worker/src/db.ts's withTenantContext exactly.
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
