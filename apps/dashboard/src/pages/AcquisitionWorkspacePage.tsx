import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Layout } from "../components/Layout";
import { EmptyState } from "../components/EmptyState";
import { ErrorBanner } from "../components/ErrorBanner";
import { StatCard, StatGrid } from "../components/StatCard";
import { IconCompass, IconTarget, IconUsers, IconZap } from "../components/Icons";
import { api, ApiError } from "../api/client";
import type {
  AcquisitionCost,
  CacResult,
  DemoRequest,
  GrowthAuditRequest,
  Project,
  TrialSignup,
  TrialSignupStatus,
} from "../api/types";

/**
 * DevLaunch's own internal customer-acquisition workspace (NOT a client
 * tenant page — reachable only for the internal tenant/project, see
 * apps/api/src/routes/internalGrowth.ts's assertInternalTenant guard).
 * Every number here is a real row: growth-audit/demo-request submissions
 * came from real public form submissions (routes/publicGrowth.ts), trial
 * statuses are changed by a real staff member clicking the buttons below,
 * and CAC is real spend ÷ real converted-trial count for the chosen period
 * — "insufficient data" (never a guessed number or a silent 0) when no
 * trial converted in that window.
 */
const STATUS_TRANSITIONS: Record<TrialSignupStatus, TrialSignupStatus[]> = {
  trial_started: ["trial_active", "converted", "churned"],
  trial_active: ["converted", "churned"],
  converted: [],
  churned: [],
};

function centsToDollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function AcquisitionWorkspacePage() {
  const { tenantId, projectId } = useParams<{ tenantId: string; projectId: string }>();
  const base = `/tenants/${tenantId}/projects/${projectId}/internal-growth`;

  const [project, setProject] = useState<Project | null>(null);
  const [auditRequests, setAuditRequests] = useState<GrowthAuditRequest[] | null>(null);
  const [demoRequests, setDemoRequests] = useState<DemoRequest[] | null>(null);
  const [trials, setTrials] = useState<TrialSignup[] | null>(null);
  const [costs, setCosts] = useState<AcquisitionCost[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [trialUpdateError, setTrialUpdateError] = useState<string | null>(null);
  const [updatingTrialId, setUpdatingTrialId] = useState<string | null>(null);

  const [costChannel, setCostChannel] = useState("");
  const [costStart, setCostStart] = useState("");
  const [costEnd, setCostEnd] = useState("");
  const [costAmount, setCostAmount] = useState("");
  const [costError, setCostError] = useState<string | null>(null);
  const [savingCost, setSavingCost] = useState(false);

  const [cacStart, setCacStart] = useState("");
  const [cacEnd, setCacEnd] = useState("");
  const [cacResult, setCacResult] = useState<CacResult | null>(null);
  const [cacError, setCacError] = useState<string | null>(null);
  const [cacLoading, setCacLoading] = useState(false);

  const load = useCallback(async () => {
    if (!tenantId || !projectId) return;
    try {
      const [projectRes, auditRes, demoRes, trialsRes, costsRes] = await Promise.all([
        api.get<{ project: Project }>(`/tenants/${tenantId}/projects/${projectId}`),
        api.get<{ growthAuditRequests: GrowthAuditRequest[] }>(`${base}/growth-audit-requests`),
        api.get<{ demoRequests: DemoRequest[] }>(`${base}/demo-requests`),
        api.get<{ trials: TrialSignup[] }>(`${base}/trials`),
        api.get<{ acquisitionCosts: AcquisitionCost[] }>(`${base}/acquisition-costs`),
      ]);
      setProject(projectRes.project);
      setAuditRequests(auditRes.growthAuditRequests);
      setDemoRequests(demoRes.demoRequests);
      setTrials(trialsRes.trials);
      setCosts(costsRes.acquisitionCosts);
    } catch (err) {
      setLoadError(
        err instanceof ApiError
          ? err.message
          : "Could not load the acquisition workspace (is this the DevLaunch internal tenant?).",
      );
    }
  }, [tenantId, projectId, base]);

  useEffect(() => {
    load();
  }, [load]);

  const updateTrialStatus = useCallback(
    async (trialId: string, status: TrialSignupStatus) => {
      setUpdatingTrialId(trialId);
      setTrialUpdateError(null);
      try {
        await api.patch(`${base}/trials/${trialId}/status`, { status });
        await load();
      } catch (err) {
        setTrialUpdateError(err instanceof ApiError ? err.message : "Could not update this trial's status.");
      } finally {
        setUpdatingTrialId(null);
      }
    },
    [base, load],
  );

  const saveCost = useCallback(async () => {
    if (!costChannel.trim() || !costStart || !costEnd || !costAmount) return;
    setSavingCost(true);
    setCostError(null);
    try {
      const dollars = Number(costAmount);
      if (!Number.isFinite(dollars) || dollars < 0) throw new Error("Amount must be a non-negative number");
      await api.post(`${base}/acquisition-costs`, {
        channel: costChannel.trim(),
        periodStart: costStart,
        periodEnd: costEnd,
        amountCents: Math.round(dollars * 100),
      });
      setCostChannel("");
      setCostStart("");
      setCostEnd("");
      setCostAmount("");
      await load();
    } catch (err) {
      setCostError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : "Could not save this cost entry.");
    } finally {
      setSavingCost(false);
    }
  }, [base, costChannel, costStart, costEnd, costAmount, load]);

  const computeCac = useCallback(async () => {
    if (!cacStart || !cacEnd) return;
    setCacLoading(true);
    setCacError(null);
    setCacResult(null);
    try {
      const res = await api.get<CacResult>(
        `${base}/cac?periodStart=${encodeURIComponent(cacStart)}&periodEnd=${encodeURIComponent(cacEnd)}`,
      );
      setCacResult(res);
    } catch (err) {
      setCacError(err instanceof ApiError ? err.message : "Could not compute CAC for this period.");
    } finally {
      setCacLoading(false);
    }
  }, [base, cacStart, cacEnd]);

  const activeTrialsCount = (trials ?? []).filter((t) => t.status === "trial_started" || t.status === "trial_active").length;
  const convertedCount = (trials ?? []).filter((t) => t.status === "converted").length;

  return (
    <Layout
      crumbs={[
        { label: "Organizations", to: "/" },
        { label: "Organization", to: `/tenants/${tenantId}` },
        { label: project?.name ?? "...", to: `/tenants/${tenantId}/projects/${projectId}` },
        { label: "Acquisition Workspace" },
      ]}
      projectName={project?.name}
    >
      <ErrorBanner message={loadError} />

      <section className="panel">
        <h1>DevLaunch Acquisition Workspace</h1>
        <p className="muted">
          DevLaunch's own real customer-acquisition pipeline: free growth audits and demo requests submitted by real
          visitors on DevLaunch's own public site, a real trial pipeline, and real CAC — never fabricated leads,
          trials, or spend.
        </p>
        <StatGrid>
          <StatCard icon={<IconCompass />} label="Growth audits requested" value={auditRequests?.length ?? 0} />
          <StatCard icon={<IconUsers />} label="Demo requests" value={demoRequests?.length ?? 0} />
          <StatCard icon={<IconTarget />} label="Active trials" value={activeTrialsCount} />
          <StatCard icon={<IconZap />} label="Converted trials" value={convertedCount} />
        </StatGrid>
      </section>

      <section className="panel">
        <h2>Growth audit requests</h2>
        {auditRequests === null ? (
          <p className="muted">Loading...</p>
        ) : auditRequests.length === 0 ? (
          <EmptyState title="No growth audits yet" hint="Shown here as soon as a visitor submits the public growth-audit form." />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Domain</th>
                <th>Email</th>
                <th>Status</th>
                <th>Report</th>
                <th>Requested</th>
              </tr>
            </thead>
            <tbody>
              {auditRequests.map((r) => (
                <tr key={r.id}>
                  <td>{r.domain}</td>
                  <td>{r.email}</td>
                  <td>{r.status}</td>
                  <td>{r.report_status ?? "not queued"}</td>
                  <td>{new Date(r.created_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel">
        <h2>Demo requests</h2>
        {demoRequests === null ? (
          <p className="muted">Loading...</p>
        ) : demoRequests.length === 0 ? (
          <EmptyState title="No demo requests yet" hint="Shown here as soon as a visitor submits the public demo-request form." />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Company</th>
                <th>Requested</th>
              </tr>
            </thead>
            <tbody>
              {demoRequests.map((r) => (
                <tr key={r.id}>
                  <td>{r.name}</td>
                  <td>{r.email}</td>
                  <td>{r.company ?? "—"}</td>
                  <td>{new Date(r.created_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel">
        <h2>Trial pipeline</h2>
        <p className="muted">
          There is no real payment/billing integration in this platform — "Converted" is always a real status change a
          DevLaunch staff member makes below, never inferred from a payment webhook.
        </p>
        <ErrorBanner message={trialUpdateError} />
        {trials === null ? (
          <p className="muted">Loading...</p>
        ) : trials.length === 0 ? (
          <EmptyState title="No trials yet" hint="Record one manually, or promote a growth-audit/demo-request lead." />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Company</th>
                <th>Contact</th>
                <th>Status</th>
                <th>Started</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {trials.map((t) => (
                <tr key={t.id}>
                  <td>{t.company_name ?? "—"}</td>
                  <td>{t.contact_email}</td>
                  <td>{t.status}</td>
                  <td>{new Date(t.started_at).toLocaleDateString()}</td>
                  <td>
                    {STATUS_TRANSITIONS[t.status].length === 0 ? (
                      <span className="muted">final</span>
                    ) : (
                      STATUS_TRANSITIONS[t.status].map((next) => (
                        <button
                          key={next}
                          type="button"
                          onClick={() => updateTrialStatus(t.id, next)}
                          disabled={updatingTrialId === t.id}
                          style={{ marginRight: "0.5rem" }}
                        >
                          {updatingTrialId === t.id ? "..." : `Mark ${next}`}
                        </button>
                      ))
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel">
        <h2>Acquisition cost (CAC)</h2>
        <p className="muted">
          Real staff-entered channel spend below. CAC = total spend in a period ÷ real trials converted in that same
          period — if nothing converted, this honestly reports "insufficient data", never a guessed or zero-masked
          number.
        </p>

        <h3>Record spend</h3>
        <div className="form-row">
          <input type="text" placeholder="Channel (e.g. google_ads)" value={costChannel} onChange={(e) => setCostChannel(e.target.value)} />
          <input type="date" value={costStart} onChange={(e) => setCostStart(e.target.value)} />
          <input type="date" value={costEnd} onChange={(e) => setCostEnd(e.target.value)} />
          <input type="number" min="0" step="0.01" placeholder="Amount (USD)" value={costAmount} onChange={(e) => setCostAmount(e.target.value)} />
          <button type="button" onClick={saveCost} disabled={savingCost || !costChannel.trim() || !costStart || !costEnd || !costAmount}>
            {savingCost ? "Saving..." : "Save spend"}
          </button>
        </div>
        <ErrorBanner message={costError} />

        {costs === null ? (
          <p className="muted">Loading...</p>
        ) : costs.length === 0 ? (
          <EmptyState title="No spend recorded yet" hint="Record real channel spend above to compute CAC." />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Channel</th>
                <th>Period</th>
                <th>Amount</th>
              </tr>
            </thead>
            <tbody>
              {costs.map((c) => (
                <tr key={c.id}>
                  <td>{c.channel}</td>
                  <td>
                    {c.period_start} to {c.period_end}
                  </td>
                  <td>{centsToDollars(c.amount_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <h3>Compute CAC for a period</h3>
        <div className="form-row">
          <input type="date" value={cacStart} onChange={(e) => setCacStart(e.target.value)} />
          <input type="date" value={cacEnd} onChange={(e) => setCacEnd(e.target.value)} />
          <button type="button" onClick={computeCac} disabled={cacLoading || !cacStart || !cacEnd}>
            {cacLoading ? "Computing..." : "Compute CAC"}
          </button>
        </div>
        <ErrorBanner message={cacError} />
        {cacResult ? (
          <StatGrid>
            <StatCard icon={<IconZap />} label="Total spend" value={centsToDollars(cacResult.totalCostCents)} />
            <StatCard icon={<IconTarget />} label="Converted trials" value={cacResult.convertedCount} />
            <StatCard
              icon={<IconCompass />}
              label="CAC"
              value={cacResult.cacCents === null ? "Insufficient data" : centsToDollars(cacResult.cacCents)}
            />
          </StatGrid>
        ) : null}
      </section>
    </Layout>
  );
}
