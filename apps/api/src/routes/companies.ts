import { Router, type Request } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { Errors } from "../lib/httpError.js";

/**
 * Mounted at /api/v1/tenants/:tenantId/projects/:projectId/companies
 *
 * CRM module: `companies` (packages/db/migrations/302_create_companies.sql)
 * is the first-class company entity this schema was missing — until now a
 * "company" was only a free-text string on `leads` (leads.company,
 * 015_create_leads.sql). Tenant/project-scoped and real RLS-protected
 * (302_enable_rls_companies.sql), same shape/conventions as
 * apps/api/src/routes/deals.ts.
 */
export const companiesRouter = Router({ mergeParams: true });
companiesRouter.use(requireAuth, requireTenantMembership);

const COMPANY_COLUMNS = `id, tenant_id, project_id, name, domain, industry, size_range, notes, created_by, created_at, updated_at`;

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

async function loadCompanyOr404(req: Request, projectId: string, companyId: string) {
  const r = await req.tenantDb!.query(
    `SELECT ${COMPANY_COLUMNS} FROM companies WHERE id = $1 AND tenant_id = $2 AND project_id = $3`,
    [companyId, req.tenantId, projectId],
  );
  if (r.rowCount === 0) throw Errors.notFound("Company not found");
  return r.rows[0];
}

const createCompanySchema = z.object({
  name: z.string().min(1).max(500),
  domain: z.string().max(255).optional(),
  industry: z.string().max(255).optional(),
  sizeRange: z.string().max(50).optional(),
  notes: z.string().max(10_000).optional(),
});

/** POST /companies */
companiesRouter.post("/", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);
    const body = createCompanySchema.parse(req.body);

    const result = await req.tenantDb!.query(
      `INSERT INTO companies (tenant_id, project_id, name, domain, industry, size_range, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${COMPANY_COLUMNS}`,
      [
        req.tenantId,
        projectId,
        body.name,
        body.domain ?? null,
        body.industry ?? null,
        body.sizeRange ?? null,
        body.notes ?? null,
        req.userId,
      ],
    );
    const company = result.rows[0];

    await req.tenantDb!.query(
      `INSERT INTO audit_events (tenant_id, actor_type, actor_user_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'user', $2, 'company.created', 'company', $3, $4::jsonb)`,
      [req.tenantId, req.userId, company.id, JSON.stringify({ name: body.name })],
    );

    res.status(201).json({ company });
  } catch (err) {
    next(err);
  }
});

/** GET /companies — filterable by a loose name search */
companiesRouter.get("/", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);

    const search = typeof req.query.search === "string" ? req.query.search : undefined;

    const result = await req.tenantDb!.query(
      `SELECT ${COMPANY_COLUMNS} FROM companies
       WHERE tenant_id = $1 AND project_id = $2
         AND ($3::text IS NULL OR name ILIKE '%' || $3 || '%')
       ORDER BY name ASC
       LIMIT 200`,
      [req.tenantId, projectId, search ?? null],
    );
    res.json({ companies: result.rows });
  } catch (err) {
    next(err);
  }
});

/** GET /companies/:id */
companiesRouter.get("/:id", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const companyId = paramId(req, "id");
    await assertProjectInTenant(req, projectId);
    const company = await loadCompanyOr404(req, projectId, companyId);
    res.json({ company });
  } catch (err) {
    next(err);
  }
});

const updateCompanySchema = z.object({
  name: z.string().min(1).max(500).optional(),
  domain: z.string().max(255).nullish(),
  industry: z.string().max(255).nullish(),
  sizeRange: z.string().max(50).nullish(),
  notes: z.string().max(10_000).nullish(),
});

/** PATCH /companies/:id */
companiesRouter.patch("/:id", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const companyId = paramId(req, "id");
    await assertProjectInTenant(req, projectId);
    await loadCompanyOr404(req, projectId, companyId);
    const body = updateCompanySchema.parse(req.body);

    if (Object.keys(body).length === 0) {
      throw Errors.badRequest("At least one field is required");
    }

    const result = await req.tenantDb!.query(
      `UPDATE companies
       SET name = COALESCE($3, name),
           domain = CASE WHEN $4::boolean THEN $5 ELSE domain END,
           industry = CASE WHEN $6::boolean THEN $7 ELSE industry END,
           size_range = CASE WHEN $8::boolean THEN $9 ELSE size_range END,
           notes = CASE WHEN $10::boolean THEN $11 ELSE notes END
       WHERE id = $1 AND tenant_id = $2
       RETURNING ${COMPANY_COLUMNS}`,
      [
        companyId,
        req.tenantId,
        body.name ?? null,
        "domain" in body,
        body.domain ?? null,
        "industry" in body,
        body.industry ?? null,
        "sizeRange" in body,
        body.sizeRange ?? null,
        "notes" in body,
        body.notes ?? null,
      ],
    );
    const company = result.rows[0];

    await req.tenantDb!.query(
      `INSERT INTO audit_events (tenant_id, actor_type, actor_user_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'user', $2, 'company.updated', 'company', $3, $4::jsonb)`,
      [req.tenantId, req.userId, companyId, JSON.stringify(body)],
    );

    res.json({ company });
  } catch (err) {
    next(err);
  }
});

/** DELETE /companies/:id */
companiesRouter.delete("/:id", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const companyId = paramId(req, "id");
    await assertProjectInTenant(req, projectId);
    await loadCompanyOr404(req, projectId, companyId);

    await req.tenantDb!.query(`DELETE FROM companies WHERE id = $1 AND tenant_id = $2`, [companyId, req.tenantId]);

    await req.tenantDb!.query(
      `INSERT INTO audit_events (tenant_id, actor_type, actor_user_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'user', $2, 'company.deleted', 'company', $3, '{}'::jsonb)`,
      [req.tenantId, req.userId, companyId],
    );

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});
