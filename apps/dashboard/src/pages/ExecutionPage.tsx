import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { Layout } from "../components/Layout";
import { ErrorBanner } from "../components/ErrorBanner";
import { Badge, statusTone } from "../components/Badge";
import { api, ApiError } from "../api/client";
import type { ExecutionDetail } from "../api/types";

const POLL_INTERVAL_MS = 2000;
const TERMINAL_STATUSES = new Set(["succeeded", "failed", "needs_approval"]);

export function ExecutionPage() {
  const { tenantId, executionId } = useParams<{ tenantId: string; executionId: string }>();
  const [execution, setExecution] = useState<ExecutionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      if (!tenantId || !executionId) return;
      try {
        const res = await api.get<ExecutionDetail>(`/tenants/${tenantId}/agent-executions/${executionId}`);
        if (cancelled) return;
        setExecution(res);
        setError(null);
        if (!TERMINAL_STATUSES.has(res.status)) {
          timerRef.current = window.setTimeout(poll, POLL_INTERVAL_MS);
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : "Could not load this execution.");
      }
    }

    poll();
    return () => {
      cancelled = true;
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, [tenantId, executionId]);

  return (
    <Layout crumbs={[{ label: "Organizations", to: "/" }, { label: "Execution" }]}>
      <section className="panel">
        <h1>Execution</h1>
        <p className="muted">
          <code>{executionId}</code>
        </p>
        {execution ? <p className="muted hint">Agent instance: {execution.agentInstanceId}</p> : null}

        <ErrorBanner message={error} />

        {!execution ? (
          <p className="muted">Loading...</p>
        ) : (
          <>
            <p>
              Status: <Badge tone={statusTone(execution.status)}>{execution.status}</Badge>
              {!TERMINAL_STATUSES.has(execution.status) ? (
                <span className="muted"> — checking again every {POLL_INTERVAL_MS / 1000}s...</span>
              ) : null}
            </p>

            {execution.status === "failed" && execution.error ? (
              <div className="error-banner" role="alert">
                {execution.error.message}
              </div>
            ) : null}

            {execution.status === "needs_approval" ? (
              <p className="muted">
                This run needs a human decision before continuing. Check the approvals queue for this organization.
              </p>
            ) : null}

            {execution.status === "succeeded" && execution.result !== undefined ? (
              <div>
                <h2>Result</h2>
                <pre className="result-block">{JSON.stringify(execution.result, null, 2)}</pre>
              </div>
            ) : null}
          </>
        )}
      </section>
    </Layout>
  );
}
