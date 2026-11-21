import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { Errors } from "../lib/httpError.js";
import { logger } from "../lib/logger.js";

const uuidSchema = z.string().uuid();

/**
 * Tenant-membership enforcement middleware. This is the one place in the
 * app that is allowed to decide "does this request get to act as this
 * tenant" — every tenant-scoped route depends on it running first.
 *
 * It NEVER trusts the :tenantId route param by itself. Instead, for the
 * authenticated user (req.userId, set by requireAuth):
 *
 *   1. Opens a dedicated pg client + transaction for this request.
 *   2. Sets app.current_tenant_id (tx-local, via set_config) to the
 *      requested tenantId — this is what Postgres RLS policies
 *      (packages/db migrations 013/017) compare every row's tenant_id
 *      against.
 *   3. Queries `memberships` for an active row matching
 *      (tenant_id = :tenantId, user_id = req.userId). Because RLS is
 *      already scoped to :tenantId, this query can only ever see rows for
 *      that tenant — it cannot accidentally leak another tenant's
 *      membership rows even if something upstream were buggy.
 *   4. If no active membership is found, the whole transaction is rolled
 *      back and the client released, and the request is rejected with 403
 *      — the client-supplied tenantId was never honored without this check
 *      passing.
 *   5. On success, req.tenantId / req.membershipRole / req.tenantDb are
 *      set, and req.tenantDb (already inside the tenant-scoped
 *      transaction) is what every downstream route handler must use for
 *      its queries. The transaction is committed/rolled back and the
 *      client released automatically when the response finishes
 *      (see attachTenantDbLifecycle below).
 */
export async function requireTenantMembership(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!req.userId) {
    next(Errors.unauthorized());
    return;
  }

  const parsed = uuidSchema.safeParse(req.params.tenantId);
  if (!parsed.success) {
    next(Errors.badRequest("tenantId must be a UUID"));
    return;
  }
  const tenantId = parsed.data;

  const client = await pool.connect();
  let settled = false;

  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);

    const membershipResult = await client.query(
      `SELECT id, role, status FROM memberships WHERE tenant_id = $1 AND user_id = $2 AND status = 'active'`,
      [tenantId, req.userId],
    );

    if (membershipResult.rowCount === 0) {
      await client.query("ROLLBACK");
      client.release();
      settled = true;
      logger.warn({ userId: req.userId, tenantId }, "tenant membership check failed, denying access");
      next(Errors.forbidden("You do not have access to this tenant"));
      return;
    }

    req.tenantId = tenantId;
    req.membershipRole = membershipResult.rows[0].role;
    req.tenantDb = client;

    attachTenantDbLifecycle(req, res, client);
    next();
  } catch (err) {
    if (!settled) {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
    next(err);
  }
}

/**
 * Commits the tenant-scoped transaction when the response finishes
 * successfully (status < 400), or rolls it back otherwise, then releases
 * the client back to the pool. Ensures a pooled connection is never
 * returned with app.current_tenant_id still "set" beyond this request —
 * though since it's set with the tx-local flag, COMMIT/ROLLBACK clears it
 * regardless.
 */
function attachTenantDbLifecycle(req: Request, res: Response, client: import("pg").PoolClient): void {
  let finished = false;
  const finish = async () => {
    if (finished) return;
    finished = true;
    try {
      if (res.statusCode >= 400) {
        await client.query("ROLLBACK");
      } else {
        await client.query("COMMIT");
      }
    } catch (err) {
      logger.error({ err }, "failed to finalize tenant-scoped transaction");
    } finally {
      client.release();
    }
  };
  res.once("finish", finish);
  res.once("close", finish);
}
