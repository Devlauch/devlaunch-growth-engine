import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { Errors } from "../lib/httpError.js";

/**
 * Mounted at /api/v1/tenants/:tenantId/notifications
 *
 * Real in-app notifications for the authenticated user, within this
 * tenant. There is no email/WhatsApp sending anywhere in this app — this
 * is the one real notification surface (see src/lib/notify.ts for how rows
 * get written, and the dashboard's notification bell for how they're
 * read). The notifications table's RLS (packages/db/migrations
 * 251_enable_rls_notifications.sql) independently enforces that a SELECT
 * or UPDATE here can only ever touch req.userId's own rows, even though
 * this route additionally filters by user_id = req.userId itself — belt
 * and suspenders, same as every other tenant-scoped route in this app.
 */
export const notificationsRouter = Router({ mergeParams: true });
notificationsRouter.use(requireAuth, requireTenantMembership);

/**
 * GET /api/v1/tenants/:tenantId/notifications
 *
 * Paginated, unread-first (then newest-first) list of the caller's own
 * notifications in this tenant.
 */
notificationsRouter.get("/", async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit ?? 20) || 20, 100);
    const offset = Math.max(Number(req.query.offset ?? 0) || 0, 0);

    const result = await req.tenantDb!.query(
      `SELECT id, type, title, body, link_url, read_at, created_at
       FROM notifications
       WHERE tenant_id = $1 AND user_id = $2
       ORDER BY (read_at IS NULL) DESC, created_at DESC
       LIMIT $3 OFFSET $4`,
      [req.tenantId, req.userId, limit, offset],
    );

    const unreadCountResult = await req.tenantDb!.query(
      `SELECT count(*)::int AS count FROM notifications
       WHERE tenant_id = $1 AND user_id = $2 AND read_at IS NULL`,
      [req.tenantId, req.userId],
    );

    res.json({
      notifications: result.rows,
      unreadCount: unreadCountResult.rows[0]?.count ?? 0,
      limit,
      offset,
    });
  } catch (err) {
    next(err);
  }
});

/** POST /api/v1/tenants/:tenantId/notifications/:id/read */
notificationsRouter.post("/:id/read", async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);

    // The WHERE clause (tenant_id + user_id = req.userId) is the app-layer
    // enforcement; the notifications_update RLS policy enforces the exact
    // same thing independently, so this can never update another user's
    // notification even if this WHERE clause were ever removed by mistake.
    const result = await req.tenantDb!.query(
      `UPDATE notifications
       SET read_at = now()
       WHERE id = $1 AND tenant_id = $2 AND user_id = $3 AND read_at IS NULL
       RETURNING id, type, title, body, link_url, read_at, created_at`,
      [id, req.tenantId, req.userId],
    );

    if (result.rowCount === 0) {
      // Either it doesn't exist, isn't this user's, or was already read —
      // treat "already read" as a no-op success rather than erroring, but
      // a genuinely missing/foreign notification is a real 404.
      const existing = await req.tenantDb!.query(
        `SELECT id, type, title, body, link_url, read_at, created_at
         FROM notifications WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
        [id, req.tenantId, req.userId],
      );
      if (existing.rowCount === 0) {
        throw Errors.notFound("Notification not found");
      }
      res.json({ notification: existing.rows[0] });
      return;
    }

    res.json({ notification: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

/** POST /api/v1/tenants/:tenantId/notifications/mark-all-read */
notificationsRouter.post("/mark-all-read", async (req, res, next) => {
  try {
    const result = await req.tenantDb!.query(
      `UPDATE notifications
       SET read_at = now()
       WHERE tenant_id = $1 AND user_id = $2 AND read_at IS NULL`,
      [req.tenantId, req.userId],
    );

    res.json({ markedRead: result.rowCount ?? 0 });
  } catch (err) {
    next(err);
  }
});
