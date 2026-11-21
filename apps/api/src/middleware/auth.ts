import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { Errors } from "../lib/httpError.js";
import { logger } from "../lib/logger.js";

export interface AccessTokenPayload {
  sub: string; // user id
  email: string;
  type: "access";
}

/**
 * Authentication middleware.
 *
 * Primary path: a real `Authorization: Bearer <jwt>` access token issued by
 * POST /api/v1/auth/login or /auth/refresh.
 *
 * DEV ONLY fallback: if ALLOW_DEV_AUTH=true (the Phase 1 default) and no
 * bearer token is present, an `X-Dev-User-Id` header is accepted as-is to
 * identify the caller. This is a development convenience ONLY — it trusts
 * a client-supplied header with zero verification of identity, and MUST be
 * disabled (ALLOW_DEV_AUTH=false) before any production/shared deployment.
 * Importantly, this header only ever identifies *who the user claims to
 * be*; it never grants tenant access by itself — src/middleware/tenant.ts
 * still looks up real `memberships` rows for that user id before allowing
 * any tenant-scoped request through.
 */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const authHeader = req.header("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice("Bearer ".length);
    try {
      const payload = jwt.verify(token, env.jwtAccessSecret) as AccessTokenPayload;
      if (payload.type !== "access") {
        return next(Errors.unauthorized("Not an access token"));
      }
      req.userId = payload.sub;
      req.userEmail = payload.email;
      return next();
    } catch {
      return next(Errors.unauthorized("Invalid or expired access token"));
    }
  }

  if (env.allowDevAuth) {
    const devUserId = req.header("x-dev-user-id");
    if (devUserId) {
      logger.warn({ devUserId }, "DEV ONLY: authenticated via X-Dev-User-Id header — disable ALLOW_DEV_AUTH before production");
      req.userId = devUserId;
      return next();
    }
  }

  return next(Errors.unauthorized("Provide Authorization: Bearer <token>, or X-Dev-User-Id (dev only)"));
}
