import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { Layout } from "../components/Layout";
import { EmptyState } from "../components/EmptyState";
import { ErrorBanner } from "../components/ErrorBanner";
import { Badge } from "../components/Badge";
import { api, ApiError } from "../api/client";
import type { Project } from "../api/types";

// Milestone 2, Agent D (Postiz — social post scheduling/publishing).
// Local types kept here (not in api/types.ts) to avoid colliding with
// other agents editing that shared file in parallel this round — shapes
// mirror apps/api/src/routes/postizIntegration.ts exactly, nothing
// fabricated.

interface PostizStatus {
  provider: "postiz";
  status: "not_connected" | "pending_setup" | "connected" | "error";
  baseUrl?: string | null;
  organization: { id: string; name: string } | null;
  updatedAt?: string | null;
}

interface SocialAccount {
  id: string;
  name: string;
  identifier: string;
  picture?: string | null;
  disabled?: boolean;
}

type PostStatus = "draft" | "pending_approval" | "approved" | "rejected" | "scheduled" | "published" | "failed";

interface SocialPost {
  id: string;
  approval_id: string | null;
  content: string;
  platforms: string[];
  scheduled_at: string | null;
  status: PostStatus;
  postiz_post_id: string | null;
  published_at: string | null;
  last_synced_at: string | null;
  last_error: string | null;
  engagement: unknown;
  created_at: string;
}

function statusTone(status: PostStatus): "neutral" | "info" | "success" | "warn" | "danger" {
  switch (status) {
    case "published":
    case "scheduled":
      return "success";
    case "pending_approval":
      return "warn";
    case "failed":
    case "rejected":
      return "danger";
    case "approved":
      return "info";
    default:
      return "neutral";
  }
}

export function PostizIntegrationPage() {
  const { tenantId, projectId } = useParams<{ tenantId: string; projectId: string }>();

  const [project, setProject] = useState<Project | null>(null);
  const [status, setStatus] = useState<PostizStatus | null>(null);
  const [accounts, setAccounts] = useState<SocialAccount[] | null>(null);
  const [posts, setPosts] = useState<SocialPost[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [connectBaseUrl, setConnectBaseUrl] = useState("");
  const [connectApiKey, setConnectApiKey] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  const [healthChecking, setHealthChecking] = useState(false);

  const [content, setContent] = useState("");
  const [platformsText, setPlatformsText] = useState("");
  const [scheduledAt, setScheduledAt] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [actionError, setActionError] = useState<string | null>(null);
  const [actingPostId, setActingPostId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!tenantId || !projectId) return;
    try {
      const [projectRes, statusRes] = await Promise.all([
        api.get<{ project: Project }>(`/tenants/${tenantId}/projects/${projectId}`),
        api.get<PostizStatus>(`/tenants/${tenantId}/projects/${projectId}/integrations/postiz`),
      ]);
      setProject(projectRes.project);
      setStatus(statusRes);

      if (statusRes.status === "connected") {
        const [accountsRes, postsRes] = await Promise.all([
          api.get<{ status: string; accounts: SocialAccount[] }>(
            `/tenants/${tenantId}/projects/${projectId}/integrations/postiz/social-accounts`,
          ),
          api.get<{ posts: SocialPost[] }>(`/tenants/${tenantId}/projects/${projectId}/integrations/postiz/posts`),
        ]);
        setAccounts(accountsRes.accounts);
        setPosts(postsRes.posts);
      } else {
        setAccounts(null);
        setPosts(null);
      }
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Could not load the Postiz integration for this project.");
    }
  }, [tenantId, projectId]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleConnect(e: FormEvent) {
    e.preventDefault();
    if (!tenantId || !projectId) return;
    setConnectError(null);
    setConnecting(true);
    try {
      await api.post(`/tenants/${tenantId}/projects/${projectId}/integrations/postiz/connect`, {
        baseUrl: connectBaseUrl,
        apiKey: connectApiKey,
      });
      setConnectApiKey("");
      await load();
    } catch (err) {
      setConnectError(err instanceof ApiError ? err.message : "Could not connect Postiz with this API key.");
    } finally {
      setConnecting(false);
    }
  }

  async function handleDisconnect() {
    if (!tenantId || !projectId) return;
    setConnectError(null);
    try {
      await api.post(`/tenants/${tenantId}/projects/${projectId}/integrations/postiz/disconnect`, {});
      await load();
    } catch (err) {
      setConnectError(err instanceof ApiError ? err.message : "Could not disconnect Postiz.");
    }
  }

  async function handleCheckHealth() {
    if (!tenantId || !projectId) return;
    setHealthChecking(true);
    try {
      await api.get(`/tenants/${tenantId}/projects/${projectId}/integrations/postiz/health`);
      await load();
    } catch {
      await load();
    } finally {
      setHealthChecking(false);
    }
  }

  async function handleCreatePost(e: FormEvent) {
    e.preventDefault();
    if (!tenantId || !projectId) return;
    setCreateError(null);
    setCreating(true);
    try {
      const platforms = platformsText
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);
      await api.post(`/tenants/${tenantId}/projects/${projectId}/integrations/postiz/posts`, {
        content,
        platforms,
        scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : undefined,
      });
      setContent("");
      setPlatformsText("");
      setScheduledAt("");
      await load();
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : "Could not create this social post.");
    } finally {
      setCreating(false);
    }
  }

  async function handleRequestApproval(postId: string) {
    if (!tenantId || !projectId) return;
    setActionError(null);
    setActingPostId(postId);
    try {
      await api.post(`/tenants/${tenantId}/projects/${projectId}/integrations/postiz/posts/${postId}/request-approval`, {});
      await load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Could not submit this post for approval.");
    } finally {
      setActingPostId(null);
    }
  }

  async function handlePublish(postId: string) {
    if (!tenantId || !projectId) return;
    setActionError(null);
    setActingPostId(postId);
    try {
      await api.post(`/tenants/${tenantId}/projects/${projectId}/integrations/postiz/posts/${postId}/publish`, {});
      await load();
    } catch (err) {
      setActionError(
        err instanceof ApiError
          ? err.message
          : "Could not publish this post (it may still be awaiting a real human approval decision).",
      );
    } finally {
      setActingPostId(null);
    }
  }

  async function handleSync(postId: string) {
    if (!tenantId || !projectId) return;
    setActionError(null);
    setActingPostId(postId);
    try {
      await api.post(`/tenants/${tenantId}/projects/${projectId}/integrations/postiz/posts/${postId}/sync`, {});
      await load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Could not sync this post's real status from Postiz.");
    } finally {
      setActingPostId(null);
    }
  }

  return (
    <Layout
      crumbs={[
        { label: "Organizations", to: "/" },
        { label: "Organization", to: `/tenants/${tenantId}` },
        { label: project?.name ?? "...", to: `/tenants/${tenantId}/projects/${projectId}` },
        { label: "Postiz (social)" },
      ]}
      projectName={project?.name}
    >
      <ErrorBanner message={loadError} />

      <section className="panel">
        <h1>Postiz — social post scheduling &amp; publishing</h1>
        <p className="callout">
          Postiz is run as an independent, separately-hosted service (its own Postgres/Redis/Temporal cluster — see
          docker-compose.postiz.yml) and reached only through its documented <code>/public/v1</code> API — never
          forked or modified. Connect the API key of a Postiz Organization you've already created in your own Postiz
          instance; one Postiz Organization maps to exactly one tenant here.
        </p>

        {status ? (
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
            <Badge
              tone={status.status === "connected" ? "success" : status.status === "error" ? "danger" : "neutral"}
            >
              {status.status}
            </Badge>
            {status.organization ? <span className="muted">Organization: {status.organization.name}</span> : null}
            {status.status === "connected" ? (
              <>
                <button type="button" className="btn btn-secondary btn-small" onClick={handleCheckHealth} disabled={healthChecking}>
                  {healthChecking ? "Checking..." : "Check health"}
                </button>
                <button type="button" className="btn btn-secondary btn-small" onClick={handleDisconnect}>
                  Disconnect
                </button>
              </>
            ) : null}
          </div>
        ) : null}

        <ErrorBanner message={connectError} />

        {status && status.status !== "connected" ? (
          <form className="form" onSubmit={handleConnect}>
            <label className="field">
              <span>Postiz base URL</span>
              <input
                value={connectBaseUrl}
                onChange={(e) => setConnectBaseUrl(e.target.value)}
                placeholder="https://your-postiz-instance.example.com"
                required
              />
            </label>
            <label className="field">
              <span>Postiz Organization API key</span>
              <input
                type="password"
                value={connectApiKey}
                onChange={(e) => setConnectApiKey(e.target.value)}
                placeholder="Generated in your Postiz dashboard"
                required
              />
            </label>
            <div className="form-actions">
              <button type="submit" className="btn btn-primary" disabled={connecting}>
                {connecting ? "Verifying..." : "Connect Postiz"}
              </button>
            </div>
          </form>
        ) : null}
      </section>

      {status?.status === "connected" ? (
        <>
          <section className="panel">
            <h2>Connected social accounts</h2>
            <p className="callout">
              Real, currently-connected accounts from Postiz's own <code>GET /public/v1/integrations</code> — connect
              a new one through Postiz's own OAuth flow from its dashboard, or via the connect-social action below.
            </p>
            {accounts && accounts.length > 0 ? (
              <ul>
                {accounts.map((a) => (
                  <li key={a.id}>
                    {a.name} <span className="muted">({a.identifier})</span>{" "}
                    {a.disabled ? <Badge tone="danger">disabled</Badge> : <Badge tone="success">active</Badge>}
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title="No social accounts connected in Postiz yet." />
            )}
          </section>

          <section className="panel">
            <h2>New social post</h2>
            <p className="callout">
              Every post requires a real human approval decision (via the existing approvals queue) before it can be
              published — this platform never bypasses that gate.
            </p>
            <ErrorBanner message={createError} />
            <form className="form" onSubmit={handleCreatePost}>
              <label className="field">
                <span>Content</span>
                <textarea value={content} onChange={(e) => setContent(e.target.value)} rows={3} required />
              </label>
              <label className="field">
                <span>Platforms (Postiz integration ids, comma-separated)</span>
                <input value={platformsText} onChange={(e) => setPlatformsText(e.target.value)} required />
              </label>
              <label className="field">
                <span>Schedule for (optional — leave blank to publish immediately once approved)</span>
                <input type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} />
              </label>
              <div className="form-actions">
                <button type="submit" className="btn btn-primary" disabled={creating}>
                  {creating ? "Saving..." : "Save as draft"}
                </button>
              </div>
            </form>
          </section>

          <section className="panel">
            <h2>Posts</h2>
            <ErrorBanner message={actionError} />
            {posts && posts.length > 0 ? (
              <table className="table">
                <thead>
                  <tr>
                    <th>Content</th>
                    <th>Platforms</th>
                    <th>Status</th>
                    <th>Scheduled</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {posts.map((p) => (
                    <tr key={p.id}>
                      <td>{p.content.slice(0, 80)}</td>
                      <td>{p.platforms.join(", ")}</td>
                      <td>
                        <Badge tone={statusTone(p.status)}>{p.status}</Badge>
                        {p.last_error ? <div className="muted">{p.last_error}</div> : null}
                      </td>
                      <td>{p.scheduled_at ?? "—"}</td>
                      <td style={{ display: "flex", gap: 8 }}>
                        {p.status === "draft" ? (
                          <button
                            type="button"
                            className="btn btn-secondary btn-small"
                            disabled={actingPostId === p.id}
                            onClick={() => handleRequestApproval(p.id)}
                          >
                            Request approval
                          </button>
                        ) : null}
                        {p.status === "pending_approval" || p.status === "approved" ? (
                          <button
                            type="button"
                            className="btn btn-primary btn-small"
                            disabled={actingPostId === p.id}
                            onClick={() => handlePublish(p.id)}
                          >
                            Publish
                          </button>
                        ) : null}
                        {p.postiz_post_id ? (
                          <button
                            type="button"
                            className="btn btn-secondary btn-small"
                            disabled={actingPostId === p.id}
                            onClick={() => handleSync(p.id)}
                          >
                            Sync status
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <EmptyState title="No social posts yet." />
            )}
          </section>
        </>
      ) : null}
    </Layout>
  );
}
