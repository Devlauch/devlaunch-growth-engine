import pg from "pg";
import { env } from "../config/env.js";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: env.databaseUrl,
  max: Number(process.env.API_DB_POOL_MAX ?? 10),
});

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
