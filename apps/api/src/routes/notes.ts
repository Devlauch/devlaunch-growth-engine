import { Router, type Request } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { Errors } from "../lib/httpError.js";

/**
 * Mounted at /api/v1/tenants/:tenantId/projects/:projectId/notes
 *
 * CRM module "Notes": freeform notes attachable to a lead/deal/company/
 * contact (packages/db/migrations/310_create_notes.sql). A note must be
 * attached to at least one real entity (enforced by notes_has_target at
 * the DB layer) — this router re-checks that every referenced id actually
 * belongs to this tenant/project before inserting, same pattern as
 * deals.ts's assertLeadInProject.
 *
 * companies/contacts existence checks are best-effort: those tables are
 * being built by a separate, concurrently-running effort and their FK
 * constraints land in a later, separate migration
 * (316_add_notes_company_contact_fk.sql). If the `companies`/`contacts`
 * tables don't exist yet in a given environment, this router still lets a
 * companyId/contactId through unchecked rather than hard-failing on a
 * missing table — the DB-level FK (once migrated) is the real guarantee.
 */
export const notesRouter = Router({ mergeParams: true });
notesRouter.use(requireAuth, requireTenantMembership);

const NOTE_COLUMNS = `id, tenant_id, project_id, lead_id, deal_id, company_id, contact_id, body, created_by, created_at, updated_at`;

function paramId(req: Request, name: string): string {
  return z.string().uuid().parse((req.params as Record<string, string>)[name]);
}

async function assertProjectInTenant(req: Request, projectId: string) {
  const r = await req.tenantDb!.query("SELECT 1 FROM projects WHERE id = $1 AND tenant_id = $2", [
    projectId,
    req.tenantId,
  ]);
  if (r.rowCount === 0) throw Errors.notFound("Project not found");
}

async function assertLeadInProject(req: Request, projectId: string, leadId: string) {
  const r = await req.tenantDb!.query("SELECT 1 FROM leads WHERE id = $1 AND tenant_id = $2 AND project_id = $3", [
    leadId,
    req.tenantId,
    projectId,
  ]);
  if (r.rowCount === 0) throw Errors.notFound("Lead not found");
}

async function assertDealInProject(req: Request, projectId: string, dealId: string) {
  const r = await req.tenantDb!.query("SELECT 1 FROM deals WHERE id = $1 AND tenant_id = $2 AND project_id = $3", [
    dealId,
    req.tenantId,
    projectId,
  ]);
  if (r.rowCount === 0) throw Errors.notFound("Deal not found");
}

/**
 * Best-effort existence check for companies/contacts — see this file's
 * header comment on why these never hard-fail on a missing table (the
 * table may genuinely not exist yet in this environment; the real
 * guarantee is the FK added in 316_add_notes_company_contact_fk.sql once
 * it has landed).
 */
async function assertOptionalEntityInProject(
  req: Request,
  table: "companies" | "contacts",
  projectId: string,
  id: string,
): Promise<void> {
  try {
    const r = await req.tenantDb!.query(
      `SELECT 1 FROM ${table} WHERE id = $1 AND tenant_id = $2 AND project_id = $3`,
      [id, req.tenantId, projectId],
    );
    if (r.rowCount === 0) throw Errors.notFound(`${table === "companies" ? "Company" : "Contact"} not found`);
  } catch (err) {
    if (err instanceof Error && "code" in err && (err as { code?: string }).code === "42P01") {
      // undefined_table: companies/contacts not migrated in yet in this
      // environment — don't block note creation on a concurrently-built
      // table that isn't here yet.
      return;
    }
    throw err;
  }
}

async function loadNoteOr404(req: Request, projectId: string, noteId: string) {
  const r = await req.tenantDb!.query(`SELECT ${NOTE_COLUMNS} FROM notes WHERE id = $1 AND tenant_id = $2 AND project_id = $3`, [
    noteId,
    req.tenantId,
    projectId,
  ]);
  if (r.rowCount === 0) throw Errors.notFound("Note not found");
  return r.rows[0];
}

const createNoteSchema = z
  .object({
    leadId: z.string().uuid().optional(),
    dealId: z.string().uuid().optional(),
    companyId: z.string().uuid().optional(),
    contactId: z.string().uuid().optional(),
    body: z.string().trim().min(1).max(10_000),
  })
  .refine((v) => v.leadId || v.dealId || v.companyId || v.contactId, {
    message: "At least one of leadId, dealId, companyId, contactId is required",
  });

/** POST /notes */
notesRouter.post("/", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);
    const body = createNoteSchema.parse(req.body);

    if (body.leadId) await assertLeadInProject(req, projectId, body.leadId);
    if (body.dealId) await assertDealInProject(req, projectId, body.dealId);
    if (body.companyId) await assertOptionalEntityInProject(req, "companies", projectId, body.companyId);
    if (body.contactId) await assertOptionalEntityInProject(req, "contacts", projectId, body.contactId);

    const result = await req.tenantDb!.query(
      `INSERT INTO notes (tenant_id, project_id, lead_id, deal_id, company_id, contact_id, body, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${NOTE_COLUMNS}`,
      [
        req.tenantId,
        projectId,
        body.leadId ?? null,
        body.dealId ?? null,
        body.companyId ?? null,
        body.contactId ?? null,
        body.body,
        req.userId,
      ],
    );
    const note = result.rows[0];

    await req.tenantDb!.query(
      `INSERT INTO audit_events (tenant_id, actor_type, actor_user_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'user', $2, 'note.created', 'note', $3, $4::jsonb)`,
      [
        req.tenantId,
        req.userId,
        note.id,
        JSON.stringify({ leadId: body.leadId, dealId: body.dealId, companyId: body.companyId, contactId: body.contactId }),
      ],
    );

    res.status(201).json({ note });
  } catch (err) {
    next(err);
  }
});

/** GET /notes — filterable by leadId/dealId/companyId/contactId */
notesRouter.get("/", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);

    const leadId = typeof req.query.leadId === "string" ? req.query.leadId : undefined;
    if (leadId) z.string().uuid().parse(leadId);
    const dealId = typeof req.query.dealId === "string" ? req.query.dealId : undefined;
    if (dealId) z.string().uuid().parse(dealId);
    const companyId = typeof req.query.companyId === "string" ? req.query.companyId : undefined;
    if (companyId) z.string().uuid().parse(companyId);
    const contactId = typeof req.query.contactId === "string" ? req.query.contactId : undefined;
    if (contactId) z.string().uuid().parse(contactId);

    const result = await req.tenantDb!.query(
      `SELECT ${NOTE_COLUMNS} FROM notes
       WHERE tenant_id = $1 AND project_id = $2
         AND ($3::uuid IS NULL OR lead_id = $3)
         AND ($4::uuid IS NULL OR deal_id = $4)
         AND ($5::uuid IS NULL OR company_id = $5)
         AND ($6::uuid IS NULL OR contact_id = $6)
       ORDER BY created_at DESC
       LIMIT 200`,
      [req.tenantId, projectId, leadId ?? null, dealId ?? null, companyId ?? null, contactId ?? null],
    );
    res.json({ notes: result.rows });
  } catch (err) {
    next(err);
  }
});

/** GET /notes/:id */
notesRouter.get("/:id", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const noteId = paramId(req, "id");
    await assertProjectInTenant(req, projectId);
    const note = await loadNoteOr404(req, projectId, noteId);
    res.json({ note });
  } catch (err) {
    next(err);
  }
});

const updateNoteSchema = z.object({
  body: z.string().trim().min(1).max(10_000),
});

/** PATCH /notes/:id — edit the note body */
notesRouter.patch("/:id", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const noteId = paramId(req, "id");
    await assertProjectInTenant(req, projectId);
    await loadNoteOr404(req, projectId, noteId);
    const body = updateNoteSchema.parse(req.body);

    const result = await req.tenantDb!.query(
      `UPDATE notes SET body = $3 WHERE id = $1 AND tenant_id = $2 RETURNING ${NOTE_COLUMNS}`,
      [noteId, req.tenantId, body.body],
    );
    res.json({ note: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

/** DELETE /notes/:id */
notesRouter.delete("/:id", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const noteId = paramId(req, "id");
    await assertProjectInTenant(req, projectId);
    await loadNoteOr404(req, projectId, noteId);

    await req.tenantDb!.query("DELETE FROM notes WHERE id = $1 AND tenant_id = $2", [noteId, req.tenantId]);

    await req.tenantDb!.query(
      `INSERT INTO audit_events (tenant_id, actor_type, actor_user_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'user', $2, 'note.deleted', 'note', $3, '{}'::jsonb)`,
      [req.tenantId, req.userId, noteId],
    );

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});
