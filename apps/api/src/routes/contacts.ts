import { Router, type Request } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { Errors } from "../lib/httpError.js";

/**
 * Mounted at /api/v1/tenants/:tenantId/projects/:projectId/contacts
 *
 * CRM module: `contacts` (packages/db/migrations/307_create_contacts.sql)
 * is a real person at a company — distinct from `leads` (an inbound/
 * discovery-sourced row, see 015_create_leads.sql), and distinct from
 * `companies` (packages/db/migrations/302_create_companies.sql), which a
 * contact can optionally belong to via company_id. Tenant/project-scoped
 * and real RLS-protected (306_enable_rls_contacts.sql), same shape/
 * conventions as apps/api/src/routes/deals.ts and companies.ts.
 */
export const contactsRouter = Router({ mergeParams: true });
contactsRouter.use(requireAuth, requireTenantMembership);

const CONTACT_COLUMNS = `id, tenant_id, project_id, company_id, lead_id, name, email, phone, title, created_by, created_at, updated_at`;

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

async function assertCompanyInProject(req: Request, projectId: string, companyId: string) {
  const r = await req.tenantDb!.query("SELECT 1 FROM companies WHERE id = $1 AND tenant_id = $2 AND project_id = $3", [
    companyId,
    req.tenantId,
    projectId,
  ]);
  if (r.rowCount === 0) throw Errors.notFound("Company not found");
}

async function assertLeadInProject(req: Request, projectId: string, leadId: string) {
  const r = await req.tenantDb!.query("SELECT 1 FROM leads WHERE id = $1 AND tenant_id = $2 AND project_id = $3", [
    leadId,
    req.tenantId,
    projectId,
  ]);
  if (r.rowCount === 0) throw Errors.notFound("Lead not found");
}

async function loadContactOr404(req: Request, projectId: string, contactId: string) {
  const r = await req.tenantDb!.query(
    `SELECT ${CONTACT_COLUMNS} FROM contacts WHERE id = $1 AND tenant_id = $2 AND project_id = $3`,
    [contactId, req.tenantId, projectId],
  );
  if (r.rowCount === 0) throw Errors.notFound("Contact not found");
  return r.rows[0];
}

const createContactSchema = z.object({
  name: z.string().min(1).max(500),
  companyId: z.string().uuid().optional(),
  leadId: z.string().uuid().optional(),
  email: z.string().email().max(320).optional(),
  phone: z.string().max(50).optional(),
  title: z.string().max(255).optional(),
});

/** POST /contacts */
contactsRouter.post("/", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);
    const body = createContactSchema.parse(req.body);
    if (body.companyId) await assertCompanyInProject(req, projectId, body.companyId);
    if (body.leadId) await assertLeadInProject(req, projectId, body.leadId);

    const result = await req.tenantDb!.query(
      `INSERT INTO contacts (tenant_id, project_id, company_id, lead_id, name, email, phone, title, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING ${CONTACT_COLUMNS}`,
      [
        req.tenantId,
        projectId,
        body.companyId ?? null,
        body.leadId ?? null,
        body.name,
        body.email ?? null,
        body.phone ?? null,
        body.title ?? null,
        req.userId,
      ],
    );
    const contact = result.rows[0];

    await req.tenantDb!.query(
      `INSERT INTO audit_events (tenant_id, actor_type, actor_user_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'user', $2, 'contact.created', 'contact', $3, $4::jsonb)`,
      [req.tenantId, req.userId, contact.id, JSON.stringify({ name: body.name, companyId: body.companyId ?? null })],
    );

    res.status(201).json({ contact });
  } catch (err) {
    next(err);
  }
});

/** GET /contacts — filterable by companyId */
contactsRouter.get("/", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);

    const companyId = typeof req.query.companyId === "string" ? req.query.companyId : undefined;
    if (companyId) z.string().uuid().parse(companyId);

    const result = await req.tenantDb!.query(
      `SELECT ${CONTACT_COLUMNS} FROM contacts
       WHERE tenant_id = $1 AND project_id = $2
         AND ($3::uuid IS NULL OR company_id = $3)
       ORDER BY created_at DESC
       LIMIT 200`,
      [req.tenantId, projectId, companyId ?? null],
    );
    res.json({ contacts: result.rows });
  } catch (err) {
    next(err);
  }
});

/** GET /contacts/:id */
contactsRouter.get("/:id", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const contactId = paramId(req, "id");
    await assertProjectInTenant(req, projectId);
    const contact = await loadContactOr404(req, projectId, contactId);
    res.json({ contact });
  } catch (err) {
    next(err);
  }
});

const updateContactSchema = z.object({
  name: z.string().min(1).max(500).optional(),
  companyId: z.string().uuid().nullish(),
  leadId: z.string().uuid().nullish(),
  email: z.string().email().max(320).nullish(),
  phone: z.string().max(50).nullish(),
  title: z.string().max(255).nullish(),
});

/** PATCH /contacts/:id */
contactsRouter.patch("/:id", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const contactId = paramId(req, "id");
    await assertProjectInTenant(req, projectId);
    await loadContactOr404(req, projectId, contactId);
    const body = updateContactSchema.parse(req.body);

    if (Object.keys(body).length === 0) {
      throw Errors.badRequest("At least one field is required");
    }
    if (body.companyId) await assertCompanyInProject(req, projectId, body.companyId);
    if (body.leadId) await assertLeadInProject(req, projectId, body.leadId);

    const result = await req.tenantDb!.query(
      `UPDATE contacts
       SET name = COALESCE($3, name),
           company_id = CASE WHEN $4::boolean THEN $5 ELSE company_id END,
           lead_id = CASE WHEN $6::boolean THEN $7 ELSE lead_id END,
           email = CASE WHEN $8::boolean THEN $9 ELSE email END,
           phone = CASE WHEN $10::boolean THEN $11 ELSE phone END,
           title = CASE WHEN $12::boolean THEN $13 ELSE title END
       WHERE id = $1 AND tenant_id = $2
       RETURNING ${CONTACT_COLUMNS}`,
      [
        contactId,
        req.tenantId,
        body.name ?? null,
        "companyId" in body,
        body.companyId ?? null,
        "leadId" in body,
        body.leadId ?? null,
        "email" in body,
        body.email ?? null,
        "phone" in body,
        body.phone ?? null,
        "title" in body,
        body.title ?? null,
      ],
    );
    const contact = result.rows[0];

    await req.tenantDb!.query(
      `INSERT INTO audit_events (tenant_id, actor_type, actor_user_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'user', $2, 'contact.updated', 'contact', $3, $4::jsonb)`,
      [req.tenantId, req.userId, contactId, JSON.stringify(body)],
    );

    res.json({ contact });
  } catch (err) {
    next(err);
  }
});

/** DELETE /contacts/:id */
contactsRouter.delete("/:id", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const contactId = paramId(req, "id");
    await assertProjectInTenant(req, projectId);
    await loadContactOr404(req, projectId, contactId);

    await req.tenantDb!.query(`DELETE FROM contacts WHERE id = $1 AND tenant_id = $2`, [contactId, req.tenantId]);

    await req.tenantDb!.query(
      `INSERT INTO audit_events (tenant_id, actor_type, actor_user_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'user', $2, 'contact.deleted', 'contact', $3, '{}'::jsonb)`,
      [req.tenantId, req.userId, contactId],
    );

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});
