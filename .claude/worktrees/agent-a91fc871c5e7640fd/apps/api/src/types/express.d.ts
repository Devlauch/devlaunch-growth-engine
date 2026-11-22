import type pg from "pg";

declare global {
  namespace Express {
    interface Request {
      /** Set by src/middleware/auth.ts once the caller is authenticated. */
      userId?: string;
      userEmail?: string;
      /** Set by src/middleware/tenant.ts after membership is verified. */
      tenantId?: string;
      membershipRole?: "owner" | "admin" | "member" | "viewer";
      /** A pg client with app.current_tenant_id set (tx-local) for this request's tenant. */
      tenantDb?: pg.PoolClient;
    }
  }
}

export {};
