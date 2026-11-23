import type pg from "pg";

declare global {
  namespace Express {
    interface Request {
      /** Set by src/middleware/auth.ts once the caller is authenticated. */
      userId?: string;
      userEmail?: string;
      /** Set by src/middleware/tenant.ts after membership is verified. */
      tenantId?: string;
      membershipRole?: "owner" | "admin" | "marketer" | "sales" | "analyst" | "viewer" | "member" | "platform_admin";
      /** true only when requireTenantMembership let this request through via env.platformAdminEmails, not a real memberships row. */
      isPlatformAdmin?: boolean;
      /** A pg client with app.current_tenant_id set (tx-local) for this request's tenant. */
      tenantDb?: pg.PoolClient;
      /**
       * Raw request body bytes, captured by app.ts's express.json()
       * `verify` callback. Needed by routes/chatwootWebhooks.ts to verify
       * Chatwoot's HMAC-SHA256 webhook signature (computed over the exact
       * raw bytes Chatwoot sent, not a re-serialization of the parsed
       * body) — see that route's doc comment.
       */
      rawBody?: Buffer;
    }
  }
}

export {};
