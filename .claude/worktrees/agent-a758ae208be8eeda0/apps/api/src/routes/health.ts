import { Router } from "express";
import { pool } from "../db/pool.js";

export const healthRouter = Router();

/** GET /api/v1/health — no auth required. */
healthRouter.get("/", async (_req, res) => {
  let dbOk = true;
  try {
    await pool.query("SELECT 1");
  } catch {
    dbOk = false;
  }
  res.status(dbOk ? 200 : 503).json({
    status: dbOk ? "ok" : "degraded",
    checks: { database: dbOk ? "ok" : "unreachable" },
    timestamp: new Date().toISOString(),
  });
});
