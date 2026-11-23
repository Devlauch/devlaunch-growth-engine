import { createHash } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { Errors } from "../lib/httpError.js";
import { rateLimitMiddleware } from "../middleware/rateLimit.js";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { ingestLead } from "../lib/leadIngestion.js";
import {
  matchKnowledge,
  detectsEnquiryIntent,
  parseYesNo,
  extractContact,
  type KnowledgeSourceCandidate,
} from "../lib/chatbotEngine.js";

/**
 * Mounted at /api/v1/public (app.ts is off limits this round -- see the
 * mount snippet in this feature's report). Phase roadmap item 4, "Website
 * AI Lead Capture Agent": the public, unauthenticated-by-design endpoints
 * the embeddable chatbot widget (packages/embed-widget/chatbot.js) talks
 * to. Same trust model as src/routes/publicLeads.ts: a project's own
 * public_api_key in the URL + an Origin allowlist check against that
 * project's allowed_origins, plus the same per-IP/per-key rate limiters.
 *
 * Every bot reply is produced by chatbotEngine.ts's deterministic matching
 * (never a fabricated answer -- see that module's doc comment), and the
 * only way a visitor's contact info is ever captured is through the
 * explicit consent -> qualifying -> contact-capture flow below, which
 * ultimately writes through the EXISTING leadIngestion.ts path (same one
 * publicLeads.ts uses) and the EXISTING consent_records table (same insert
 * shape as src/routes/compliance.ts's consentRecordsRouter) -- no parallel
 * lead or consent schema.
 */
export const publicChatbotRouter = Router();

function hashIp(ip: string): string {
  return createHash("sha256").update(ip).digest("hex").slice(0, 32);
}

// Reuses the existing public-widget rate limit config (env.ts) rather than
// adding new env vars for a second public surface with the exact same
// abuse profile (one widget, one project public key, per visitor browser).
const perIpLimiter = rateLimitMiddleware({
  windowMs: 60_000,
  max: env.publicLeadsRateLimitPerIpPerMin,
  name: "public-chatbot-ip",
  keyFn: (req) => hashIp(req.ip ?? "unknown"),
});
const perKeyLimiter = rateLimitMiddleware({
  windowMs: 60_000,
  max: env.publicLeadsRateLimitPerKeyPerMin,
  name: "public-chatbot-key",
  keyFn: (req) => req.params.projectPublicKey,
});

const publicKeyParamSchema = z.string().trim().min(8).max(200);

interface ResolvedProject {
  id: string;
  tenantId: string;
}

/**
 * Shared resolve step for both endpoints below: looks up the project by its
 * public_api_key (via the same app.lookup_public_api_key RLS policy
 * publicLeads.ts uses -- see 019_public_project_lookup_rls.sql), checks the
 * Origin allowlist, and switches the transaction into that project's tenant
 * context. On any failure, rolls back and releases the client itself and
 * returns null -- the caller must stop (it has already called next(err)).
 */
async function resolveProjectOrFail(
  client: import("pg").PoolClient,
  projectPublicKey: string,
  origin: string | null,
  next: (err: unknown) => void,
): Promise<ResolvedProject | null> {
  await client.query("SELECT set_config('app.lookup_public_api_key', $1, true)", [projectPublicKey]);

  const projectResult = await client.query(
    `SELECT id, tenant_id, allowed_origins FROM projects WHERE public_api_key = $1`,
    [projectPublicKey],
  );

  if (projectResult.rowCount === 0) {
    await client.query("ROLLBACK");
    client.release();
    logger.warn({ projectPublicKey }, "public chatbot request rejected: unknown project public key");
    next(Errors.notFound("Unknown project key"));
    return null;
  }

  const project = projectResult.rows[0];
  const allowedOrigins: string[] = project.allowed_origins ?? [];
  if (allowedOrigins.length === 0 || !origin || !allowedOrigins.includes(origin)) {
    await client.query("ROLLBACK");
    client.release();
    logger.warn({ projectPublicKey, origin }, "public chatbot request rejected: origin not allowlisted");
    next(Errors.forbidden("Origin not allowed for this project"));
    return null;
  }

  await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [project.tenant_id]);
  return { id: project.id, tenantId: project.tenant_id };
}

async function loadEnabledConfigOrFail(
  client: import("pg").PoolClient,
  project: ResolvedProject,
  next: (err: unknown) => void,
): Promise<Record<string, unknown> | null> {
  const configResult = await client.query(
    `SELECT * FROM chatbot_configs WHERE tenant_id = $1 AND project_id = $2`,
    [project.tenantId, project.id],
  );
  if (configResult.rowCount === 0 || !configResult.rows[0].enabled) {
    await client.query("ROLLBACK");
    client.release();
    next(Errors.notFound("Chatbot is not enabled for this project"));
    return null;
  }
  return configResult.rows[0];
}

async function insertBotMessage(
  client: import("pg").PoolClient,
  params: {
    tenantId: string;
    conversationId: string;
    content: string;
    matchedKnowledgeSourceId?: string | null;
    confidence?: number | null;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO chatbot_messages (tenant_id, conversation_id, role, content, matched_knowledge_source_id, confidence_score)
     VALUES ($1, $2, 'bot', $3, $4, $5)`,
    [
      params.tenantId,
      params.conversationId,
      params.content,
      params.matchedKnowledgeSourceId ?? null,
      params.confidence ?? null,
    ],
  );
}

// ---------------------------------------------------------------------------
// POST /projects/:projectPublicKey/chatbot/sessions -- start a conversation
// ---------------------------------------------------------------------------

publicChatbotRouter.post(
  "/projects/:projectPublicKey/chatbot/sessions",
  perIpLimiter,
  perKeyLimiter,
  async (req, res, next) => {
    const client = await pool.connect();
    let settled = false;
    try {
      const projectPublicKey = publicKeyParamSchema.parse(req.params.projectPublicKey);
      const origin = req.header("origin") ?? null;

      await client.query("BEGIN");
      const project = await resolveProjectOrFail(client, projectPublicKey, origin, (err) => {
        settled = true;
        next(err);
      });
      if (!project) return;

      const config = await loadEnabledConfigOrFail(client, project, (err) => {
        settled = true;
        next(err);
      });
      if (!config) return;

      const conversationResult = await client.query(
        `INSERT INTO chatbot_conversations (tenant_id, project_id, status, origin)
         VALUES ($1, $2, 'active', $3)
         RETURNING id, status, started_at`,
        [project.tenantId, project.id, origin],
      );
      const conversation = conversationResult.rows[0];

      await insertBotMessage(client, {
        tenantId: project.tenantId,
        conversationId: conversation.id,
        content: config.welcome_message as string,
      });

      await client.query("COMMIT");
      settled = true;
      client.release();

      res.status(201).json({
        conversationId: conversation.id,
        message: config.welcome_message,
      });
    } catch (err) {
      if (!settled) {
        await client.query("ROLLBACK").catch(() => undefined);
        client.release();
      }
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /projects/:projectPublicKey/chatbot/sessions/:conversationId/messages
// ---------------------------------------------------------------------------

publicChatbotRouter.get(
  "/projects/:projectPublicKey/chatbot/sessions/:conversationId/messages",
  perIpLimiter,
  perKeyLimiter,
  async (req, res, next) => {
    const client = await pool.connect();
    let settled = false;
    try {
      const projectPublicKey = publicKeyParamSchema.parse(req.params.projectPublicKey);
      const conversationId = z.string().uuid().parse(req.params.conversationId);
      const origin = req.header("origin") ?? null;

      await client.query("BEGIN");
      const project = await resolveProjectOrFail(client, projectPublicKey, origin, (err) => {
        settled = true;
        next(err);
      });
      if (!project) return;

      const conversationResult = await client.query(
        `SELECT id FROM chatbot_conversations WHERE id = $1 AND tenant_id = $2 AND project_id = $3`,
        [conversationId, project.tenantId, project.id],
      );
      if (conversationResult.rowCount === 0) {
        await client.query("ROLLBACK");
        settled = true;
        client.release();
        next(Errors.notFound("Conversation not found"));
        return;
      }

      const messages = await client.query(
        `SELECT role, content, created_at FROM chatbot_messages
         WHERE conversation_id = $1 AND tenant_id = $2 ORDER BY created_at ASC`,
        [conversationId, project.tenantId],
      );

      await client.query("COMMIT");
      settled = true;
      client.release();

      res.json({ messages: messages.rows });
    } catch (err) {
      if (!settled) {
        await client.query("ROLLBACK").catch(() => undefined);
        client.release();
      }
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /projects/:projectPublicKey/chatbot/sessions/:conversationId/messages
// -- the real conversation-flow state machine
// ---------------------------------------------------------------------------

const sendMessageSchema = z.object({
  message: z.string().trim().min(1).max(2000),
});

const CONTACT_CAPTURE_PROMPT = "Great -- what's the best name and email to reach you at so our team can follow up?";
const CONTACT_CAPTURE_RETRY_PROMPT =
  "I didn't catch an email there -- could you share at least your email address so we can follow up?";
const CONSENT_RETRY_PREFIX = "Sorry, I didn't quite catch that -- ";
const DECLINE_MESSAGE = "No problem -- I won't ask for any details. Feel free to keep browsing or ask me anything else!";

publicChatbotRouter.post(
  "/projects/:projectPublicKey/chatbot/sessions/:conversationId/messages",
  perIpLimiter,
  perKeyLimiter,
  async (req, res, next) => {
    const client = await pool.connect();
    let settled = false;
    try {
      const projectPublicKey = publicKeyParamSchema.parse(req.params.projectPublicKey);
      const conversationId = z.string().uuid().parse(req.params.conversationId);
      const origin = req.header("origin") ?? null;
      const body = sendMessageSchema.parse(req.body);

      await client.query("BEGIN");
      const project = await resolveProjectOrFail(client, projectPublicKey, origin, (err) => {
        settled = true;
        next(err);
      });
      if (!project) return;

      const config = await loadEnabledConfigOrFail(client, project, (err) => {
        settled = true;
        next(err);
      });
      if (!config) return;

      const conversationResult = await client.query(
        `SELECT * FROM chatbot_conversations WHERE id = $1 AND tenant_id = $2 AND project_id = $3`,
        [conversationId, project.tenantId, project.id],
      );
      if (conversationResult.rowCount === 0) {
        await client.query("ROLLBACK");
        settled = true;
        client.release();
        next(Errors.notFound("Conversation not found"));
        return;
      }
      const conversation = conversationResult.rows[0];

      // Log the visitor's message first, unconditionally, for auditability
      // -- even a message sent to an already-ended/captured conversation.
      await client.query(
        `INSERT INTO chatbot_messages (tenant_id, conversation_id, role, content) VALUES ($1, $2, 'visitor', $3)`,
        [project.tenantId, conversationId, body.message],
      );

      if (conversation.status === "captured" || conversation.status === "ended") {
        const closingMessage =
          conversation.status === "captured"
            ? "This conversation has already been completed -- thanks again! Start a new chat if you have another question."
            : "This conversation has ended. Start a new chat if you'd like to ask something else.";
        await insertBotMessage(client, {
          tenantId: project.tenantId,
          conversationId,
          content: closingMessage,
        });
        await client.query(
          `UPDATE chatbot_conversations SET last_message_at = now() WHERE id = $1`,
          [conversationId],
        );
        await client.query("COMMIT");
        settled = true;
        client.release();
        res.json({ message: closingMessage, status: conversation.status });
        return;
      }

      const qualifyingQuestions: string[] = (config.qualifying_questions as string[]) ?? [];
      let botReply = "";
      let matchedSourceId: string | null = null;
      let confidence: number | null = null;
      let newStatus: string = conversation.status;
      let newConsentGiven = conversation.consent_given;
      let newQualifyingIndex: number = conversation.qualifying_question_index;
      let newQualifyingAnswers: string[] = Array.isArray(conversation.qualifying_answers)
        ? [...conversation.qualifying_answers]
        : [];
      let leadId: string | null = null;
      let consentRecordId: string | null = null;
      const newVisitorExchangeCount = conversation.visitor_exchange_count + 1;

      if (conversation.status === "active") {
        const shouldQualify =
          detectsEnquiryIntent(body.message) ||
          newVisitorExchangeCount >= Number(config.exchanges_before_qualifying);

        if (shouldQualify) {
          newStatus = "awaiting_consent";
          botReply = config.consent_notice as string;
        } else {
          const knowledgeResult = await client.query<KnowledgeSourceCandidate & { tenant_id: string }>(
            `SELECT id, question, answer, tags FROM chatbot_knowledge_sources
             WHERE tenant_id = $1 AND project_id = $2 AND status = 'approved' AND is_active = true`,
            [project.tenantId, project.id],
          );
          const match = matchKnowledge(
            body.message,
            knowledgeResult.rows,
            Number(config.confidence_threshold),
          );
          if (match) {
            botReply = match.answer;
            matchedSourceId = match.sourceId;
            confidence = match.confidence;
          } else {
            botReply = config.fallback_message as string;
          }
        }
      } else if (conversation.status === "awaiting_consent") {
        const consent = parseYesNo(body.message);
        if (consent === true) {
          newConsentGiven = true;
          if (qualifyingQuestions.length > 0) {
            newStatus = "qualifying";
            newQualifyingIndex = 0;
            botReply = qualifyingQuestions[0];
          } else {
            newStatus = "awaiting_contact";
            botReply = CONTACT_CAPTURE_PROMPT;
          }
        } else if (consent === false) {
          newStatus = "ended";
          newConsentGiven = false;
          botReply = DECLINE_MESSAGE;
        } else {
          botReply = CONSENT_RETRY_PREFIX + (config.consent_notice as string);
        }
      } else if (conversation.status === "qualifying") {
        newQualifyingAnswers.push(body.message);
        const nextIndex = conversation.qualifying_question_index + 1;
        if (nextIndex < qualifyingQuestions.length) {
          newQualifyingIndex = nextIndex;
          botReply = qualifyingQuestions[nextIndex];
        } else {
          newStatus = "awaiting_contact";
          botReply = CONTACT_CAPTURE_PROMPT;
        }
      } else if (conversation.status === "awaiting_contact") {
        const contact = extractContact(body.message);
        if (!contact.email && !contact.name) {
          botReply = CONTACT_CAPTURE_RETRY_PROMPT;
        } else {
          // Real consent record, reusing the EXISTING consent_records
          // table/insert shape from src/routes/compliance.ts's
          // consentRecordsRouter -- never a parallel consent table.
          const consentResult = await client.query(
            `INSERT INTO consent_records (tenant_id, email, channel, consent_given, consent_source)
             VALUES ($1, $2, 'email', true, 'public_widget_submission')
             RETURNING id`,
            [project.tenantId, contact.email ?? null],
          );
          consentRecordId = consentResult.rows[0].id;

          // Real lead capture through the EXISTING, single lead-ingestion
          // path (src/lib/leadIngestion.ts) -- the same one
          // publicLeads.ts uses. The first configured qualifying
          // question's answer reuses leads.qualifying_answer (the SAME
          // field the inbound lead-capture widget already writes), and the
          // full Q&A transcript (if more than one qualifying question was
          // configured) is kept in customFields for auditability, not a
          // parallel schema.
          const lead = await ingestLead({
            client,
            tenantId: project.tenantId,
            projectId: project.id,
            input: {
              name: contact.name ?? undefined,
              email: contact.email ?? undefined,
              message: body.message,
              qualifyingAnswer: newQualifyingAnswers[0] ?? undefined,
              customFields:
                qualifyingQuestions.length > 0
                  ? {
                      chatbotQualifyingAnswers: qualifyingQuestions.map((q, idx) => ({
                        question: q,
                        answer: newQualifyingAnswers[idx] ?? null,
                      })),
                    }
                  : undefined,
            },
            source: "public_widget",
            origin,
            ipHash: hashIp(req.ip ?? "unknown"),
          });
          leadId = lead.id;

          newStatus = "captured";
          botReply = `Thanks${contact.name ? ` ${contact.name}` : ""}! We've got your details and our team will follow up soon.`;
        }
      }

      await insertBotMessage(client, {
        tenantId: project.tenantId,
        conversationId,
        content: botReply,
        matchedKnowledgeSourceId: matchedSourceId,
        confidence,
      });

      await client.query(
        `UPDATE chatbot_conversations
         SET status = $2,
             consent_given = $3,
             consent_record_id = COALESCE($4, consent_record_id),
             lead_id = COALESCE($5, lead_id),
             qualifying_question_index = $6,
             qualifying_answers = $7::jsonb,
             visitor_exchange_count = $8,
             last_message_at = now()
         WHERE id = $1`,
        [
          conversationId,
          newStatus,
          newConsentGiven,
          consentRecordId,
          leadId,
          newQualifyingIndex,
          JSON.stringify(newQualifyingAnswers),
          newVisitorExchangeCount,
        ],
      );

      await client.query("COMMIT");
      settled = true;
      client.release();

      res.json({
        message: botReply,
        status: newStatus,
        matchedKnowledgeSourceId: matchedSourceId,
        confidence,
      });
    } catch (err) {
      if (!settled) {
        await client.query("ROLLBACK").catch(() => undefined);
        client.release();
      }
      next(err);
    }
  },
);
