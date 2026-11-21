import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { Layout } from "../components/Layout";
import { EmptyState } from "../components/EmptyState";
import { ErrorBanner } from "../components/ErrorBanner";
import { Badge } from "../components/Badge";
import { api, ApiError } from "../api/client";
import type { Project } from "../api/types";

// Local shapes for roadmap item 14 ("Sending setup per tenant") — these
// mirror apps/api/src/routes/sendingSetup.ts's responses exactly, the same
// way api/types.ts mirrors every other route's shapes, kept local here
// since api/types.ts is out of bounds for this change.

type DnsCheckStatus = "unchecked" | "pass" | "fail" | "not_found";

interface SendingDomain {
  id: string;
  tenant_id: string;
  domain: string;
  spf_status: DnsCheckStatus;
  spf_record: string | null;
  dkim_selector: string | null;
  dkim_status: DnsCheckStatus;
  dkim_record: string | null;
  dmarc_status: DnsCheckStatus;
  dmarc_record: string | null;
  dmarc_policy: string | null;
  last_checked_at: string | null;
  created_at: string;
}

interface WarmupConfig {
  id: string;
  sending_domain_id: string;
  daily_limit: number;
  target_daily_limit: number;
  ramp_increment: number;
  ramp_interval_days: number;
  started_at: string;
  is_paused: boolean;
  paused_reason: string | null;
  currentLimit: number;
}

interface SendHealthStat {
  id: string;
  sending_domain_id: string;
  stat_date: string;
  sent_count: number;
  bounced_count: number;
  complained_count: number;
}

interface PauseEvaluation {
  pause: boolean;
  reason?: string;
}

function dnsStatusTone(status: DnsCheckStatus): "neutral" | "success" | "danger" | "warn" {
  switch (status) {
    case "pass":
      return "success";
    case "fail":
      return "danger";
    case "not_found":
      return "warn";
    default:
      return "neutral";
  }
}

export function SendingSetupPage() {
  const { tenantId, projectId } = useParams<{ tenantId: string; projectId: string }>();

  const [project, setProject] = useState<Project | null>(null);
  const [domains, setDomains] = useState<SendingDomain[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [newDomain, setNewDomain] = useState("");
  const [newSelector, setNewSelector] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [verifyingId, setVerifyingId] = useState<string | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);

  const [selectedDomainId, setSelectedDomainId] = useState<string | null>(null);
  const [warmup, setWarmup] = useState<WarmupConfig | null | undefined>(undefined); // undefined = loading, null = none set yet
  const [healthStats, setHealthStats] = useState<SendHealthStat[] | null>(null);
  const [pauseEvaluation, setPauseEvaluation] = useState<PauseEvaluation | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [warmupTarget, setWarmupTarget] = useState("500");
  const [savingWarmup, setSavingWarmup] = useState(false);
  const [togglingPause, setTogglingPause] = useState(false);

  const [healthDate, setHealthDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [healthSent, setHealthSent] = useState("0");
  const [healthBounced, setHealthBounced] = useState("0");
  const [healthComplained, setHealthComplained] = useState("0");
  const [savingHealth, setSavingHealth] = useState(false);

  const load = useCallback(async () => {
    if (!tenantId || !projectId) return;
    try {
      const [projectRes, domainsRes] = await Promise.all([
        api.get<{ project: Project }>(`/tenants/${tenantId}/projects/${projectId}`),
        api.get<{ sendingDomains: SendingDomain[] }>(`/tenants/${tenantId}/projects/${projectId}/sending-domains`),
      ]);
      setProject(projectRes.project);
      setDomains(domainsRes.sendingDomains);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Could not load sending domains for this project.");
    }
  }, [tenantId, projectId]);

  useEffect(() => {
    load();
  }, [load]);

  const loadDetail = useCallback(
    async (domainId: string) => {
      if (!tenantId || !projectId) return;
      setDetailError(null);
      setWarmup(undefined);
      setHealthStats(null);
      setPauseEvaluation(null);
      try {
        const [healthRes, warmupRes] = await Promise.allSettled([
          api.get<{ sendHealthStats: SendHealthStat[]; pauseEvaluation: PauseEvaluation }>(
            `/tenants/${tenantId}/projects/${projectId}/sending-domains/${domainId}/health`,
          ),
          api.get<{ warmupConfig: WarmupConfig }>(
            `/tenants/${tenantId}/projects/${projectId}/sending-domains/${domainId}/warmup`,
          ),
        ]);

        if (healthRes.status === "fulfilled") {
          setHealthStats(healthRes.value.sendHealthStats);
          setPauseEvaluation(healthRes.value.pauseEvaluation);
        } else {
          setHealthStats([]);
        }

        if (warmupRes.status === "fulfilled") {
          setWarmup(warmupRes.value.warmupConfig);
        } else {
          // 404 just means no config has been created yet — not an error state.
          setWarmup(null);
        }
      } catch (err) {
        setDetailError(err instanceof ApiError ? err.message : "Could not load warm-up/health details.");
      }
    },
    [tenantId, projectId],
  );

  function selectDomain(domainId: string) {
    setSelectedDomainId(domainId);
    void loadDetail(domainId);
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    if (!tenantId || !projectId) return;
    setCreateError(null);
    setCreating(true);
    try {
      await api.post(`/tenants/${tenantId}/projects/${projectId}/sending-domains`, {
        domain: newDomain.trim().toLowerCase(),
        dkimSelector: newSelector.trim() || undefined,
      });
      setNewDomain("");
      setNewSelector("");
      setFormOpen(false);
      await load();
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : "Could not register this domain.");
    } finally {
      setCreating(false);
    }
  }

  async function handleVerify(domainId: string) {
    if (!tenantId || !projectId) return;
    setVerifyError(null);
    setVerifyingId(domainId);
    try {
      await api.post(`/tenants/${tenantId}/projects/${projectId}/sending-domains/${domainId}/verify`);
      await load();
      if (selectedDomainId === domainId) await loadDetail(domainId);
    } catch (err) {
      setVerifyError(err instanceof ApiError ? err.message : "DNS verification failed.");
    } finally {
      setVerifyingId(null);
    }
  }

  async function handleSaveWarmup(e: FormEvent) {
    e.preventDefault();
    if (!tenantId || !projectId || !selectedDomainId) return;
    setDetailError(null);
    setSavingWarmup(true);
    try {
      await api.post(`/tenants/${tenantId}/projects/${projectId}/sending-domains/${selectedDomainId}/warmup`, {
        dailyLimit: 20,
        targetDailyLimit: Number(warmupTarget),
        rampIncrement: 10,
        rampIntervalDays: 3,
      });
      await loadDetail(selectedDomainId);
    } catch (err) {
      setDetailError(err instanceof ApiError ? err.message : "Could not save warm-up config.");
    } finally {
      setSavingWarmup(false);
    }
  }

  async function handleTogglePause() {
    if (!tenantId || !projectId || !selectedDomainId || !warmup) return;
    setTogglingPause(true);
    setDetailError(null);
    try {
      const action = warmup.is_paused ? "resume" : "pause";
      await api.post(`/tenants/${tenantId}/projects/${projectId}/sending-domains/${selectedDomainId}/warmup/${action}`);
      await loadDetail(selectedDomainId);
    } catch (err) {
      setDetailError(err instanceof ApiError ? err.message : "Could not update pause state.");
    } finally {
      setTogglingPause(false);
    }
  }

  async function handleRecordHealth(e: FormEvent) {
    e.preventDefault();
    if (!tenantId || !projectId || !selectedDomainId) return;
    setDetailError(null);
    setSavingHealth(true);
    try {
      await api.post(`/tenants/${tenantId}/projects/${projectId}/sending-domains/${selectedDomainId}/health`, {
        statDate: healthDate,
        sentCount: Number(healthSent),
        bouncedCount: Number(healthBounced),
        complainedCount: Number(healthComplained),
      });
      await loadDetail(selectedDomainId);
    } catch (err) {
      setDetailError(err instanceof ApiError ? err.message : "Could not record health stats.");
    } finally {
      setSavingHealth(false);
    }
  }

  const selectedDomain = domains?.find((d) => d.id === selectedDomainId) ?? null;

  return (
    <Layout
      crumbs={[
        { label: "Organizations", to: "/" },
        { label: "Organization", to: `/tenants/${tenantId}` },
        { label: project?.name ?? "...", to: `/tenants/${tenantId}/projects/${projectId}` },
        { label: "Sending setup" },
      ]}
      projectName={project?.name}
    >
      <ErrorBanner message={loadError} />

      <section className="panel">
        <h1>Sending setup</h1>
        <p className="callout">
          Deliverability readiness for this tenant's sending domains: real SPF/DKIM/DMARC DNS checks, warm-up ramp
          limits, and bounce/complaint monitoring. No real outbound sending exists in this platform yet (see the
          Integrations page) — this page tracks whether a domain is *ready* to send, independently of that.
        </p>

        {domains === null ? (
          <p className="muted">Loading...</p>
        ) : domains.length === 0 ? (
          <EmptyState title="No sending domains yet" hint="Register a domain below to start checking its DNS setup." />
        ) : (
          <ul className="card-list card-list-static">
            {domains.map((d) => (
              <li key={d.id} className="card-list-item card-list-item-static">
                <div style={{ display: "flex", flexDirection: "column", gap: 4, cursor: "pointer" }} onClick={() => selectDomain(d.id)}>
                  <strong>{d.domain}</strong>
                  <div style={{ display: "flex", gap: 6 }}>
                    <Badge tone={dnsStatusTone(d.spf_status)}>SPF: {d.spf_status}</Badge>
                    <Badge tone={dnsStatusTone(d.dkim_status)}>DKIM: {d.dkim_selector ? d.dkim_status : "no selector"}</Badge>
                    <Badge tone={dnsStatusTone(d.dmarc_status)}>DMARC: {d.dmarc_status}</Badge>
                  </div>
                  <span className="muted">
                    {d.last_checked_at ? `Last checked ${new Date(d.last_checked_at).toLocaleString()}` : "Never checked"}
                  </span>
                </div>
                <button
                  type="button"
                  className="btn btn-secondary btn-small"
                  disabled={verifyingId === d.id}
                  onClick={() => handleVerify(d.id)}
                >
                  {verifyingId === d.id ? "Verifying..." : "Verify DNS"}
                </button>
              </li>
            ))}
          </ul>
        )}

        <ErrorBanner message={verifyError} />

        {!formOpen ? (
          <button type="button" className="btn btn-primary" onClick={() => setFormOpen(true)}>
            Register domain
          </button>
        ) : (
          <form className="form" onSubmit={handleCreate}>
            <ErrorBanner message={createError} />
            <label className="field">
              <span>Domain</span>
              <input
                required
                value={newDomain}
                onChange={(e) => setNewDomain(e.target.value)}
                placeholder="e.g. mail.example.com"
              />
            </label>
            <label className="field">
              <span>DKIM selector (optional — provider-specific, cannot be guessed)</span>
              <input value={newSelector} onChange={(e) => setNewSelector(e.target.value)} placeholder="e.g. google" />
            </label>
            <div className="form-actions">
              <button type="submit" className="btn btn-primary" disabled={creating}>
                {creating ? "Registering..." : "Register"}
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => setFormOpen(false)}>
                Cancel
              </button>
            </div>
          </form>
        )}
      </section>

      {selectedDomain ? (
        <section className="panel">
          <h2>{selectedDomain.domain}</h2>
          <ErrorBanner message={detailError} />

          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Check</th>
                  <th>Status</th>
                  <th>Record</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>SPF</td>
                  <td>
                    <Badge tone={dnsStatusTone(selectedDomain.spf_status)}>{selectedDomain.spf_status}</Badge>
                  </td>
                  <td className="muted">{selectedDomain.spf_record ?? "—"}</td>
                </tr>
                <tr>
                  <td>DKIM {selectedDomain.dkim_selector ? `(${selectedDomain.dkim_selector})` : ""}</td>
                  <td>
                    <Badge tone={dnsStatusTone(selectedDomain.dkim_status)}>
                      {selectedDomain.dkim_selector ? selectedDomain.dkim_status : "no selector set"}
                    </Badge>
                  </td>
                  <td className="muted">{selectedDomain.dkim_record ?? "—"}</td>
                </tr>
                <tr>
                  <td>DMARC</td>
                  <td>
                    <Badge tone={dnsStatusTone(selectedDomain.dmarc_status)}>
                      {selectedDomain.dmarc_status}
                      {selectedDomain.dmarc_policy ? ` (p=${selectedDomain.dmarc_policy})` : ""}
                    </Badge>
                  </td>
                  <td className="muted">{selectedDomain.dmarc_record ?? "—"}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <h3>Warm-up</h3>
          {warmup === undefined ? (
            <p className="muted">Loading...</p>
          ) : warmup === null ? (
            <form className="form" onSubmit={handleSaveWarmup}>
              <label className="field">
                <span>Target daily limit</span>
                <input
                  type="number"
                  min={1}
                  value={warmupTarget}
                  onChange={(e) => setWarmupTarget(e.target.value)}
                />
              </label>
              <p className="muted">Starts at 20/day, ramping by 10 every 3 days up to this target.</p>
              <button type="submit" className="btn btn-primary" disabled={savingWarmup}>
                {savingWarmup ? "Saving..." : "Start warm-up"}
              </button>
            </form>
          ) : (
            <div>
              <p>
                Current limit: <strong>{warmup.currentLimit}</strong> / day (target {warmup.target_daily_limit}, ramping
                +{warmup.ramp_increment} every {warmup.ramp_interval_days} day(s))
              </p>
              <p>
                <Badge tone={warmup.is_paused ? "danger" : "success"}>{warmup.is_paused ? "paused" : "active"}</Badge>
                {warmup.is_paused && warmup.paused_reason ? <span className="muted"> — {warmup.paused_reason}</span> : null}
              </p>
              <button type="button" className="btn btn-secondary btn-small" onClick={handleTogglePause} disabled={togglingPause}>
                {togglingPause ? "Updating..." : warmup.is_paused ? "Resume sending" : "Pause sending"}
              </button>
            </div>
          )}

          <h3>Send health</h3>
          {pauseEvaluation?.pause ? (
            <div className="error-banner" role="alert">
              Health check would currently recommend pausing: {pauseEvaluation.reason}
            </div>
          ) : null}

          {healthStats === null ? (
            <p className="muted">Loading...</p>
          ) : healthStats.length === 0 ? (
            <EmptyState
              title="No health stats recorded yet"
              hint="No real send pipeline exists yet, so these are recorded manually below."
            />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Sent</th>
                    <th>Bounced</th>
                    <th>Complained</th>
                  </tr>
                </thead>
                <tbody>
                  {healthStats.map((h) => (
                    <tr key={h.id}>
                      <td>{h.stat_date}</td>
                      <td>{h.sent_count}</td>
                      <td>{h.bounced_count}</td>
                      <td>{h.complained_count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <form className="form" onSubmit={handleRecordHealth}>
            <label className="field">
              <span>Date</span>
              <input type="date" value={healthDate} onChange={(e) => setHealthDate(e.target.value)} required />
            </label>
            <label className="field">
              <span>Sent</span>
              <input type="number" min={0} value={healthSent} onChange={(e) => setHealthSent(e.target.value)} />
            </label>
            <label className="field">
              <span>Bounced</span>
              <input type="number" min={0} value={healthBounced} onChange={(e) => setHealthBounced(e.target.value)} />
            </label>
            <label className="field">
              <span>Complained</span>
              <input type="number" min={0} value={healthComplained} onChange={(e) => setHealthComplained(e.target.value)} />
            </label>
            <div className="form-actions">
              <button type="submit" className="btn btn-primary" disabled={savingHealth}>
                {savingHealth ? "Saving..." : "Record day"}
              </button>
            </div>
          </form>
        </section>
      ) : null}
    </Layout>
  );
}
