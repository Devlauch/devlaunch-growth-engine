import { Router } from "express";
import { withTransaction } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";

export const agentTemplatesRouter = Router();
agentTemplatesRouter.use(requireAuth);

/**
 * GET /api/v1/agent-templates — global catalog, not tenant-scoped by path.
 * No app.current_tenant_id is set here, so the agent_templates RLS policy
 * (tenant_id IS NULL OR tenant_id = current_setting(...)) naturally
 * resolves to "tenant_id IS NULL only" — i.e. only the global/system
 * catalog is visible, never another tenant's private customizations.
 */
agentTemplatesRouter.get("/", async (_req, res, next) => {
  try {
    const rows = await withTransaction(async (client) => {
      const result = await client.query(
        `SELECT id, key, name, description, category, version, default_config, is_active, created_at
         FROM agent_templates WHERE is_active = true ORDER BY key ASC, version DESC`,
      );
      return result.rows;
    });
    res.json({ agentTemplates: rows });
  } catch (err) {
    next(err);
  }
});
