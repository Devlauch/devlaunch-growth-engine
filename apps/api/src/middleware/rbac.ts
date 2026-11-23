import type { Request, Response, NextFunction } from "express";
import { Errors } from "../lib/httpError.js";

/**
 * The tenant membership role set, matching the product spec exactly and
 * the `memberships.role` CHECK constraint (see packages/db/migrations
 * 004_create_memberships.sql + 066_extend_membership_roles.sql).
 *
 * 'member' is kept only because it is the column's pre-existing DEFAULT
 * and appears in already-seeded/existing rows (packages/db/migrations
 * 014_seed_dev_tenant.sql and any membership created before this change) —
 * it is not part of the product spec's role set and new memberships
 * should always be created with one of the real spec roles below. It is
 * treated the same as 'viewer' (read-only) everywhere requireRole is used,
 * since it was never a privileged role to begin with.
 */
export const ROLES = ["owner", "admin", "marketer", "sales", "analyst", "viewer"] as const;
export type Role = (typeof ROLES)[number] | "member";

/** Roles that may manage billing/membership/tenant-level settings. */
export const ADMIN_ROLES = ["owner", "admin"] as const;

/** Roles that may create/approve go-to-market work (campaigns, approvals). */
export const GTM_ROLES = ["owner", "admin", "marketer"] as const;

/**
 * requireRole(...allowedRoles) — composes AFTER requireTenantMembership in
 * a route's middleware chain (it reads req.membershipRole, which
 * requireTenantMembership already resolved in its one membership-lookup
 * query; this never issues a second DB round-trip). Mirrors the inline
 * requireRole() helper that was duplicated in routes/memberships.ts — that
 * file has been updated to import this shared version instead.
 *
 * Usage:
 *   router.post("/", requireRole("owner", "admin"), async (req, res, next) => { ... })
 */
export function requireRole(...allowedRoles: readonly Role[]) {
  return function requireRoleMiddleware(req: Request, _res: Response, next: NextFunction): void {
    // A platform admin (env.PLATFORM_ADMIN_EMAILS, see middleware/tenant.ts)
    // has no real memberships row and so no real role to check against any
    // allowedRoles list — by design, it passes every role gate on every
    // tenant it opens this way.
    if (req.isPlatformAdmin) {
      next();
      return;
    }
    if (!req.membershipRole || !allowedRoles.includes(req.membershipRole as Role)) {
      next(Errors.forbidden(`Requires one of role: ${allowedRoles.join(", ")}`));
      return;
    }
    next();
  };
}
