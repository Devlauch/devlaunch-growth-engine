import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { Layout } from "../components/Layout";
import { EmptyState } from "../components/EmptyState";
import { ErrorBanner } from "../components/ErrorBanner";
import { Badge, statusTone } from "../components/Badge";
import { api, ApiError, downloadFile } from "../api/client";
import type { GeneratedReport, GenerateReportResult, Project, ReportSchedule } from "../api/types";

// Real downloadable PDF client reports. Every row below is a real
// generated_reports row, and every number inside the PDF itself is a real
// SQL aggregate (apps/worker/src/reports/reportQueries.ts) — nothing here
// is fabricated. Recurring schedules are stored and checked by a real
// worker-side loop (apps/worker/src/reports/scheduleLoop.ts), but no email
// is ever sent: this environment has no real SMTP/email-provider
// configured, so "recipients" is stored metadata only, and a due schedule
// just produces another downloadable row here.
export function ReportsPage() {
  const { tenantId, projectId } = useParams<{ tenantId: string; projectId: string }>();

  const [project, setProject] = useState<Project | null>(null);
  const [reports, setReports] = useState<GeneratedReport[] | null>(null);
  const [schedules, setSchedules] = useState<ReportSchedule[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const [frequency, setFrequency] = useState<"weekly" | "monthly">("weekly");
  const [recipients, setRecipients] = useState<string[]>([]);
  const [newRecipient, setNewRecipient] = useState("");
  const [scheduleEnabled, setScheduleEnabled] = useState(true);
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [scheduleError, setScheduleError] = useState<string | null>(null);

  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    if (!tenantId || !projectId) return;
    try {
      const [projectRes, reportsRes, schedulesRes] = await Promise.all([
        api.get<{ project: Project }>(`/tenants/${tenantId}/projects/${projectId}`),
        api.get<{ reports: GeneratedReport[] }>(`/tenants/${tenantId}/projects/${projectId}/reports`),
        api.get<{ schedules: ReportSchedule[] }>(`/tenants/${tenantId}/projects/${projectId}/report-schedules`),
      ]);
      setProject(projectRes.project);
      setReports(reportsRes.reports);
      setSchedules(schedulesRes.schedules);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Could not load reports for this project.");
    }
  }, [tenantId, projectId]);

  useEffect(() => {
    load();
  }, [load]);

  // While any report is queued/running, poll the list every few seconds so
  // "Generate now" visibly moves from queued -> running -> succeeded/failed
  // without a manual refresh — same polling idea as ExecutionPage.tsx.
  useEffect(() => {
    const hasInFlight = reports?.some((r) => r.status === "queued" || r.status === "running") ?? false;
    if (hasInFlight && !pollTimer.current) {
      pollTimer.current = setInterval(load, 3000);
    } else if (!hasInFlight && pollTimer.current) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
    return () => {
      if (pollTimer.current) {
        clearInterval(pollTimer.current);
        pollTimer.current = null;
      }
    };
  }, [reports, load]);

  async function handleGenerateNow() {
    if (!tenantId || !projectId) return;
    setGenerateError(null);
    setGenerating(true);
    try {
      await api.post<GenerateReportResult>(`/tenants/${tenantId}/projects/${projectId}/reports/generate`, {});
      await load();
    } catch (err) {
      setGenerateError(err instanceof ApiError ? err.message : "Could not start report generation.");
    } finally {
      setGenerating(false);
    }
  }

  async function handleDownload(report: GeneratedReport) {
    if (!tenantId || !projectId) return;
    setDownloadError(null);
    try {
      await downloadFile(
        `/tenants/${tenantId}/projects/${projectId}/reports/${report.id}/download`,
        `report-${report.id}.pdf`,
      );
    } catch (err) {
      setDownloadError(err instanceof ApiError ? err.message : "Could not download this report.");
    }
  }

  function addRecipient() {
    const value = newRecipient.trim();
    if (!value) return;
    if (!recipients.includes(value)) setRecipients((prev) => [...prev, value]);
    setNewRecipient("");
  }

  function removeRecipient(email: string) {
    setRecipients((prev) => prev.filter((r) => r !== email));
  }

  async function handleCreateSchedule(e: FormEvent) {
    e.preventDefault();
    if (!tenantId || !projectId) return;
    setScheduleError(null);
    setSavingSchedule(true);
    try {
      await api.post(`/tenants/${tenantId}/projects/${projectId}/report-schedules`, {
        frequency,
        recipients,
        enabled: scheduleEnabled,
      });
      setRecipients([]);
      await load();
    } catch (err) {
      setScheduleError(err instanceof ApiError ? err.message : "Could not create the schedule.");
    } finally {
      setSavingSchedule(false);
    }
  }

  async function toggleScheduleEnabled(schedule: ReportSchedule) {
    if (!tenantId || !projectId) return;
    setScheduleError(null);
    try {
      await api.patch(`/tenants/${tenantId}/projects/${projectId}/report-schedules/${schedule.id}`, {
        enabled: !schedule.enabled,
      });
      await load();
    } catch (err) {
      setScheduleError(err instanceof ApiError ? err.message : "Could not update the schedule.");
    }
  }

  return (
    <Layout
      crumbs={[
        { label: "Organizations", to: "/" },
        { label: "Organization", to: `/tenants/${tenantId}` },
        { label: project?.name ?? "...", to: `/tenants/${tenantId}/projects/${projectId}` },
        { label: "Reports" },
      ]}
      projectName={project?.name}
    >
      <ErrorBanner message={loadError} />

      <section className="panel">
        <h1>Reports</h1>
        <p className="muted">
          Real PDF client reports, generated directly from this project's leads, campaigns, and agent-execution
          data — nothing here is estimated or fabricated. Recurring schedules are checked by a real worker-side
          loop; no email is sent (this environment has no SMTP/email provider configured), so a due schedule just
          adds another report below for you to download.
        </p>
        <ErrorBanner message={generateError} />
        <ErrorBanner message={downloadError} />
        <div className="form-actions">
          <button type="button" className="btn btn-primary" onClick={handleGenerateNow} disabled={generating}>
            {generating ? "Starting..." : "Generate now"}
          </button>
        </div>
      </section>

      <section className="panel">
        <h2>Generated reports</h2>
        {reports === null ? (
          <p className="muted">Loading...</p>
        ) : reports.length === 0 ? (
          <EmptyState title="No reports yet" hint="Generate one above, or set up a recurring schedule below." />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Period</th>
                  <th>Source</th>
                  <th>Size</th>
                  <th>Created</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {reports.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Badge tone={statusTone(r.status)}>{r.status}</Badge>
                    </td>
                    <td>
                      {new Date(r.period_start).toLocaleDateString()} – {new Date(r.period_end).toLocaleDateString()}
                    </td>
                    <td>{r.schedule_id ? "Schedule" : "On-demand"}</td>
                    <td>{r.file_bytes ? `${Math.round(r.file_bytes / 1024)} KB` : "—"}</td>
                    <td>{new Date(r.created_at).toLocaleString()}</td>
                    <td>
                      {r.status === "succeeded" ? (
                        <button type="button" className="btn btn-secondary btn-small" onClick={() => handleDownload(r)}>
                          Download
                        </button>
                      ) : r.status === "failed" ? (
                        <span className="muted hint" title={r.error ?? undefined}>
                          Failed
                        </span>
                      ) : (
                        <span className="muted hint">{r.status}...</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <h2>Recurring schedules</h2>
        <p className="muted">
          Add a weekly or monthly schedule to have the worker auto-generate a fresh report on that cadence. Nothing
          is emailed automatically — recipients are stored for whenever real email delivery is wired up.
        </p>

        <ErrorBanner message={scheduleError} />

        {schedules === null ? (
          <p className="muted">Loading...</p>
        ) : schedules.length === 0 ? (
          <EmptyState title="No schedules yet" hint="Create one below." />
        ) : (
          <ul className="card-list card-list-static">
            {schedules.map((s) => (
              <li key={s.id} className="card-list-item card-list-item-static">
                <div>
                  <strong>{s.frequency}</strong>
                  <span className="muted">
                    {" "}
                    · {s.recipients.length} recipient{s.recipients.length === 1 ? "" : "s"} · last generated{" "}
                    {s.last_generated_at ? new Date(s.last_generated_at).toLocaleString() : "never"}
                  </span>
                </div>
                <div className="form-actions">
                  <Badge tone={s.enabled ? "success" : "neutral"}>{s.enabled ? "Enabled" : "Disabled"}</Badge>
                  <button type="button" className="btn btn-secondary btn-small" onClick={() => toggleScheduleEnabled(s)}>
                    {s.enabled ? "Disable" : "Enable"}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <form className="form" onSubmit={handleCreateSchedule}>
          <label className="field">
            <span>Frequency</span>
            <select value={frequency} onChange={(e) => setFrequency(e.target.value as "weekly" | "monthly")}>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
            </select>
          </label>

          <div className="field">
            <span>Recipients (stored only — not emailed)</span>
            {recipients.length === 0 ? (
              <p className="muted hint" style={{ margin: "4px 0" }}>
                No recipients added yet.
              </p>
            ) : (
              <ul className="origin-list">
                {recipients.map((email) => (
                  <li key={email}>
                    <span>{email}</span>
                    <button
                      type="button"
                      className="origin-remove"
                      aria-label={`Remove ${email}`}
                      onClick={() => removeRecipient(email)}
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="input-with-action" style={{ marginTop: 8 }}>
              <input
                type="email"
                value={newRecipient}
                onChange={(e) => setNewRecipient(e.target.value)}
                placeholder="person@client.com"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addRecipient();
                  }
                }}
              />
              <button type="button" className="btn btn-secondary btn-small" onClick={addRecipient}>
                Add
              </button>
            </div>
          </div>

          <label className="field checkbox-field">
            <input type="checkbox" checked={scheduleEnabled} onChange={(e) => setScheduleEnabled(e.target.checked)} />
            <span>Enabled</span>
          </label>

          <div className="form-actions">
            <button type="submit" className="btn btn-primary" disabled={savingSchedule}>
              {savingSchedule ? "Saving..." : "Add schedule"}
            </button>
          </div>
        </form>
      </section>
    </Layout>
  );
}
