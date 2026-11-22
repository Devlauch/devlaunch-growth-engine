import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { Errors } from "../lib/httpError.js";

/**
 * Mounted at /api/v1/tenants/:tenantId/projects/:projectId/analytics
 *
 * Adapts the written spec's `GET /api/v1/analytics/overview` to this
 * codebase's tenant/project-scoped route convention (see
 * docs/API_DEVIATIONS.md for why every route here carries :tenantId —
 * requireTenantMembership is the single place that decides "does this
 * request get to act as this tenant", and it needs :tenantId in the path
 * to run before anything else does).
 *
 * Every number returned here is a real SQL aggregate against existing
 * tables (leads, campaigns, agent_executions) for this tenant+project —
 * nothing is fabricated or estimated. An empty category comes back as an
 * empty array/zero count; the dashboard renders the existing EmptyState
 * for that, never a placeholder chart.
 */
export const analyticsRouter = Router({ mergeParams: true });
analyticsRouter.use(requireAuth, requireTenantMembership);

async function loadProjectOr404(tenantDb: import("pg").PoolClient, tenantId: string, projectId: string) {
  const project = await tenantDb.query("SELECT 1 FROM projects WHERE id = $1 AND tenant_id = $2", [
    projectId,
    tenantId,
  ]);
  if (project.rowCount === 0) throw Errors.notFound("Project not found");
}

/** GET /api/v1/tenants/:tenantId/projects/:projectId/analytics/overview */
analyticsRouter.get("/overview", async (req, res, next) => {
  try {
    const projectId = z.string().uuid().parse((req.params as Record<string, string>).projectId);
    await loadProjectOr404(req.tenantDb!, req.tenantId!, projectId);

    const [leadsTotal, leadsByStatus, campaignsByStatus, executionsByStatus, leadsPerDay] = await Promise.all([
      req.tenantDb!.query(`SELECT count(*)::int AS count FROM leads WHERE tenant_id = $1 AND project_id = $2`, [
        req.tenantId,
        projectId,
      ]),
      req.tenantDb!.query(
        `SELECT status, count(*)::int AS count
         FROM leads
         WHERE tenant_id = $1 AND project_id = $2
         GROUP BY status
         ORDER BY status`,
        [req.tenantId, projectId],
      ),
      req.tenantDb!.query(
        `SELECT status, count(*)::int AS count
         FROM campaigns
         WHERE tenant_id = $1 AND project_id = $2
         GROUP BY status
         ORDER BY status`,
        [req.tenantId, projectId],
      ),
      req.tenantDb!.query(
        `SELECT ae.status, count(*)::int AS count
         FROM agent_executions ae
         JOIN agent_instances ai ON ai.id = ae.agent_instance_id
         WHERE ae.tenant_id = $1 AND ai.project_id = $2
         GROUP BY ae.status
         ORDER BY ae.status`,
        [req.tenantId, projectId],
      ),
      req.tenantDb!.query(
        `SELECT date_trunc('day', created_at)::date AS day, count(*)::int AS count
         FROM leads
         WHERE tenant_id = $1 AND project_id = $2 AND created_at >= now() - interval '30 days'
         GROUP BY day
         ORDER BY day`,
        [req.tenantId, projectId],
      ),
    ]);

    res.json({
      leads: {
        total: leadsTotal.rows[0]?.count ?? 0,
        byStatus: leadsByStatus.rows,
        perDay: leadsPerDay.rows,
      },
      campaigns: {
        byStatus: campaignsByStatus.rows,
      },
      agentExecutions: {
        byStatus: executionsByStatus.rows,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * ---------------------------------------------------------------------
 * GET /api/v1/tenants/:tenantId/projects/:projectId/analytics/funnel
 * ---------------------------------------------------------------------
 * Roadmap item 16's extension: "Track the funnel: discovered, qualified,
 * contacted, replied, demo, won. Break it down by source, segment, message
 * variant and channel." Additive only — does not touch /overview above or
 * its response shape, so the existing AnalyticsPage.tsx dashboard consumer
 * is unaffected.
 *
 * This endpoint queries several tables owned by OTHER, parallel roadmap
 * items (discovered_organizations, lead_scores, message_drafts,
 * message_draft_variants, lead_replies, sequence_enrollments) that may not
 * have landed their migration yet in every environment. Every query
 * against one of those tables runs inside its own SAVEPOINT
 * (see `runOptional` below): if the table is missing, Postgres raises
 * `42P01` (undefined_table), which is caught, the savepoint is rolled
 * back (so the rest of this request's shared transaction — see
 * requireTenantMembership — is NOT poisoned by an aborted-transaction
 * error), and that one stage/breakdown honestly reports a zero/empty
 * result with a `note` explaining why, instead of a 500 or fabricated
 * data. `leads` and `campaigns` are this app's oldest tables and are never
 * treated as optional.
 *
 * Documented choices (stages that don't map 1:1 onto an existing column):
 *   - qualified: a lead counts as qualified if EITHER leads.status =
 *     'qualified' OR it has a lead_scores row with total_score >= 50
 *     (QUALIFIED_SCORE_THRESHOLD below) — i.e. a human marked it
 *     qualified, or the scoring agent did. Counted as a single union (not
 *     summed) so a lead matching both is not double-counted.
 *   - demo: there is no lead-level "demo booked" status anywhere in the
 *     schema (leads.status and campaigns.status were both checked — see
 *     their CHECK constraints in 015_create_leads.sql /
 *     020_create_campaigns.sql). The closest REAL signal is
 *     sequence_enrollments.status = 'stopped_meeting_booked' (a sequence
 *     enrollment that stopped specifically because a meeting got booked —
 *     see 048_create_sequence_enrollments.sql). Reported as a clearly
 *     labeled proxy, not as "demo" taken at face value.
 *   - won: nothing in the current schema represents a deal/lead "won"
 *     state. Rather than invent one, this reports `{count: 0, note: ...}`
 *     honestly.
 *   - segment: no column anywhere links a lead (or discovered_organization)
 *     to icp_profiles (the only table with a `segment` column) — there is
 *     no foreign key to join on. Reported as an empty breakdown with a
 *     note rather than fabricating a join.
 *   - message variant / channel: message_draft_variants has no separate
 *     "variant label" column beyond `channel` (email/whatsapp/call_script/
 *     linkedin_note) — so "by message variant" and "by channel" are the
 *     same real breakdown here, grouped by that column.
 */
const QUALIFIED_SCORE_THRESHOLD = 50;
const UNDEFINED_TABLE_ERROR_CODE = "42P01";
let funnelSavepointCounter = 0;

interface OptionalQueryResult<T> {
  rows: T[];
  degraded: boolean;
  note?: string;
}

/**
 * Runs `sql` against a table that may not exist yet in this environment,
 * inside its own SAVEPOINT so a missing-table error degrades only this one
 * stage/breakdown rather than aborting the whole shared request
 * transaction. Queries must be run sequentially (not via Promise.all) when
 * using this helper, since SAVEPOINT/RELEASE must be issued in order on
 * the one shared tenant-scoped client.
 */
async function runOptional<T>(
  tenantDb: import("pg").PoolClient,
  sql: string,
  params: unknown[],
  tableLabel: string,
): Promise<OptionalQueryResult<T>> {
  const savepoint = `funnel_sp_${funnelSavepointCounter++}`;
  await tenantDb.query(`SAVEPOINT ${savepoint}`);
  try {
    const result = await tenantDb.query(sql, params);
    await tenantDb.query(`RELEASE SAVEPOINT ${savepoint}`);
    return { rows: result.rows as T[], degraded: false };
  } catch (err) {
    const code = (err as { code?: string } | undefined)?.code;
    if (code === UNDEFINED_TABLE_ERROR_CODE) {
      await tenantDb.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      await tenantDb.query(`RELEASE SAVEPOINT ${savepoint}`);
      return {
        rows: [],
        degraded: true,
        note: `${tableLabel} table does not exist yet in this environment — reporting an honest zero/empty result instead of fabricating data.`,
      };
    }
    throw err;
  }
}

function firstCount(result: OptionalQueryResult<{ count: number }>): number {
  return result.rows[0]?.count ?? 0;
}

/** GET /api/v1/tenants/:tenantId/projects/:projectId/analytics/funnel */
analyticsRouter.get("/funnel", async (req, res, next) => {
  try {
    const projectId = z.string().uuid().parse((req.params as Record<string, string>).projectId);
    const tenantDb = req.tenantDb!;
    const tenantId = req.tenantId!;
    await loadProjectOr404(tenantDb, tenantId, projectId);

    // --- discovered: two real, separately-labeled counts, never conflated ---
    const discoveredOrganizations = await runOptional<{ count: number }>(
      tenantDb,
      `SELECT count(*)::int AS count FROM discovered_organizations WHERE tenant_id = $1 AND project_id = $2`,
      [tenantId, projectId],
      "discovered_organizations",
    );
    const leadsTotal = await tenantDb.query(`SELECT count(*)::int AS count FROM leads WHERE tenant_id = $1 AND project_id = $2`, [
      tenantId,
      projectId,
    ]);

    // --- qualified: union of leads.status = 'qualified' OR lead_scores.total_score >= threshold ---
    const qualifiedCombined = await runOptional<{ count: number }>(
      tenantDb,
      `SELECT count(*)::int AS count
       FROM leads l
       WHERE l.tenant_id = $1 AND l.project_id = $2
         AND (
           l.status = 'qualified'
           OR EXISTS (
             SELECT 1 FROM lead_scores ls
             WHERE ls.lead_id = l.id AND ls.total_score >= ${QUALIFIED_SCORE_THRESHOLD}
           )
         )`,
      [tenantId, projectId],
      "lead_scores",
    );
    let qualifiedCount: number;
    let qualifiedNote: string | undefined;
    if (qualifiedCombined.degraded) {
      // lead_scores isn't there yet — fall back to the half of the union
      // that IS always real: leads.status alone.
      const statusOnly = await tenantDb.query(
        `SELECT count(*)::int AS count FROM leads WHERE tenant_id = $1 AND project_id = $2 AND status = 'qualified'`,
        [tenantId, projectId],
      );
      qualifiedCount = statusOnly.rows[0]?.count ?? 0;
      qualifiedNote = qualifiedCombined.note;
    } else {
      qualifiedCount = firstCount(qualifiedCombined);
    }

    // --- contacted: distinct leads with an approved message draft ---
    const contacted = await runOptional<{ count: number }>(
      tenantDb,
      `SELECT count(DISTINCT lead_id)::int AS count
       FROM message_drafts
       WHERE tenant_id = $1 AND project_id = $2 AND status = 'approved'`,
      [tenantId, projectId],
      "message_drafts",
    );

    // --- replied: distinct leads with any logged reply ---
    const replied = await runOptional<{ count: number }>(
      tenantDb,
      `SELECT count(DISTINCT lead_id)::int AS count FROM lead_replies WHERE tenant_id = $1 AND project_id = $2`,
      [tenantId, projectId],
      "lead_replies",
    );

    // --- demo: real proxy signal, clearly labeled (see doc comment above) ---
    const demo = await runOptional<{ count: number }>(
      tenantDb,
      `SELECT count(DISTINCT se.lead_id)::int AS count
       FROM sequence_enrollments se
       JOIN sequences s ON s.id = se.sequence_id
       WHERE se.tenant_id = $1 AND s.project_id = $2 AND se.status = 'stopped_meeting_booked'`,
      [tenantId, projectId],
      "sequence_enrollments",
    );

    // --- breakdowns ---
    const bySource = await tenantDb.query(
      `SELECT source, count(*)::int AS count
       FROM leads
       WHERE tenant_id = $1 AND project_id = $2
       GROUP BY source
       ORDER BY source`,
      [tenantId, projectId],
    );

    const byChannel = await runOptional<{ channel: string; count: number }>(
      tenantDb,
      `SELECT mdv.channel, count(DISTINCT mdv.message_draft_id)::int AS count
       FROM message_draft_variants mdv
       JOIN message_drafts md ON md.id = mdv.message_draft_id
       WHERE md.tenant_id = $1 AND md.project_id = $2
       GROUP BY mdv.channel
       ORDER BY mdv.channel`,
      [tenantId, projectId],
      "message_draft_variants",
    );

    res.json({
      funnel: {
        discovered: {
          discoveredOrganizations: {
            count: firstCount(discoveredOrganizations),
            ...(discoveredOrganizations.degraded ? { note: discoveredOrganizations.note } : {}),
          },
          leads: { count: leadsTotal.rows[0]?.count ?? 0 },
        },
        qualified: {
          count: qualifiedCount,
          threshold: `leads.status = 'qualified' OR lead_scores.total_score >= ${QUALIFIED_SCORE_THRESHOLD}`,
          ...(qualifiedNote ? { note: qualifiedNote } : {}),
        },
        contacted: {
          count: firstCount(contacted),
          ...(contacted.degraded ? { note: contacted.note } : {}),
        },
        replied: {
          count: firstCount(replied),
          ...(replied.degraded ? { note: replied.note } : {}),
        },
        demo: {
          count: firstCount(demo),
          note: "proxy: sequence_enrollments.status = 'stopped_meeting_booked' (no lead-level 'demo booked' status exists in the schema yet)",
          ...(demo.degraded ? { degradedNote: demo.note } : {}),
        },
        won: {
          count: 0,
          note: "no 'won' lead status exists in the schema yet (leads.status: new/qualified/rejected/approved_for_outreach/archived; campaigns.status: draft/pending_approval/approved/rejected/archived)",
        },
      },
      breakdowns: {
        bySource: bySource.rows,
        bySegment: {
          breakdown: [],
          note: "no column links leads (or discovered_organizations) to icp_profiles/segment in the current schema, so this cannot be broken down without fabricating a join",
        },
        byChannel: {
          breakdown: byChannel.rows,
          ...(byChannel.degraded ? { note: byChannel.note } : {}),
        },
        byMessageVariant: {
          breakdown: byChannel.rows,
          note: "message_draft_variants has no separate variant-label column beyond channel, so this is the same real breakdown as byChannel",
          ...(byChannel.degraded ? { degradedNote: byChannel.note } : {}),
        },
      },
    });
  } catch (err) {
    next(err);
  }
});
