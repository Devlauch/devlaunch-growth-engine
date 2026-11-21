import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { Layout } from "../components/Layout";
import { EmptyState } from "../components/EmptyState";
import { ErrorBanner } from "../components/ErrorBanner";
import { Badge } from "../components/Badge";
import { api, ApiError } from "../api/client";
import type { Project } from "../api/types";

// apps/dashboard/src/api/types.ts's shared `Project` interface doesn't (and
// per this task's file boundaries, shouldn't) carry the roadmap item 6
// ("Inbound lead capture") widget-config fields yet, so this page extends
// it locally — same convention DiscoveryPage.tsx uses for its own
// page-local shapes. Mirrors exactly what
// apps/api/src/routes/projects.ts's GET/PATCH handlers return.
interface ProjectWithWidgetConfig extends Project {
  widget_qualifying_question: string | null;
  widget_booking_link_url: string | null;
  widget_thank_you_message: string | null;
}

// Mirrors the row shape returned by
// GET /tenants/:tenantId/projects/:projectId/utm-sample-leads
// (apps/api/src/routes/projects.ts).
interface UtmSampleLead {
  id: string;
  name: string | null;
  email: string | null;
  source: string;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_term: string | null;
  utm_content: string | null;
  referrer_url: string | null;
  qualifying_answer: string | null;
  created_at: string;
}

export function WidgetSettingsPage() {
  const { tenantId, projectId } = useParams<{ tenantId: string; projectId: string }>();

  const [project, setProject] = useState<ProjectWithWidgetConfig | null>(null);
  const [utmLeads, setUtmLeads] = useState<UtmSampleLead[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [qualifyingQuestion, setQualifyingQuestion] = useState("");
  const [bookingLinkUrl, setBookingLinkUrl] = useState("");
  const [thankYouMessage, setThankYouMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    if (!tenantId || !projectId) return;
    try {
      const [projectRes, utmLeadsRes] = await Promise.all([
        api.get<{ project: ProjectWithWidgetConfig }>(`/tenants/${tenantId}/projects/${projectId}`),
        api.get<{ leads: UtmSampleLead[] }>(`/tenants/${tenantId}/projects/${projectId}/utm-sample-leads`),
      ]);
      setProject(projectRes.project);
      setQualifyingQuestion(projectRes.project.widget_qualifying_question ?? "");
      setBookingLinkUrl(projectRes.project.widget_booking_link_url ?? "");
      setThankYouMessage(projectRes.project.widget_thank_you_message ?? "");
      setUtmLeads(utmLeadsRes.leads);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Could not load widget settings for this project.");
    }
  }, [tenantId, projectId]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    if (!tenantId || !projectId) return;
    setSaveError(null);
    setSaved(false);
    setSaving(true);
    try {
      // Sending null (not omitting the field) is what actually clears a
      // previously-set value — see apps/api/src/routes/projects.ts's PATCH
      // handler, which distinguishes "field omitted" from "field sent as
      // null" for these three widget-config fields.
      const res = await api.patch<{ project: ProjectWithWidgetConfig }>(
        `/tenants/${tenantId}/projects/${projectId}`,
        {
          widgetQualifyingQuestion: qualifyingQuestion.trim() ? qualifyingQuestion.trim() : null,
          widgetBookingLinkUrl: bookingLinkUrl.trim() ? bookingLinkUrl.trim() : null,
          widgetThankYouMessage: thankYouMessage.trim() ? thankYouMessage.trim() : null,
        },
      );
      setProject(res.project);
      setSaved(true);
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : "Could not save widget settings.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Layout
      crumbs={[
        { label: "Organizations", to: "/" },
        { label: "Organization", to: `/tenants/${tenantId}` },
        { label: project?.name ?? "...", to: `/tenants/${tenantId}/projects/${projectId}` },
        { label: "Widget settings" },
      ]}
      projectName={project?.name}
    >
      <ErrorBanner message={loadError} />

      <section className="panel">
        <h1>Widget settings</h1>
        <p className="callout">
          Configure the embeddable lead-capture widget (<code>packages/embed-widget/embed.js</code>): the one
          qualifying question shown before submit, the booking link shown after a successful submit, and the
          thank-you copy. Every submission is also tagged with UTM params and referrer parsed from the page the
          widget is embedded on, so you can tell which campaign/channel a lead actually came from.
        </p>

        {project === null ? (
          <p className="muted">Loading...</p>
        ) : (
          <form className="form" onSubmit={handleSave}>
            <ErrorBanner message={saveError} />
            {saved ? <p className="muted">Saved.</p> : null}

            <label className="field">
              <span>Qualifying question</span>
              <input
                value={qualifyingQuestion}
                onChange={(e) => setQualifyingQuestion(e.target.value)}
                placeholder="e.g. What's your biggest challenge right now?"
                maxLength={500}
              />
            </label>
            <p className="muted">Leave blank to show no qualifying question on the widget.</p>

            <label className="field">
              <span>Booking link URL</span>
              <input
                value={bookingLinkUrl}
                onChange={(e) => setBookingLinkUrl(e.target.value)}
                placeholder="e.g. https://cal.example.com/your-team"
                maxLength={500}
              />
            </label>
            <p className="muted">
              Leave blank to show a generic thank-you with no booking link after a lead submits the form.
            </p>

            <label className="field">
              <span>Thank-you message</span>
              <input
                value={thankYouMessage}
                onChange={(e) => setThankYouMessage(e.target.value)}
                placeholder="Thanks! We'll be in touch."
                maxLength={2000}
              />
            </label>
            <p className="muted">Leave blank to use the default thank-you copy.</p>

            <div className="form-actions">
              <button type="submit" className="btn btn-primary" disabled={saving}>
                {saving ? "Saving..." : "Save widget settings"}
              </button>
            </div>
          </form>
        )}
      </section>

      <section className="panel">
        <h2>UTM-tagged leads</h2>
        <p className="callout">
          Leads that arrived via the public widget with UTM tracking data present — a quick way to confirm tracking
          is actually working once this project's widget is embedded somewhere with UTM-tagged links.
        </p>

        {utmLeads === null ? (
          <p className="muted">Loading...</p>
        ) : utmLeads.length === 0 ? (
          <EmptyState
            title="No UTM-tagged leads yet"
            hint="Submit a lead through the widget via a link with ?utm_source=... to see it appear here."
          />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Lead</th>
                  <th>Source</th>
                  <th>Campaign</th>
                  <th>Medium</th>
                  <th>Qualifying answer</th>
                  <th>Received</th>
                </tr>
              </thead>
              <tbody>
                {utmLeads.map((lead) => (
                  <tr key={lead.id}>
                    <td>{lead.name ?? lead.email ?? "—"}</td>
                    <td>
                      <Badge tone="info">{lead.utm_source}</Badge>
                    </td>
                    <td>{lead.utm_campaign ?? "—"}</td>
                    <td>{lead.utm_medium ?? "—"}</td>
                    <td>{lead.qualifying_answer ?? "—"}</td>
                    <td>{new Date(lead.created_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </Layout>
  );
}
