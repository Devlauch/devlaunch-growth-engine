import pg from "pg";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? "postgres://devlaunch:devlaunch@localhost:5432/devlaunch_dev",
  max: Number(process.env.WORKER_DB_POOL_MAX ?? 5),
});

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
