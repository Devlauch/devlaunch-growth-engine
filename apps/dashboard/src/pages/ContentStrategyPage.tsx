import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { Layout } from "../components/Layout";
import { EmptyState } from "../components/EmptyState";
import { ErrorBanner } from "../components/ErrorBanner";
import { Badge } from "../components/Badge";
import { api, ApiError } from "../api/client";
import type { Project } from "../api/types";

// Local shapes — these mirror exactly what apps/api/src/routes/contentStrategy.ts
// and icpProfiles.ts return. Kept local to this page rather than added to
// api/types.ts, per this feature's file boundaries.
interface IcpProfileSummary {
  id: string;
  name: string;
  segment: string | null;
  pain_points: string[];
}

interface ContentCalendar {
  id: string;
  name: string;
  start_date: string;
  icp_profile_id: string | null;
  created_at: string;
}

type ContentType = "linkedin_post" | "blog" | "email";
type ItemStatus = "draft" | "approved";

interface ContentCalendarItem {
  id: string;
  day_offset: number;
  content_type: ContentType;
  title: string;
  body: string;
  status: ItemStatus;
}

type RepurposeFormat = "blog" | "linkedin_post" | "email" | "twitter_thread" | "summary";

interface ContentDraft {
  id: string;
  source_draft_id: string | null;
  format: RepurposeFormat;
  title: string;
  body: string;
  brand_voice_note: string | null;
  created_at: string;
}

const CONTENT_TYPE_LABELS: Record<ContentType, string> = {
  linkedin_post: "LinkedIn post",
  blog: "Blog",
  email: "Email",
};

const REPURPOSE_FORMATS: RepurposeFormat[] = ["linkedin_post", "email", "twitter_thread", "summary"];

const REPURPOSE_FORMAT_LABELS: Record<RepurposeFormat, string> = {
  blog: "Blog",
  linkedin_post: "LinkedIn post",
  email: "Email",
  twitter_thread: "Twitter/X thread",
  summary: "Summary",
};

function contentTypeTone(contentType: ContentType): "info" | "success" | "warn" {
  switch (contentType) {
    case "blog":
      return "success";
    case "email":
      return "warn";
    default:
      return "info";
  }
}

function groupByWeek(items: ContentCalendarItem[]): { week: number; items: ContentCalendarItem[] }[] {
  const weeks = new Map<number, ContentCalendarItem[]>();
  for (const item of items) {
    const week = Math.floor(item.day_offset / 7);
    const arr = weeks.get(week) ?? [];
    arr.push(item);
    weeks.set(week, arr);
  }
  return [...weeks.entries()]
    .sort(([a], [b]) => a - b)
    .map(([week, weekItems]) => ({
      week,
      items: weekItems.sort((a, b) => a.day_offset - b.day_offset),
    }));
}

export function ContentStrategyPage() {
  const { tenantId, projectId } = useParams<{ tenantId: string; projectId: string }>();

  const [project, setProject] = useState<Project | null>(null);
  const [icpProfiles, setIcpProfiles] = useState<IcpProfileSummary[] | null>(null);
  const [calendars, setCalendars] = useState<ContentCalendar[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Generate-calendar form
  const [calendarName, setCalendarName] = useState("30-day content calendar");
  const [startDate, setStartDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [icpProfileId, setIcpProfileId] = useState<string>("");
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);

  // Active calendar view
  const [activeCalendarId, setActiveCalendarId] = useState<string | null>(null);
  const [activeCalendar, setActiveCalendar] = useState<ContentCalendar | null>(null);
  const [items, setItems] = useState<ContentCalendarItem[] | null>(null);
  const [itemError, setItemError] = useState<string | null>(null);
  const [savingItemId, setSavingItemId] = useState<string | null>(null);
  const [editedTitles, setEditedTitles] = useState<Record<string, string>>({});
  const [editedBodies, setEditedBodies] = useState<Record<string, string>>({});

  // Repurpose panel
  const [blogTitle, setBlogTitle] = useState("");
  const [blogBody, setBlogBody] = useState("");
  const [targetFormats, setTargetFormats] = useState<RepurposeFormat[]>(["linkedin_post", "summary"]);
  const [repurposing, setRepurposing] = useState(false);
  const [repurposeError, setRepurposeError] = useState<string | null>(null);
  const [repurposedPieces, setRepurposedPieces] = useState<ContentDraft[] | null>(null);

  const load = useCallback(async () => {
    if (!tenantId || !projectId) return;
    try {
      const [projectRes, icpRes, calendarsRes] = await Promise.all([
        api.get<{ project: Project }>(`/tenants/${tenantId}/projects/${projectId}`),
        api.get<{ icpProfiles: IcpProfileSummary[] }>(`/tenants/${tenantId}/projects/${projectId}/icp-profiles`),
        api.get<{ contentCalendars: ContentCalendar[] }>(
          `/tenants/${tenantId}/projects/${projectId}/content-calendars`,
        ),
      ]);
      setProject(projectRes.project);
      setIcpProfiles(icpRes.icpProfiles);
      setCalendars(calendarsRes.contentCalendars);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Could not load content strategy for this project.");
    }
  }, [tenantId, projectId]);

  useEffect(() => {
    load();
  }, [load]);

  const loadCalendarDetail = useCallback(
    async (calendarId: string) => {
      if (!tenantId || !projectId) return;
      setItemError(null);
      try {
        const res = await api.get<{ contentCalendar: ContentCalendar; items: ContentCalendarItem[] }>(
          `/tenants/${tenantId}/projects/${projectId}/content-calendars/${calendarId}`,
        );
        setActiveCalendar(res.contentCalendar);
        setItems(res.items);
        setEditedTitles({});
        setEditedBodies({});
      } catch (err) {
        setItemError(err instanceof ApiError ? err.message : "Could not load this calendar.");
      }
    },
    [tenantId, projectId],
  );

  useEffect(() => {
    if (activeCalendarId) loadCalendarDetail(activeCalendarId);
  }, [activeCalendarId, loadCalendarDetail]);

  async function handleGenerate(e: FormEvent) {
    e.preventDefault();
    if (!tenantId || !projectId) return;
    setGenerateError(null);
    setGenerating(true);
    try {
      const res = await api.post<{ contentCalendar: ContentCalendar; items: ContentCalendarItem[] }>(
        `/tenants/${tenantId}/projects/${projectId}/content-calendars`,
        { name: calendarName, startDate, icpProfileId: icpProfileId || undefined },
      );
      setCalendars((prev) => [res.contentCalendar, ...(prev ?? [])]);
      setActiveCalendarId(res.contentCalendar.id);
      setActiveCalendar(res.contentCalendar);
      setItems(res.items);
    } catch (err) {
      setGenerateError(
        err instanceof ApiError ? err.message : "Could not generate a content calendar for this project.",
      );
    } finally {
      setGenerating(false);
    }
  }

  function titleFor(item: ContentCalendarItem): string {
    return editedTitles[item.id] ?? item.title;
  }
  function bodyFor(item: ContentCalendarItem): string {
    return editedBodies[item.id] ?? item.body;
  }

  async function saveItem(item: ContentCalendarItem, patch: { title?: string; body?: string; status?: ItemStatus }) {
    if (!tenantId || !projectId || !activeCalendar) return;
    setItemError(null);
    setSavingItemId(item.id);
    try {
      const res = await api.patch<{ item: ContentCalendarItem }>(
        `/tenants/${tenantId}/projects/${projectId}/content-calendars/${activeCalendar.id}/items/${item.id}`,
        patch,
      );
      setItems((prev) => (prev ? prev.map((i) => (i.id === item.id ? res.item : i)) : prev));
      setEditedTitles((prev) => {
        const next = { ...prev };
        delete next[item.id];
        return next;
      });
      setEditedBodies((prev) => {
        const next = { ...prev };
        delete next[item.id];
        return next;
      });
    } catch (err) {
      setItemError(err instanceof ApiError ? err.message : "Could not save this content piece.");
    } finally {
      setSavingItemId(null);
    }
  }

  function toggleTargetFormat(format: RepurposeFormat) {
    setTargetFormats((prev) => (prev.includes(format) ? prev.filter((f) => f !== format) : [...prev, format]));
  }

  async function handleRepurpose(e: FormEvent) {
    e.preventDefault();
    if (!tenantId || !projectId) return;
    setRepurposeError(null);
    setRepurposedPieces(null);
    setRepurposing(true);
    try {
      const createRes = await api.post<{ contentDraft: ContentDraft }>(
        `/tenants/${tenantId}/projects/${projectId}/content-drafts`,
        { format: "blog", title: blogTitle || "Untitled blog draft", body: blogBody },
      );
      const repurposeRes = await api.post<{ repurposed: ContentDraft[] }>(
        `/tenants/${tenantId}/projects/${projectId}/content-drafts/${createRes.contentDraft.id}/repurpose`,
        { targetFormats },
      );
      setRepurposedPieces(repurposeRes.repurposed);
    } catch (err) {
      setRepurposeError(err instanceof ApiError ? err.message : "Could not repurpose this blog draft.");
    } finally {
      setRepurposing(false);
    }
  }

  const weeks = items ? groupByWeek(items) : [];

  return (
    <Layout
      crumbs={[
        { label: "Organizations", to: "/" },
        { label: "Organization", to: `/tenants/${tenantId}` },
        { label: project?.name ?? "...", to: `/tenants/${tenantId}/projects/${projectId}` },
        { label: "Content Strategy" },
      ]}
      projectName={project?.name}
    >
      <ErrorBanner message={loadError} />

      <section className="panel">
        <h1>Content Strategy</h1>
        <p className="callout">
          Generates a real 30-day content calendar (LinkedIn posts, blogs, emails) from this project's own profile
          (value proposition + industry) and, optionally, one ICP's real pain points — no LLM call, deterministic
          templating grounded in your project's actual data. Nothing here is placeholder text.
        </p>

        <form className="form" onSubmit={handleGenerate}>
          <ErrorBanner message={generateError} />
          <label className="field">
            <span>Calendar name</span>
            <input required value={calendarName} onChange={(e) => setCalendarName(e.target.value)} />
          </label>
          <label className="field">
            <span>Start date</span>
            <input type="date" required value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </label>
          <label className="field">
            <span>Target ICP (optional)</span>
            <select value={icpProfileId} onChange={(e) => setIcpProfileId(e.target.value)}>
              <option value="">No specific ICP</option>
              {(icpProfiles ?? []).map((icp) => (
                <option key={icp.id} value={icp.id}>
                  {icp.name}
                  {icp.segment ? ` (${icp.segment})` : ""}
                </option>
              ))}
            </select>
          </label>
          <div className="form-actions">
            <button type="submit" className="btn btn-primary" disabled={generating}>
              {generating ? "Generating..." : "Generate 30-day calendar"}
            </button>
          </div>
        </form>

        {calendars === null ? (
          <p className="muted">Loading...</p>
        ) : calendars.length === 0 ? (
          <EmptyState
            title="No content calendars yet"
            hint="Generate one above using this project's profile and (optionally) an ICP."
          />
        ) : (
          <ul className="card-list card-list-static">
            {calendars.map((c) => (
              <li key={c.id} className="card-list-item card-list-item-static">
                <div>
                  <strong>{c.name}</strong>
                  <span className="muted"> · starts {c.start_date}</span>
                </div>
                <button type="button" className="btn btn-secondary btn-small" onClick={() => setActiveCalendarId(c.id)}>
                  {activeCalendarId === c.id ? "Viewing" : "View"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {activeCalendar ? (
        <section className="panel">
          <h2>{activeCalendar.name}</h2>
          <ErrorBanner message={itemError} />

          {items === null ? (
            <p className="muted">Loading...</p>
          ) : items.length === 0 ? (
            <EmptyState title="No content pieces in this calendar" />
          ) : (
            weeks.map(({ week, items: weekItems }) => (
              <div key={week} className="card-list-item-static" style={{ marginBottom: 20 }}>
                <h3>Week {week + 1}</h3>
                <ul className="card-list card-list-static">
                  {weekItems.map((item) => (
                    <li key={item.id} className="card-list-item-static" style={{ display: "block" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 6 }}>
                        <Badge tone={contentTypeTone(item.content_type)}>{CONTENT_TYPE_LABELS[item.content_type]}</Badge>
                        <span className="muted">Day {item.day_offset + 1}</span>
                        <Badge tone={item.status === "approved" ? "success" : "neutral"}>{item.status}</Badge>
                      </div>
                      <input
                        value={titleFor(item)}
                        onChange={(e) => setEditedTitles((prev) => ({ ...prev, [item.id]: e.target.value }))}
                        style={{ width: "100%", marginBottom: 6, fontWeight: 600 }}
                      />
                      <textarea
                        value={bodyFor(item)}
                        onChange={(e) => setEditedBodies((prev) => ({ ...prev, [item.id]: e.target.value }))}
                        rows={5}
                        style={{ width: "100%", marginBottom: 6 }}
                      />
                      <div className="form-actions">
                        <button
                          type="button"
                          className="btn btn-secondary btn-small"
                          disabled={savingItemId === item.id}
                          onClick={() => saveItem(item, { title: titleFor(item), body: bodyFor(item) })}
                        >
                          {savingItemId === item.id ? "Saving..." : "Save edits"}
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary btn-small"
                          disabled={savingItemId === item.id}
                          onClick={() => saveItem(item, { status: item.status === "approved" ? "draft" : "approved" })}
                        >
                          {item.status === "approved" ? "Unapprove" : "Approve"}
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )}
        </section>
      ) : null}

      <section className="panel">
        <h2>Repurpose a blog</h2>
        <p className="callout">
          Paste or write a blog draft below. Repurposing extracts real content from your own text (first paragraph as
          a LinkedIn hook, paragraph-by-paragraph bullets for a thread, first sentences for a summary) — it never
          invents new claims.
        </p>

        <form className="form" onSubmit={handleRepurpose}>
          <ErrorBanner message={repurposeError} />
          <label className="field">
            <span>Blog title</span>
            <input value={blogTitle} onChange={(e) => setBlogTitle(e.target.value)} placeholder="e.g. Why our customers switch" />
          </label>
          <label className="field">
            <span>Blog body</span>
            <textarea
              required
              rows={8}
              value={blogBody}
              onChange={(e) => setBlogBody(e.target.value)}
              placeholder="Write (or paste) your blog draft here, as real paragraphs separated by blank lines."
            />
          </label>
          <fieldset className="field">
            <legend>Target formats</legend>
            {REPURPOSE_FORMATS.map((format) => (
              <label key={format} style={{ display: "inline-flex", alignItems: "center", gap: 6, marginRight: 16 }}>
                <input
                  type="checkbox"
                  checked={targetFormats.includes(format)}
                  onChange={() => toggleTargetFormat(format)}
                />
                {REPURPOSE_FORMAT_LABELS[format]}
              </label>
            ))}
          </fieldset>
          <div className="form-actions">
            <button type="submit" className="btn btn-primary" disabled={repurposing || targetFormats.length === 0}>
              {repurposing ? "Repurposing..." : "Repurpose"}
            </button>
          </div>
        </form>

        {repurposedPieces === null ? null : repurposedPieces.length === 0 ? (
          <EmptyState title="No variants generated" hint="Pick at least one target format and try again." />
        ) : (
          <div className="table-wrap" style={{ display: "flex", gap: 16, overflowX: "auto" }}>
            {repurposedPieces.map((piece) => (
              <div key={piece.id} className="card-list-item-static" style={{ minWidth: 280, flex: "1 0 260px" }}>
                <Badge tone="info">{REPURPOSE_FORMAT_LABELS[piece.format]}</Badge>
                <h4>{piece.title}</h4>
                <p style={{ whiteSpace: "pre-wrap" }}>{piece.body}</p>
                {piece.brand_voice_note ? <p className="muted">{piece.brand_voice_note}</p> : null}
              </div>
            ))}
          </div>
        )}
      </section>
    </Layout>
  );
}
