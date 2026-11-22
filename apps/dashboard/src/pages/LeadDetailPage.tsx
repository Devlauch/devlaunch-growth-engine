import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Layout } from "../components/Layout";
import { EmptyState } from "../components/EmptyState";
import { ErrorBanner } from "../components/ErrorBanner";
import { StatCard, StatGrid } from "../components/StatCard";
import { Badge, sourceBadgeTone, sourceLabel, statusTone } from "../components/Badge";
import { IconTarget, IconUsers } from "../components/Icons";
import { ActivityTimeline } from "../components/ActivityTimeline";
import { WorkflowStepper } from "../components/WorkflowStepper";
import { NotesPanel } from "../components/NotesPanel";
import { useLeadActivity } from "../hooks/useLeadActivity";
import { api, ApiError } from "../api/client";
import type { Lead, Project } from "../api/types";

// Single-lead detail view: the natural home for the already-built
// ActivityTimeline / NotesPanel components (apps/dashboard/src/components),
// neither of which had a page to render in before this change. Every
// section here is a direct read from a real endpoint — nothing fabricated:
//  - lead core fields: GET .../leads/:leadId (apps/api/src/routes/leads.ts)
//  - linked deals: GET .../deals?leadId=  (apps/api/src/routes/deals.ts,
//    which supports a `leadId` filter already)
//  - current assignment: GET .../deals/assignments/:leadId
//  - activity timeline / notes: handled entirely by the embedded
//    components' own hooks (useLeadActivity / useNotes)
//
// Same Layout/EmptyState/ErrorBanner/StatCard/api conventions as
// SalesPipelinePage.tsx and CompaniesPage.tsx.

interface Deal {
  id: string;
  lead_id: string;
  stage: "new" | "contacted" | "qualified" | "proposal" | "won" | "lost";
  value_amount: string | null;
  expected_close_date: string | null;
  owner_user_id: string | null;
  stage_changed_at: string;
  created_at: string;
}

interface Assignment {
  id: string;
  lead_id: string;
  assigned_user_id: string;
  assigned_by: string;
  assigned_at: string;
}

interface Membership {
  id: string;
  user_id: string;
  role: string;
  status: string;
  email: string;
  full_name: string | null;
}

const STAGE_LABELS: Record<Deal["stage"], string> = {
  new: "New",
  contacted: "Contacted",
  qualified: "Qualified",
  proposal: "Proposal",
  won: "Won",
  lost: "Lost",
};

export function LeadDetailPage() {
  const { tenantId, projectId, leadId } = useParams<{ tenantId: string; projectId: string; leadId: string }>();

  const [project, setProject] = useState<Project | null>(null);
  const [lead, setLead] = useState<Lead | null>(null);
  const [deals, setDeals] = useState<Deal[] | null>(null);
  const [assignment, setAssignment] = useState<Assignment | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Backs the WorkflowStepper's "Scored Lead" step only — a second,
  // independent fetch of the same GET .../activity endpoint the embedded
  // <ActivityTimeline /> already calls via its own useLeadActivity() call.
  // Not refactored into a single shared fetch: ActivityTimeline is
  // documented as deliberately self-contained (fetches its own data), and
  // this page has no other real signal for "has this lead been scored"
  // short of adding a whole new API surface for one boolean, which the
  // existing GET .../activity endpoint already answers.
  const { activity } = useLeadActivity(tenantId, projectId, leadId);

  const [members, setMembers] = useState<Membership[] | null>(null);
  const [membersError, setMembersError] = useState<string | null>(null);
  const [selectedAssignee, setSelectedAssignee] = useState("");
  const [assigning, setAssigning] = useState(false);
  const [assignError, setAssignError] = useState<string | null>(null);

  const [promoting, setPromoting] = useState(false);
  const [promoteError, setPromoteError] = useState<string | null>(null);
  const [promoteResult, setPromoteResult] = useState<{
    company: { id: string; name: string } | null;
    companyCreated: boolean;
    contact: { id: string; name: string };
    contactCreated: boolean;
    assignmentCreated: boolean;
  } | null>(null);

  const load = useCallback(async () => {
    if (!tenantId || !projectId || !leadId) return;
    try {
      const [projectRes, leadRes, dealsRes, assignmentRes] = await Promise.all([
        api.get<{ project: Project }>(`/tenants/${tenantId}/projects/${projectId}`),
        api.get<{ lead: Lead }>(`/tenants/${tenantId}/projects/${projectId}/leads/${leadId}`),
        api.get<{ deals: Deal[] }>(`/tenants/${tenantId}/projects/${projectId}/deals?leadId=${leadId}`),
        api.get<{ assignment: Assignment | null }>(
          `/tenants/${tenantId}/projects/${projectId}/deals/assignments/${leadId}`,
        ),
      ]);
      setProject(projectRes.project);
      setLead(leadRes.lead);
      setDeals(dealsRes.deals);
      setAssignment(assignmentRes.assignment);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Could not load this lead.");
    }
  }, [tenantId, projectId, leadId]);

  useEffect(() => {
    load();
  }, [load]);

  const loadMembers = useCallback(async () => {
    if (!tenantId) return;
    try {
      const res = await api.get<{ memberships: Membership[] }>(`/tenants/${tenantId}/memberships`);
      setMembers(res.memberships.filter((m) => m.status === "active"));
    } catch (err) {
      setMembersError(err instanceof ApiError ? err.message : "Could not load team members to assign this lead to.");
    }
  }, [tenantId]);

  useEffect(() => {
    loadMembers();
  }, [loadMembers]);

  const handleAssign = useCallback(async () => {
    if (!tenantId || !projectId || !leadId || !selectedAssignee) return;
    setAssigning(true);
    setAssignError(null);
    try {
      await api.post<{ assignment: Assignment }>(`/tenants/${tenantId}/projects/${projectId}/deals/assignments`, {
        leadId,
        assignedUserId: selectedAssignee,
      });
      await load();
    } catch (err) {
      setAssignError(err instanceof ApiError ? err.message : "Could not assign this lead.");
    } finally {
      setAssigning(false);
    }
  }, [tenantId, projectId, leadId, selectedAssignee, load]);

  const handlePromote = useCallback(
    async (autoAssign: boolean) => {
      if (!tenantId || !projectId || !leadId) return;
      setPromoting(true);
      setPromoteError(null);
      try {
        const res = await api.post<{
          promotion: {
            company: { id: string; name: string } | null;
            companyCreated: boolean;
            contact: { id: string; name: string };
            contactCreated: boolean;
            assignmentCreated: boolean;
          };
        }>(`/tenants/${tenantId}/projects/${projectId}/leads/${leadId}/promote-to-crm`, { autoAssign });
        setPromoteResult(res.promotion);
        await load();
      } catch (err) {
        setPromoteError(
          err instanceof ApiError ? err.message : "Could not promote this lead to a CRM record.",
        );
      } finally {
        setPromoting(false);
      }
    },
    [tenantId, projectId, leadId, load],
  );

  const assignedMember = members?.find((m) => m.user_id === assignment?.assigned_user_id) ?? null;
  const openDealsCount = deals?.filter((d) => d.stage !== "won" && d.stage !== "lost").length ?? 0;
  const wonDealsCount = deals?.filter((d) => d.stage === "won").length ?? 0;

  // WorkflowStepper inputs — every one a real, independently-checked signal
  // (see WorkflowStepper.tsx's header comment), not a cascade.
  const hasScore = activity?.some((item) => item.type === "lead_scored") ?? false;
  const latestDeal = deals && deals.length > 0 ? deals[deals.length - 1] : null;

  return (
    <Layout
      crumbs={[
        { label: "Organizations", to: "/" },
        { label: "Organization", to: `/tenants/${tenantId}` },
        { label: project?.name ?? "...", to: `/tenants/${tenantId}/projects/${projectId}` },
        { label: "Leads", to: `/tenants/${tenantId}/projects/${projectId}/priority-queue` },
        { label: lead?.name ?? lead?.email ?? "Lead" },
      ]}
      projectName={project?.name}
    >
      <ErrorBanner message={loadError} />

      {lead === null ? (
        <section className="panel">
          <p className="muted">Loading...</p>
        </section>
      ) : (
        <>
          <section className="panel">
            <h1>{lead.name ?? lead.email ?? "Unnamed lead"}</h1>
            <div className="form-row" style={{ flexWrap: "wrap", gap: "4px 24px" }}>
              <span>
                <strong>Email:</strong> {lead.email ?? "—"}
              </span>
              <span>
                <strong>Company:</strong> {lead.company ?? "—"}
              </span>
              <span>
                <strong>Status:</strong> <Badge tone={statusTone(lead.status)}>{lead.status.replace(/_/g, " ")}</Badge>
              </span>
              <span>
                <strong>Source:</strong> <Badge tone={sourceBadgeTone(lead.source)}>{sourceLabel(lead.source)}</Badge>
              </span>
              <span>
                <strong>Created:</strong> {new Date(lead.created_at).toLocaleString()}
              </span>
            </div>
            {lead.message ? (
              <p className="muted" style={{ marginTop: 8 }}>
                "{lead.message}"
              </p>
            ) : null}
          </section>

          <section className="panel">
            <h2>Workflow</h2>
            <WorkflowStepper
              qualified={lead.status === "qualified"}
              hasScore={hasScore}
              hasAssignment={assignment !== null}
              hasDeal={Boolean(deals && deals.length > 0)}
              dealStage={latestDeal ? STAGE_LABELS[latestDeal.stage] : null}
              isCustomer={wonDealsCount > 0}
            />
          </section>

          <StatGrid>
            <StatCard icon={<IconTarget />} label="Open deals" value={openDealsCount} />
            <StatCard icon={<IconTarget />} label="Won deals" value={wonDealsCount} />
            <StatCard
              icon={<IconUsers />}
              label="Assigned to"
              value={assignedMember ? assignedMember.full_name ?? assignedMember.email : "Unassigned"}
            />
          </StatGrid>

          <section className="panel">
            <h2>Promote to CRM</h2>
            <p className="muted">
              Links this lead to a real, first-class <code>companies</code>/<code>contacts</code> record (reusing an
              existing match if one exists) — the one explicit action that turns a discovered or captured lead into a
              record the rest of the CRM can work with. Requires the lead to have crossed its qualification threshold
              (status "qualified" or a lead score ≥ 50); a tenant member can still promote early.
            </p>
            <div className="form-row">
              <button type="button" onClick={() => handlePromote(false)} disabled={promoting}>
                {promoting ? "Promoting..." : "Promote to CRM"}
              </button>
              <button type="button" onClick={() => handlePromote(true)} disabled={promoting}>
                {promoting ? "Promoting..." : "Promote + auto-assign"}
              </button>
            </div>
            <ErrorBanner message={promoteError} />
            {promoteResult ? (
              <p className="muted">
                {promoteResult.company
                  ? `Linked to company "${promoteResult.company.name}"${promoteResult.companyCreated ? " (newly created)" : ""}. `
                  : ""}
                Contact "{promoteResult.contact.name}"{promoteResult.contactCreated ? " created" : " already existed"}.
                {promoteResult.assignmentCreated ? " Auto-assigned." : ""}
              </p>
            ) : null}
          </section>

          <section className="panel">
            <h2>Assignment</h2>
            <ErrorBanner message={membersError} />
            <p className="muted">
              {assignedMember
                ? `Currently assigned to ${assignedMember.full_name ?? assignedMember.email}.`
                : "This lead is not assigned to anyone yet."}
            </p>
            <div className="form-row">
              <select value={selectedAssignee} onChange={(e) => setSelectedAssignee(e.target.value)} disabled={members === null}>
                <option value="">Select a team member...</option>
                {members?.map((m) => (
                  <option key={m.user_id} value={m.user_id}>
                    {m.full_name ?? m.email}
                  </option>
                ))}
              </select>
              <button type="button" onClick={handleAssign} disabled={assigning || !selectedAssignee}>
                {assigning ? "Assigning..." : "Assign"}
              </button>
            </div>
            <ErrorBanner message={assignError} />
          </section>

          <section className="panel">
            <h2>Deals</h2>
            {deals === null ? (
              <p className="muted">Loading...</p>
            ) : deals.length === 0 ? (
              <EmptyState title="No deals yet" hint="Create a deal from this lead on the Sales Pipeline page to start tracking it." />
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Stage</th>
                    <th>Value</th>
                    <th>Expected close</th>
                    <th>Stage changed</th>
                  </tr>
                </thead>
                <tbody>
                  {deals.map((d) => (
                    <tr key={d.id}>
                      <td>{STAGE_LABELS[d.stage]}</td>
                      <td>{d.value_amount ?? "—"}</td>
                      <td>{d.expected_close_date ?? "—"}</td>
                      <td>{new Date(d.stage_changed_at).toLocaleDateString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <ActivityTimeline tenantId={tenantId} projectId={projectId} leadId={leadId} />
          <NotesPanel tenantId={tenantId} projectId={projectId} target={{ leadId }} />
        </>
      )}
    </Layout>
  );
}
