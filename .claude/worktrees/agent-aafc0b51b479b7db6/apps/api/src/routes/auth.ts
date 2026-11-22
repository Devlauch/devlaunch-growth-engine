import { Router } from "express";
import { z } from "zod";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { withTransaction, withUserContext } from "../db/pool.js";
import { env } from "../config/env.js";
import { Errors } from "../lib/httpError.js";
import { requireAuth } from "../middleware/auth.js";

export const authRouter = Router();

const registerSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(8).max(200),
  fullName: z.string().trim().min(1).max(200).optional(),
});

const loginSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

function signAccessToken(userId: string, email: string): string {
  return jwt.sign({ sub: userId, email, type: "access" }, env.jwtAccessSecret, { expiresIn: env.jwtAccessTtl });
}

function signRefreshToken(userId: string): string {
  return jwt.sign({ sub: userId, type: "refresh" }, env.jwtRefreshSecret, { expiresIn: env.jwtRefreshTtl });
}

authRouter.post("/register", async (req, res, next) => {
  try {
    const body = registerSchema.parse(req.body);
    const passwordHash = await bcrypt.hash(body.password, 10);

    const user = await withTransaction(async (client) => {
      const existing = await client.query("SELECT id FROM users WHERE email = $1", [body.email]);
      if ((existing.rowCount ?? 0) > 0) {
        throw Errors.conflict("A user with this email already exists");
      }
      const inserted = await client.query(
        `INSERT INTO users (email, full_name, password_hash, status)
         VALUES ($1, $2, $3, 'active')
         RETURNING id, email, full_name, status, created_at`,
        [body.email, body.fullName ?? null, passwordHash],
      );
      return inserted.rows[0];
    });

    res.status(201).json({
      user: { id: user.id, email: user.email, fullName: user.full_name, status: user.status },
      accessToken: signAccessToken(user.id, user.email),
      refreshToken: signRefreshToken(user.id),
    });
  } catch (err) {
    next(err);
  }
});

authRouter.post("/login", async (req, res, next) => {
  try {
    const body = loginSchema.parse(req.body);

    const user = await withTransaction(async (client) => {
      const result = await client.query(
        "SELECT id, email, full_name, password_hash, status FROM users WHERE email = $1",
        [body.email],
      );
      return result.rows[0];
    });

    if (!user || !user.password_hash || user.status !== "active") {
      throw Errors.unauthorized("Invalid email or password");
    }

    const valid = await bcrypt.compare(body.password, user.password_hash);
    if (!valid) {
      throw Errors.unauthorized("Invalid email or password");
    }

    await withTransaction(async (client) => {
      await client.query("UPDATE users SET last_login_at = now() WHERE id = $1", [user.id]);
    });

    res.json({
      user: { id: user.id, email: user.email, fullName: user.full_name },
      accessToken: signAccessToken(user.id, user.email),
      refreshToken: signRefreshToken(user.id),
    });
  } catch (err) {
    next(err);
  }
});

authRouter.post("/refresh", async (req, res, next) => {
  try {
    const body = refreshSchema.parse(req.body);
    let payload: { sub: string; type: string };
    try {
      payload = jwt.verify(body.refreshToken, env.jwtRefreshSecret) as { sub: string; type: string };
    } catch {
      throw Errors.unauthorized("Invalid or expired refresh token");
    }
    if (payload.type !== "refresh") {
      throw Errors.unauthorized("Not a refresh token");
    }

    const user = await withTransaction(async (client) => {
      const result = await client.query("SELECT id, email, status FROM users WHERE id = $1", [payload.sub]);
      return result.rows[0];
    });
    if (!user || user.status !== "active") {
      throw Errors.unauthorized("User no longer active");
    }

    res.json({
      accessToken: signAccessToken(user.id, user.email),
      refreshToken: signRefreshToken(user.id),
    });
  } catch (err) {
    next(err);
  }
});

authRouter.get("/me", requireAuth, async (req, res, next) => {
  try {
    const user = await withTransaction(async (client) => {
      const result = await client.query(
        "SELECT id, email, full_name, status, created_at FROM users WHERE id = $1",
        [req.userId],
      );
      return result.rows[0];
    });

    if (!user) {
      // DEV ONLY auth path: an X-Dev-User-Id that doesn't correspond to a
      // real users row. Real JWT-authenticated users always exist.
      throw Errors.notFound("User not found");
    }

    const memberships = await withUserContext(req.userId as string, async (client) => {
      const result = await client.query(
        `SELECT m.tenant_id, m.role, m.status, t.slug, t.name
         FROM memberships m JOIN tenants t ON t.id = m.tenant_id
         WHERE m.user_id = $1`,
        [req.userId],
      );
      return result.rows;
    });

    res.json({
      user: { id: user.id, email: user.email, fullName: user.full_name, status: user.status },
      memberships: memberships.map((m) => ({
        tenantId: m.tenant_id,
        tenantSlug: m.slug,
        tenantName: m.name,
        role: m.role,
        status: m.status,
      })),
    });
  } catch (err) {
    next(err);
  }
});
