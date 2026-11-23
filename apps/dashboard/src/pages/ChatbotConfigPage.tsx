import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { Layout } from "../components/Layout";
import { EmptyState } from "../components/EmptyState";
import { ErrorBanner } from "../components/ErrorBanner";
import { Badge } from "../components/Badge";
import { api, ApiError } from "../api/client";
import type { Project } from "../api/types";

// Local types for Phase roadmap item 4 ("Website AI Lead Capture Agent").
// Kept here rather than in api/types.ts to avoid colliding with other
// pages/agents editing that shared file in parallel this round -- shapes
// mirror apps/api/src/routes/chatbotAdmin.ts and packages/db migrations
// 271-275 exactly, nothing fabricated.

interface ChatbotConfig {
  id: string;
  project_id: string;
  enabled: boolean;
  welcome_message: string;
  fallback_message: string;
  consent_notice: string;
  qualifying_questions: string[];
  exchanges_before_qualifying: number;
  confidence_threshold: number;
}

type KnowledgeSourceStatus = "pending_review" | "approved" | "rejected";
type KnowledgeSourceOrigin = "manual" | "website_import";

interface KnowledgeSource {
  id: string;
  question: string;
  answer: string;
  tags: string[];
  origin: KnowledgeSourceOrigin;
  status: KnowledgeSourceStatus;
  source_url: string | null;
  is_active: boolean;
  created_at: string;
}

interface Conversation {
  id: string;
  status: string;
  consent_given: boolean;
  lead_id: string | null;
  started_at: string;
  last_message_at: string;
}

function statusTone(status: KnowledgeSourceStatus): "neutral" | "info" | "success" | "warn" | "danger" {
  switch (status) {
    case "approved":
      return "success";
    case "pending_review":
      return "warn";
    case "rejected":
      return "danger";
    default:
      return "neutral";
  }
}

export function ChatbotConfigPage() {
  const { tenantId, projectId } = useParams<{ tenantId: string; projectId: string }>();

  const [project, setProject] = useState<Project | null>(null);
  const [config, setConfig] = useState<ChatbotConfig | null>(null);
  const [knowledgeSources, setKnowledgeSources] = useState<KnowledgeSource[] | null>(null);
  const [conversations, setConversations] = useState<Conversation[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [configSaving, setConfigSaving] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  const [welcomeMessage, setWelcomeMessage] = useState("");
  const [fallbackMessage, setFallbackMessage] = useState("");
  const [consentNotice, setConsentNotice] = useState("");
  const [qualifyingQuestionsText, setQualifyingQuestionsText] = useState("");
  const [exchangesBeforeQualifying, setExchangesBeforeQualifying] = useState(3);

  const [formOpen, setFormOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [tagsText, setTagsText] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [importUrl, setImportUrl] = useState("");
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importResultCount, setImportResultCount] = useState<number | null>(null);

  const [reviewError, setReviewError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!tenantId || !projectId) return;
    try {
      const [projectRes, configRes, knowledgeRes, conversationsRes] = await Promise.all([
        api.get<{ project: Project }>(`/tenants/${tenantId}/projects/${projectId}`),
        api.get<{ config: ChatbotConfig }>(`/tenants/${tenantId}/projects/${projectId}/chatbot/config`),
        api.get<{ knowledgeSources: KnowledgeSource[] }>(
          `/tenants/${tenantId}/projects/${projectId}/chatbot/knowledge-sources`,
        ),
        api.get<{ conversations: Conversation[] }>(
          `/tenants/${tenantId}/projects/${projectId}/chatbot/conversations`,
        ),
      ]);
      setProject(projectRes.project);
      setConfig(configRes.config);
      setWelcomeMessage(configRes.config.welcome_message);
      setFallbackMessage(configRes.config.fallback_message);
      setConsentNotice(configRes.config.consent_notice);
      setQualifyingQuestionsText((configRes.config.qualifying_questions ?? []).join("\n"));
      setExchangesBeforeQualifying(configRes.config.exchanges_before_qualifying);
      setKnowledgeSources(knowledgeRes.knowledgeSources);
      setConversations(conversationsRes.conversations);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Could not load the chatbot for this project.");
    }
  }, [tenantId, projectId]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleToggleEnabled() {
    if (!tenantId || !projectId || !config) return;
    setConfigError(null);
    try {
      const res = await api.patch<{ config: ChatbotConfig }>(
        `/tenants/${tenantId}/projects/${projectId}/chatbot/config`,
        { enabled: !config.enabled },
      );
      setConfig(res.config);
    } catch (err) {
      setConfigError(err instanceof ApiError ? err.message : "Could not update the chatbot.");
    }
  }

  async function handleSaveConfig(e: FormEvent) {
    e.preventDefault();
    if (!tenantId || !projectId) return;
    setConfigError(null);
    setConfigSaving(true);
    try {
      const qualifyingQuestions = qualifyingQuestionsText
        .split("\n")
        .map((q) => q.trim())
        .filter(Boolean)
        .slice(0, 3);
      const res = await api.patch<{ config: ChatbotConfig }>(
        `/tenants/${tenantId}/projects/${projectId}/chatbot/config`,
        {
          welcomeMessage,
          fallbackMessage,
          consentNotice,
          qualifyingQuestions,
          exchangesBeforeQualifying,
        },
      );
      setConfig(res.config);
    } catch (err) {
      setConfigError(err instanceof ApiError ? err.message : "Could not save the chatbot's settings.");
    } finally {
      setConfigSaving(false);
    }
  }

  async function handleCreateKnowledgeSource(e: FormEvent) {
    e.preventDefault();
    if (!tenantId || !projectId) return;
    setCreateError(null);
    setCreating(true);
    try {
      await api.post(`/tenants/${tenantId}/projects/${projectId}/chatbot/knowledge-sources`, {
        question,
        answer,
        tags: tagsText
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
      });
      setQuestion("");
      setAnswer("");
      setTagsText("");
      setFormOpen(false);
      await load();
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : "Could not create this knowledge entry.");
    } finally {
      setCreating(false);
    }
  }

  async function handleImport(e: FormEvent) {
    e.preventDefault();
    if (!tenantId || !projectId || !importUrl.trim()) return;
    setImportError(null);
    setImportResultCount(null);
    setImporting(true);
    try {
      const res = await api.post<{ importedCount: number }>(
        `/tenants/${tenantId}/projects/${projectId}/chatbot/knowledge-sources/import`,
        { urls: [importUrl.trim()] },
      );
      setImportResultCount(res.importedCount);
      setImportUrl("");
      await load();
    } catch (err) {
      setImportError(err instanceof ApiError ? err.message : "Could not import from that URL.");
    } finally {
      setImporting(false);
    }
  }

  async function handleReview(id: string, action: "approve" | "reject") {
    if (!tenantId || !projectId) return;
    setReviewError(null);
    try {
      await api.post(`/tenants/${tenantId}/projects/${projectId}/chatbot/knowledge-sources/${id}/${action}`);
      await load();
    } catch (err) {
      setReviewError(err instanceof ApiError ? err.message : "Could not review this entry.");
    }
  }

  const pendingReview = (knowledgeSources ?? []).filter((k) => k.status === "pending_review");
  const liveEntries = (knowledgeSources ?? []).filter((k) => k.status !== "pending_review");

  return (
    <Layout
      crumbs={[
        { label: "Organizations", to: "/" },
        { label: "Organization", to: `/tenants/${tenantId}` },
        { label: project?.name ?? "...", to: `/tenants/${tenantId}/projects/${projectId}` },
        { label: "AI chatbot" },
      ]}
      projectName={project?.name}
    >
      <ErrorBanner message={loadError} />

      <section className="panel">
        <h1>Website AI lead-capture chatbot</h1>
        <p className="callout">
          Answers visitor questions ONLY from the approved knowledge entries below (real keyword/phrase matching
          against your Q&amp;A -- not a generic AI that can make things up), asks your configured qualifying
          question(s) after a few exchanges or when a visitor shows buying intent, and -- only after they consent --
          captures them as a lead through the same lead pipeline as the rest of the platform.
        </p>

        {config ? (
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
            <Badge tone={config.enabled ? "success" : "neutral"}>{config.enabled ? "Enabled" : "Disabled"}</Badge>
            <button type="button" className="btn btn-secondary btn-small" onClick={handleToggleEnabled}>
              {config.enabled ? "Disable chatbot" : "Enable chatbot"}
            </button>
          </div>
        ) : null}

        <ErrorBanner message={configError} />

        {config ? (
          <form className="form" onSubmit={handleSaveConfig}>
            <label className="field">
              <span>Welcome message</span>
              <input value={welcomeMessage} onChange={(e) => setWelcomeMessage(e.target.value)} />
            </label>
            <label className="field">
              <span>Honest fallback message (shown when no knowledge entry matches)</span>
              <input value={fallbackMessage} onChange={(e) => setFallbackMessage(e.target.value)} />
            </label>
            <label className="field">
              <span>Consent notice (shown before any contact info is captured)</span>
              <input value={consentNotice} onChange={(e) => setConsentNotice(e.target.value)} />
            </label>
            <label className="field">
              <span>Qualifying questions (1-3, one per line)</span>
              <textarea
                value={qualifyingQuestionsText}
                onChange={(e) => setQualifyingQuestionsText(e.target.value)}
                rows={3}
              />
            </label>
            <label className="field">
              <span>Exchanges before asking to qualify</span>
              <input
                type="number"
                min={1}
                max={20}
                value={exchangesBeforeQualifying}
                onChange={(e) => setExchangesBeforeQualifying(Number(e.target.value) || 1)}
              />
            </label>
            <div className="form-actions">
              <button type="submit" className="btn btn-primary" disabled={configSaving}>
                {configSaving ? "Saving..." : "Save settings"}
              </button>
            </div>
          </form>
        ) : (
          <p className="muted">Loading...</p>
        )}
      </section>

      <section className="panel">
        <h2>Pending review (imported from your website)</h2>
        <p className="callout">
          These were extracted from a crawl of your own site and are NOT live yet -- approve each one you want the
          bot to actually use, or reject it.
        </p>
        <ErrorBanner message={reviewError} />

        <form className="form" onSubmit={handleImport} style={{ marginBottom: 16 }}>
          <ErrorBanner message={importError} />
          {importResultCount !== null ? (
            <p className="muted">Imported {importResultCount} candidate snippet(s) for review.</p>
          ) : null}
          <label className="field">
            <span>Import from a page on your website</span>
            <input
              value={importUrl}
              onChange={(e) => setImportUrl(e.target.value)}
              placeholder="https://your-site.com/faq"
            />
          </label>
          <div className="form-actions">
            <button type="submit" className="btn btn-secondary" disabled={importing || !importUrl.trim()}>
              {importing ? "Importing..." : "Import from website"}
            </button>
          </div>
        </form>

        {pendingReview.length === 0 ? (
          <EmptyState title="Nothing pending review" hint="Import from your website above to find more." />
        ) : (
          <ul className="card-list card-list-static">
            {pendingReview.map((k) => (
              <li key={k.id} className="card-list-item card-list-item-static">
                <div>
                  <strong>{k.question}</strong>
                  <p className="muted">{k.answer}</p>
                  {k.source_url ? <span className="muted">Source: {k.source_url}</span> : null}
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button type="button" className="btn btn-primary btn-small" onClick={() => handleReview(k.id, "approve")}>
                    Approve
                  </button>
                  <button type="button" className="btn btn-secondary btn-small" onClick={() => handleReview(k.id, "reject")}>
                    Reject
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel">
        <h2>Knowledge base</h2>
        <ErrorBanner message={createError} />

        {liveEntries.length === 0 ? (
          <EmptyState title="No knowledge entries yet" hint="Add one below, or import from your website above." />
        ) : (
          <ul className="card-list card-list-static">
            {liveEntries.map((k) => (
              <li key={k.id} className="card-list-item card-list-item-static">
                <div>
                  <strong>{k.question}</strong>
                  <p className="muted">{k.answer}</p>
                </div>
                <Badge tone={statusTone(k.status)}>
                  {k.status}
                  {k.origin === "website_import" ? " (imported)" : ""}
                </Badge>
              </li>
            ))}
          </ul>
        )}

        {!formOpen ? (
          <button type="button" className="btn btn-primary" onClick={() => setFormOpen(true)}>
            New knowledge entry
          </button>
        ) : (
          <form className="form" onSubmit={handleCreateKnowledgeSource}>
            <label className="field">
              <span>Question</span>
              <input required value={question} onChange={(e) => setQuestion(e.target.value)} />
            </label>
            <label className="field">
              <span>Answer</span>
              <textarea required value={answer} onChange={(e) => setAnswer(e.target.value)} rows={3} />
            </label>
            <label className="field">
              <span>Tags (comma-separated, optional)</span>
              <input value={tagsText} onChange={(e) => setTagsText(e.target.value)} placeholder="pricing, refunds" />
            </label>
            <div className="form-actions">
              <button type="submit" className="btn btn-primary" disabled={creating}>
                {creating ? "Creating..." : "Create entry"}
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => setFormOpen(false)}>
                Cancel
              </button>
            </div>
          </form>
        )}
      </section>

      <section className="panel">
        <h2>Recent conversations</h2>
        {conversations === null ? (
          <p className="muted">Loading...</p>
        ) : conversations.length === 0 ? (
          <EmptyState title="No conversations yet" hint="They'll show up here once a visitor uses the widget." />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Consent</th>
                  <th>Lead captured</th>
                  <th>Started</th>
                </tr>
              </thead>
              <tbody>
                {conversations.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <Badge tone="neutral">{c.status}</Badge>
                    </td>
                    <td>{c.consent_given ? "Yes" : "No"}</td>
                    <td>{c.lead_id ? "Yes" : "No"}</td>
                    <td>{new Date(c.started_at).toLocaleString()}</td>
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
