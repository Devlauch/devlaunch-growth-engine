import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { Layout } from "../components/Layout";
import { ErrorBanner } from "../components/ErrorBanner";
import { Badge } from "../components/Badge";
import { api, ApiError } from "../api/client";

/**
 * Milestone 2, Agent C (Chatwoot). NOT wired into App.tsx/Layout.tsx's
 * route table or nav by this change (both are off-limits this round) —
 * see this feature's handback for the one-line route + nav snippet.
 *
 * Talks to TWO route files, deliberately:
 *   - apps/api/src/routes/integrations.ts's EXISTING generic
 *     POST .../integrations/chatwoot/connect and
 *     POST .../integrations/chatwoot/health-check (provider-agnostic,
 *     shared with listmonk/postiz — this page does not duplicate that
 *     logic).
 *   - apps/api/src/routes/chatwootIntegration.ts's chatwoot-SPECIFIC
 *     GET .../integrations/chatwoot/conversations and
 *     GET .../integrations/chatwoot/embed-snippet.
 *
 * `secret` here is a single real Chatwoot `api_access_token` string — see
 * apps/api/src/lib/chatwootClient.ts's header comment for exactly how
 * it's used and encrypted at rest; this page never displays a
 * previously-stored secret back (only whether one is on file, via
 * `hasSecret` from GET .../integrations).
 */

interface IntegrationRow {
  provider: string;
  status: string;
  config: Record<string, unknown>;
  hasSecret: boolean;
  real: boolean;
  updatedAt: string | null;
}

interface ConversationRow {
  id: number;
  inboxId?: number;
  status?: string;
}

export function ChatwootIntegrationPage() {
  const { tenantId, projectId } = useParams<{ tenantId: string; projectId: string }>();

  const [integration, setIntegration] = useState<IntegrationRow | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [baseUrl, setBaseUrl] = useState("");
  const [accountId, setAccountId] = useState("");
  const [websiteToken, setWebsiteToken] = useState("");
  const [apiAccessToken, setApiAccessToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [healthChecking, setHealthChecking] = useState(false);
  const [healthResult, setHealthResult] = useState<string | null>(null);

  const [conversations, setConversations] = useState<ConversationRow[] | null>(null);
  const [conversationsError, setConversationsError] = useState<string | null>(null);

  const [snippet, setSnippet] = useState<string | null>(null);
  const [snippetError, setSnippetError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    if (!tenantId || !projectId) return;
    try {
      const data = await api.get<{ integrations: IntegrationRow[] }>(
        `/tenants/${tenantId}/projects/${projectId}/integrations`,
      );
      const row = data.integrations.find((i) => i.provider === "chatwoot") ?? null;
      setIntegration(row);
      if (row?.config) {
        setBaseUrl(typeof row.config.baseUrl === "string" ? row.config.baseUrl : "");
        setAccountId(typeof row.config.accountId === "string" || typeof row.config.accountId === "number" ? String(row.config.accountId) : "");
        setWebsiteToken(typeof row.config.websiteToken === "string" ? row.config.websiteToken : "");
      }
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Failed to load Chatwoot integration status");
    }
  }, [tenantId, projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleSave(event: FormEvent) {
    event.preventDefault();
    if (!tenantId || !projectId) return;
    setSaving(true);
    setSaveError(null);
    try {
      await api.post(`/tenants/${tenantId}/projects/${projectId}/integrations/chatwoot/connect`, {
        config: { baseUrl, accountId, websiteToken },
        ...(apiAccessToken ? { secret: apiAccessToken } : {}),
      });
      setApiAccessToken("");
      await load();
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : "Failed to save Chatwoot connection");
    } finally {
      setSaving(false);
    }
  }

  async function handleHealthCheck() {
    if (!tenantId || !projectId) return;
    setHealthChecking(true);
    setHealthResult(null);
    try {
      const result = await api.post<{ status: string; detail?: string }>(
        `/tenants/${tenantId}/projects/${projectId}/integrations/chatwoot/health-check`,
      );
      setHealthResult(`${result.status}${result.detail ? ` — ${result.detail}` : ""}`);
      await load();
    } catch (err) {
      setHealthResult(err instanceof ApiError ? err.message : "Health check failed");
    } finally {
      setHealthChecking(false);
    }
  }

  async function handleLoadConversations() {
    if (!tenantId || !projectId) return;
    setConversationsError(null);
    try {
      const result = await api.get<{ status: string; detail?: string; conversations: ConversationRow[] }>(
        `/tenants/${tenantId}/projects/${projectId}/integrations/chatwoot/conversations`,
      );
      if (result.status === "not_configured") {
        setConversationsError(result.detail ?? "Chatwoot is not connected yet");
        setConversations([]);
        return;
      }
      setConversations(result.conversations);
    } catch (err) {
      setConversationsError(err instanceof ApiError ? err.message : "Failed to load conversations");
    }
  }

  async function handleLoadSnippet() {
    if (!tenantId || !projectId) return;
    setSnippetError(null);
    try {
      const result = await api.get<{ snippet: string }>(
        `/tenants/${tenantId}/projects/${projectId}/integrations/chatwoot/embed-snippet`,
      );
      setSnippet(result.snippet);
    } catch (err) {
      setSnippetError(err instanceof ApiError ? err.message : "Save a websiteToken/baseUrl first");
    }
  }

  async function handleCopySnippet() {
    if (!snippet) return;
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API unavailable (e.g. insecure context) — the snippet is
      // still visible in the <pre> block for manual copy.
    }
  }

  return (
    <Layout>
      <h1>Chatwoot — Live Chat</h1>
      <p>
        Chatwoot runs as a fully independent service (its own Rails/Postgres/Redis stack — see{" "}
        <code>docker-compose.chatwoot.yml</code>), never merged into this platform. Connecting it here lets visitor
        contacts captured in Chatwoot conversations sync into this project's real Leads list.
      </p>

      {loadError && <ErrorBanner message={loadError} />}

      {integration && (
        <p>
          Status: <Badge tone={integration.status === "connected" ? "success" : integration.status === "error" ? "danger" : "neutral"}>{integration.status}</Badge>
          {integration.hasSecret ? " · API token on file" : " · no API token saved yet"}
        </p>
      )}

      <section>
        <h2>Connection</h2>
        <form onSubmit={handleSave}>
          <label>
            Chatwoot base URL
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://chat.yourcompany.example" required />
          </label>
          <label>
            Account ID
            <input value={accountId} onChange={(e) => setAccountId(e.target.value)} placeholder="1" required />
          </label>
          <label>
            Website token (public widget identifier)
            <input value={websiteToken} onChange={(e) => setWebsiteToken(e.target.value)} placeholder="abc123" />
          </label>
          <label>
            API access token {integration?.hasSecret ? "(leave blank to keep existing)" : ""}
            <input
              type="password"
              value={apiAccessToken}
              onChange={(e) => setApiAccessToken(e.target.value)}
              placeholder={integration?.hasSecret ? "••••••••" : "Chatwoot user/agent-bot access token"}
            />
          </label>
          {saveError && <ErrorBanner message={saveError} />}
          <button type="submit" disabled={saving}>
            {saving ? "Saving..." : "Save connection"}
          </button>
        </form>
        <button type="button" onClick={handleHealthCheck} disabled={healthChecking}>
          {healthChecking ? "Checking..." : "Run health check"}
        </button>
        {healthResult && <p>{healthResult}</p>}
      </section>

      <section>
        <h2>Website widget embed snippet</h2>
        <p>Paste this on any customer-facing page to show Chatwoot's live-chat bubble.</p>
        <button type="button" onClick={handleLoadSnippet}>
          Get embed snippet
        </button>
        {snippetError && <ErrorBanner message={snippetError} />}
        {snippet && (
          <>
            <pre>{snippet}</pre>
            <button type="button" onClick={handleCopySnippet}>
              {copied ? "Copied!" : "Copy to clipboard"}
            </button>
          </>
        )}
      </section>

      <section>
        <h2>Recent conversations</h2>
        <button type="button" onClick={handleLoadConversations}>
          Refresh
        </button>
        {conversationsError && <ErrorBanner message={conversationsError} />}
        {conversations && conversations.length === 0 && !conversationsError && <p>No conversations yet.</p>}
        {conversations && conversations.length > 0 && (
          <ul>
            {conversations.map((c) => (
              <li key={c.id}>
                Conversation #{c.id} {c.status && <Badge tone="neutral">{c.status}</Badge>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </Layout>
  );
}
