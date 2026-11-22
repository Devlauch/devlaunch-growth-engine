import { Router, type Request } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { Errors } from "../lib/httpError.js";
import { stripHtml } from "../lib/htmlText.js";
import {
  Crawl4AINotConfiguredError,
  Crawl4AIUnreachableError,
  fetchCompetitorPage,
} from "../lib/crawl4aiClient.js";
import { extractFaqSnippets } from "../lib/chatbotEngine.js";

/**
 * Mounted at
 * /api/v1/tenants/:tenantId/projects/:projectId/chatbot (app.ts is off
 * limits this round -- see the mount snippet in this feature's report).
 * Phase roadmap item 4, "Website AI Lead Capture Agent": authenticated CRUD
 * for the chatbot's config + client-managed knowledge base, the
 * "import from website" crawl action (always lands as pending_review --
 * see 271_create_chatbot_knowledge_sources.sql), the approve/reject
 * review step, and read-only conversation history for auditability.
 */
export const chatbotAdminRouter = Router({ mergeParams: true });
chatbotAdminRouter.use(requireAuth, requireTenantMembership);

function paramId(req: Request, name: string): string {
  return z.string().uuid().parse((req.params as Record<string, string>)[name]);
}

async function assertProjectInTenant(req: Request, projectId: string): Promise<void> {
  const r = await req.tenantDb!.query("SELECT 1 FROM projects WHERE id = $1 AND tenant_id = $2", [
    projectId,
    req.tenantId,
  ]);
  if (r.rowCount === 0) throw Errors.notFound("Project not found");
}

async function loadKnowledgeSourceOr404(req: Request, projectId: string, id: string) {
  const r = await req.tenantDb!.query(
    `SELECT * FROM chatbot_knowledge_sources WHERE id = $1 AND tenant_id = $2 AND project_id = $3`,
    [id, req.tenantId, projectId],
  );
  if (r.rowCount === 0) throw Errors.notFound("Knowledge source not found");
  return r.rows[0];
}

// ---------------------------------------------------------------------------
// Config (get-or-create one row per project)
// ---------------------------------------------------------------------------

const configSchema = z
  .object({
    enabled: z.boolean().optional(),
    welcomeMessage: z.string().trim().min(1).max(1000).optional(),
    fallbackMessage: z.string().trim().min(1).max(1000).optional(),
    consentNotice: z.string().trim().min(1).max(1000).optional(),
    qualifyingQuestions: z.array(z.string().trim().min(1).max(500)).max(3).optional(),
    exchangesBeforeQualifying: z.number().int().min(1).max(20).optional(),
    confidenceThreshold: z.number().min(0).max(1).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: "No fields to update" });

async function loadOrCreateConfig(req: Request, projectId: string) {
  const existing = await req.tenantDb!.query(
    `SELECT * FROM chatbot_configs WHERE tenant_id = $1 AND project_id = $2`,
    [req.tenantId, projectId],
  );
  if (existing.rowCount && existing.rowCount > 0) return existing.rows[0];

  const inserted = await req.tenantDb!.query(
    `INSERT INTO chatbot_configs (tenant_id, project_id) VALUES ($1, $2)
     ON CONFLICT (project_id) DO NOTHING
     RETURNING *`,
    [req.tenantId, projectId],
  );
  if (inserted.rowCount && inserted.rowCount > 0) return inserted.rows[0];

  // Lost a create race with a concurrent request -- re-select.
  const retry = await req.tenantDb!.query(
    `SELECT * FROM chatbot_configs WHERE tenant_id = $1 AND project_id = $2`,
    [req.tenantId, projectId],
  );
  return retry.rows[0];
}

/** GET /config */
chatbotAdminRouter.get("/config", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);
    const config = await loadOrCreateConfig(req, projectId);
    res.json({ config });
  } catch (err) {
    next(err);
  }
});

/** PATCH /config */
chatbotAdminRouter.patch("/config", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);
    await loadOrCreateConfig(req, projectId);
    const body = configSchema.parse(req.body);

    const fields: string[] = [];
    const values: unknown[] = [projectId, req.tenantId];
    function set(column: string, value: unknown) {
      values.push(value);
      fields.push(`${column} = $${values.length}`);
    }
    if (body.enabled !== undefined) set("enabled", body.enabled);
    if (body.welcomeMessage !== undefined) set("welcome_message", body.welcomeMessage);
    if (body.fallbackMessage !== undefined) set("fallback_message", body.fallbackMessage);
    if (body.consentNotice !== undefined) set("consent_notice", body.consentNotice);
    if (body.qualifyingQuestions !== undefined) set("qualifying_questions", body.qualifyingQuestions);
    if (body.exchangesBeforeQualifying !== undefined)
      set("exchanges_before_qualifying", body.exchangesBeforeQualifying);
    if (body.confidenceThreshold !== undefined) set("confidence_threshold", body.confidenceThreshold);

    const result = await req.tenantDb!.query(
      `UPDATE chatbot_configs SET ${fields.join(", ")} WHERE project_id = $1 AND tenant_id = $2 RETURNING *`,
      values,
    );
    res.json({ config: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Knowledge sources CRUD
// ---------------------------------------------------------------------------

const createKnowledgeSourceSchema = z.object({
  question: z.string().trim().min(1).max(500),
  answer: z.string().trim().min(1).max(5000),
  tags: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
});

const updateKnowledgeSourceSchema = z
  .object({
    question: z.string().trim().min(1).max(500).optional(),
    answer: z.string().trim().min(1).max(5000).optional(),
    tags: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: "No fields to update" });

/** GET / (optional ?status=pending_review|approved|rejected) */
chatbotAdminRouter.get("/knowledge-sources", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);
    const status =
      typeof req.query.status === "string"
        ? z.enum(["pending_review", "approved", "rejected"]).parse(req.query.status)
        : undefined;

    const result = await req.tenantDb!.query(
      `SELECT * FROM chatbot_knowledge_sources
       WHERE tenant_id = $1 AND project_id = $2 AND ($3::text IS NULL OR status = $3)
       ORDER BY created_at DESC`,
      [req.tenantId, projectId, status ?? null],
    );
    res.json({ knowledgeSources: result.rows });
  } catch (err) {
    next(err);
  }
});

/**
 * POST / -- a manual entry, typed in directly by the client/tenant in the
 * dashboard. Trusted immediately (status defaults to 'approved' at the DB
 * level) -- this is the client's own authored content, not scraped text;
 * see 271_create_chatbot_knowledge_sources.sql's doc comment for why that's
 * different from the website-import path below.
 */
chatbotAdminRouter.post("/knowledge-sources", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);
    const body = createKnowledgeSourceSchema.parse(req.body);

    const result = await req.tenantDb!.query(
      `INSERT INTO chatbot_knowledge_sources (tenant_id, project_id, question, answer, tags, origin, status, is_active)
       VALUES ($1, $2, $3, $4, $5, 'manual', 'approved', true)
       RETURNING *`,
      [req.tenantId, projectId, body.question, body.answer, body.tags ?? []],
    );
    res.status(201).json({ knowledgeSource: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

/** PATCH /:id */
chatbotAdminRouter.patch("/knowledge-sources/:id", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const id = paramId(req, "id");
    await assertProjectInTenant(req, projectId);
    await loadKnowledgeSourceOr404(req, projectId, id);
    const body = updateKnowledgeSourceSchema.parse(req.body);

    const fields: string[] = [];
    const values: unknown[] = [id];
    function set(column: string, value: unknown) {
      values.push(value);
      fields.push(`${column} = $${values.length}`);
    }
    if (body.question !== undefined) set("question", body.question);
    if (body.answer !== undefined) set("answer", body.answer);
    if (body.tags !== undefined) set("tags", body.tags);
    if (body.isActive !== undefined) set("is_active", body.isActive);

    const result = await req.tenantDb!.query(
      `UPDATE chatbot_knowledge_sources SET ${fields.join(", ")} WHERE id = $1 RETURNING *`,
      values,
    );
    res.json({ knowledgeSource: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

/** DELETE /:id */
chatbotAdminRouter.delete("/knowledge-sources/:id", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const id = paramId(req, "id");
    await assertProjectInTenant(req, projectId);
    await loadKnowledgeSourceOr404(req, projectId, id);

    await req.tenantDb!.query(`DELETE FROM chatbot_knowledge_sources WHERE id = $1`, [id]);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

/**
 * POST /:id/approve -- the ONLY way a website_import row can ever become
 * live (status='approved', is_active=true). Review required: rejects with
 * 409 if the row isn't actually pending_review (e.g. a manual entry, which
 * is already approved, or one already reviewed), so this can't be used to
 * silently "re-approve" something that was deliberately rejected.
 */
chatbotAdminRouter.post("/knowledge-sources/:id/approve", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const id = paramId(req, "id");
    await assertProjectInTenant(req, projectId);
    const source = await loadKnowledgeSourceOr404(req, projectId, id);
    if (source.status !== "pending_review") {
      throw Errors.conflict("Only a pending_review knowledge source can be approved");
    }

    const result = await req.tenantDb!.query(
      `UPDATE chatbot_knowledge_sources SET status = 'approved', is_active = true WHERE id = $1 RETURNING *`,
      [id],
    );
    res.json({ knowledgeSource: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

/** POST /:id/reject */
chatbotAdminRouter.post("/knowledge-sources/:id/reject", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const id = paramId(req, "id");
    await assertProjectInTenant(req, projectId);
    const source = await loadKnowledgeSourceOr404(req, projectId, id);
    if (source.status !== "pending_review") {
      throw Errors.conflict("Only a pending_review knowledge source can be rejected");
    }

    const result = await req.tenantDb!.query(
      `UPDATE chatbot_knowledge_sources SET status = 'rejected', is_active = false WHERE id = $1 RETURNING *`,
      [id],
    );
    res.json({ knowledgeSource: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Import from website -- crawl + heuristic extraction, always pending_review
// ---------------------------------------------------------------------------

const importSchema = z.object({
  urls: z.array(z.string().trim().url().max(2000)).min(1).max(5),
});

/**
 * POST /knowledge-sources/import
 *
 * Crawls each given URL directly (reusing the same Crawl4AI HTTP client as
 * the Competitor Intelligence Agent -- see ../lib/crawl4aiClient.ts's doc
 * comment on why apps/api has its own slim client rather than depending on
 * apps/worker), strips HTML, and runs chatbotEngine.ts's
 * extractFaqSnippets heuristic over the page text. EVERY resulting row is
 * inserted with origin='website_import', status='pending_review',
 * is_active=false -- never live until a human calls .../approve (see
 * above). Fails loudly (502) rather than fabricating snippets when
 * Crawl4AI is unreachable/unconfigured; a single URL 404ing/empty is
 * skipped, not a hard failure, same as competitors.ts's crawl endpoint.
 */
chatbotAdminRouter.post("/knowledge-sources/import", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);
    const body = importSchema.parse(req.body);

    const imported: unknown[] = [];
    for (const url of body.urls) {
      let html: string;
      try {
        const fetched = await fetchCompetitorPage(url);
        if (fetched.statusCode >= 400 || !fetched.html) continue;
        html = fetched.html;
      } catch (err) {
        if (err instanceof Crawl4AINotConfiguredError || err instanceof Crawl4AIUnreachableError) {
          throw Errors.badGateway(err.message);
        }
        throw err;
      }

      const text = stripHtml(html);
      const snippets = extractFaqSnippets(text);
      for (const snippet of snippets) {
        const result = await req.tenantDb!.query(
          `INSERT INTO chatbot_knowledge_sources
             (tenant_id, project_id, question, answer, tags, origin, status, source_url, is_active)
           VALUES ($1, $2, $3, $4, '{}', 'website_import', 'pending_review', $5, false)
           RETURNING *`,
          [req.tenantId, projectId, snippet.question, snippet.answer, url],
        );
        imported.push(result.rows[0]);
      }
    }

    res.status(201).json({ imported, importedCount: imported.length });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Conversations (read-only, for auditability)
// ---------------------------------------------------------------------------

/** GET /conversations */
chatbotAdminRouter.get("/conversations", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);
    const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 200);

    const result = await req.tenantDb!.query(
      `SELECT * FROM chatbot_conversations WHERE tenant_id = $1 AND project_id = $2
       ORDER BY started_at DESC LIMIT $3`,
      [req.tenantId, projectId, limit],
    );
    res.json({ conversations: result.rows });
  } catch (err) {
    next(err);
  }
});

/** GET /conversations/:id/messages */
chatbotAdminRouter.get("/conversations/:id/messages", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const conversationId = paramId(req, "id");
    await assertProjectInTenant(req, projectId);

    const conversation = await req.tenantDb!.query(
      `SELECT * FROM chatbot_conversations WHERE id = $1 AND tenant_id = $2 AND project_id = $3`,
      [conversationId, req.tenantId, projectId],
    );
    if (conversation.rowCount === 0) throw Errors.notFound("Conversation not found");

    const messages = await req.tenantDb!.query(
      `SELECT * FROM chatbot_messages WHERE conversation_id = $1 AND tenant_id = $2 ORDER BY created_at ASC`,
      [conversationId, req.tenantId],
    );
    res.json({ conversation: conversation.rows[0], messages: messages.rows });
  } catch (err) {
    next(err);
  }
});
