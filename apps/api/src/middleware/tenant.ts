import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { env } from "../config/env.js";
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
 *   4. If no active membership is found, this falls through to one more
 *      check: is the caller's own email (looked up fresh from `users` by
 *      req.userId, never client-supplied) in env.platformAdminEmails? That
 *      env var is a short, explicit, opt-in allowlist of real "root"
 *      support/ops accounts (see config/env.ts) — it does NOT touch RLS or
 *      skip app.current_tenant_id in any way, it only skips the requirement
 *      that a memberships row exist for this specific tenant. If the email
 *      isn't on the list either, the whole transaction is rolled back and
 *      the client released, and the request is rejected with 403 — the
 *      client-supplied tenantId was never honored without one of these two
 *      checks passing.
 *   5. On success, req.tenantId / req.membershipRole / req.tenantDb are
 *      set, and req.tenantDb (already inside the tenant-scoped
 *      transaction) is what every downstream route handler must use for
 *      its queries. The transaction is committed/rolled back and the
 *      client released automatically when the response finishes
 *      (see attachTenantDbLifecycle below).
 */
/**
 * Looks up the caller's own email fresh from `users` (never trusts
 * req.userEmail, which is only ever populated on the JWT auth path — the
 * dev-auth X-Dev-User-Id header fallback leaves it unset) and checks it
 * against env.platformAdminEmails. `users` has no RLS policy (it's a global
 * account table, see packages/db/migrations/003_create_users.sql), so this
 * read is unaffected by the tx-local app.current_tenant_id already set on
 * `client` for the target tenant.
 */
async function checkPlatformAdmin(client: import("pg").PoolClient, userId: string): Promise<boolean> {
  if (env.platformAdminEmails.length === 0) return false;
  const result = await client.query<{ email: string }>("SELECT email FROM users WHERE id = $1", [userId]);
  const email = result.rows[0]?.email?.toLowerCase();
  return email !== undefined && env.platformAdminEmails.includes(email);
}

/**
 * Gate for genuinely cross-tenant admin routes (routes/admin.ts) — unlike
 * requireTenantMembership, there is no single :tenantId to scope a
 * transaction to here, so this never sets app.current_tenant_id at all; it
 * only decides whether req.userId's email is on env.platformAdminEmails.
 * Each admin route handler is then responsible for explicitly iterating
 * tenants (e.g. via withTenantContext per tenant_id) rather than relying on
 * RLS to scope a single query — see routes/admin.ts.
 */
export async function requirePlatformAdmin(req: Request, _res: Response, next: NextFunction): Promise<void> {
  if (!req.userId) {
    next(Errors.unauthorized());
    return;
  }
  if (env.platformAdminEmails.length === 0) {
    next(Errors.forbidden("No platform admins are configured"));
    return;
  }
  try {
    const result = await pool.query<{ email: string }>("SELECT email FROM users WHERE id = $1", [req.userId]);
    const email = result.rows[0]?.email?.toLowerCase();
    if (!email || !env.platformAdminEmails.includes(email)) {
      logger.warn({ userId: req.userId }, "non-platform-admin tried to use an admin route");
      next(Errors.forbidden("Platform admin access required"));
      return;
    }
    req.isPlatformAdmin = true;
    next();
  } catch (err) {
    next(err);
  }
}

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
    // Sets BOTH session variables in one round trip (and one mocked query
    // call, for the existing test suite's mockMembership() helpers):
    // app.current_tenant_id (the long-standing tenant-isolation variable)
    // and app.current_user_id (the authenticated caller — req.userId only,
    // never a client-supplied value). The latter was previously set only
    // by withUserContext() for the narrow self-lookup RLS policies added in
    // 018_extend_memberships_rls_self_lookup.sql; it's now set here too so
    // the same pattern can back the notifications table's per-user RLS
    // policy (packages/db/migrations/251_enable_rls_notifications.sql).
    await client.query(
      "SELECT set_config('app.current_tenant_id', $1, true), set_config('app.current_user_id', $2, true)",
      [tenantId, req.userId],
    );

    const membershipResult = await client.query(
      `SELECT id, role, status FROM memberships WHERE tenant_id = $1 AND user_id = $2 AND status = 'active'`,
      [tenantId, req.userId],
    );

    if (membershipResult.rowCount === 0) {
      const isPlatformAdmin = await checkPlatformAdmin(client, req.userId);
      if (!isPlatformAdmin) {
        await client.query("ROLLBACK");
        client.release();
        settled = true;
        logger.warn({ userId: req.userId, tenantId }, "tenant membership check failed, denying access");
        next(Errors.forbidden("You do not have access to this tenant"));
        return;
      }

      logger.warn({ userId: req.userId, tenantId }, "platform admin accessing tenant without a memberships row");
      req.tenantId = tenantId;
      req.membershipRole = "platform_admin";
      req.isPlatformAdmin = true;
      req.tenantDb = client;

      attachTenantDbLifecycle(req, res, client);
      next();
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
 *
 * Every route in this app (plus errorHandler.ts/notFoundHandler.ts)
 * responds via res.json(), so the commit/rollback happens *inside* that
 * call, before it writes any bytes to the socket — not on the "finish"
 * event, which fires only after the response is already on the wire. The
 * earlier finish/close-based version left a real race: a client that
 * received a 2xx response and immediately issued its next request could
 * have that next request's own transaction start, and query, before this
 * one's COMMIT had actually run — a read-committed snapshot simply
 * wouldn't see the just-written row yet (reproduced via real sequential
 * HTTP calls: stale GETs immediately after a POST/PATCH, duplicate-check
 * races, etc.). Committing before the response leaves the process closes
 * that window entirely.
 */
function attachTenantDbLifecycle(req: Request, res: Response, client: import("pg").PoolClient): void {
  let settled = false;

  async function finalize(): Promise<void> {
    if (settled) return;
    settled = true;
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
  }

  const originalJson = res.json.bind(res);
  res.json = ((body?: unknown) => {
    finalize()
      .catch((err) => logger.error({ err }, "failed to finalize tenant-scoped transaction before responding"))
      .then(() => originalJson(body));
    return res;
  }) as typeof res.json;

  // Fallback only: a request whose connection is aborted before any
  // handler ever calls res.json (so the override above never runs) must
  // still release its pooled client instead of leaking it.
  res.once("close", () => {
    void finalize();
  });
}
