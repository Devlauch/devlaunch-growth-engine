import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Layout } from "../components/Layout";
import { ErrorBanner } from "../components/ErrorBanner";
import { Badge } from "../components/Badge";
import { api, ApiError } from "../api/client";
import type {
  BillingInvoice,
  BillingStatusResponse,
  PlanName,
  Tenant,
} from "../api/types";

/**
 * Milestone 4 (P3): real SaaS billing page, complementary to
 * PlanUsagePage.tsx (NOT a replacement — that page's manual/admin
 * plan-change flow keeps working exactly as before; this page is the
 * real checkout/subscription/invoice surface layered on top of it).
 *
 * No real Razorpay or Stripe account exists in this environment — every
 * state this page can show (not_configured, a real subscription, a real
 * invoice list) comes straight from GET .../billing's real response.
 * Nothing here is ever fabricated client-side.
 */

const PLAN_LABELS: Record<PlanName, string> = {
  free: "Free",
  starter: "Starter",
  growth: "Growth",
  enterprise: "Enterprise",
};

const PAYABLE_PLANS: PlanName[] = ["starter", "growth", "enterprise"];

function statusTone(status: string): "neutral" | "info" | "success" | "danger" {
  switch (status) {
    case "active":
      return "success";
    case "trialing":
      return "info";
    case "past_due":
    case "incomplete":
      return "danger";
    default:
      return "neutral";
  }
}

function formatAmount(amount: number, currency: string): string {
  // amount is always the smallest currency unit (paise/cents — see
  // billing_invoices.amount's own doc comment, migration 522), never a
  // float — divide by 100 only for display, never stored this way.
  return `${(amount / 100).toFixed(2)} ${currency.toUpperCase()}`;
}

export function BillingPage() {
  const { tenantId } = useParams<{ tenantId: string }>();

  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [billing, setBilling] = useState<BillingStatusResponse | null>(null);
  const [invoices, setInvoices] = useState<BillingInvoice[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState(false);

  const load = useCallback(async () => {
    if (!tenantId) return;
    try {
      const [tenantRes, billingRes, invoicesRes] = await Promise.all([
        api.get<{ tenant: Tenant; role: string }>(`/tenants/${tenantId}`),
        api.get<BillingStatusResponse>(`/tenants/${tenantId}/billing`),
        api.get<{ invoices: BillingInvoice[] }>(`/tenants/${tenantId}/billing/invoices`),
      ]);
      setTenant(tenantRes.tenant);
      setBilling(billingRes);
      setInvoices(invoicesRes.invoices);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Could not load billing information for this organization.");
    }
  }, [tenantId]);

  useEffect(() => {
    load();
  }, [load]);

  async function startCheckout(planId: PlanName) {
    if (!tenantId) return;
    setActionPending(true);
    setActionError(null);
    try {
      const res = await api.post<{ checkoutUrl: string }>(`/tenants/${tenantId}/billing/checkout`, { planId });
      window.location.href = res.checkoutUrl;
    } catch (err) {
      if (err instanceof ApiError && err.status === 501) {
        setActionError(
          "No real billing provider (Razorpay or Stripe) is configured on this server yet — self-serve checkout " +
            "isn't available. Use the manual Plan & Usage page, or contact an admin.",
        );
      } else {
        setActionError(err instanceof ApiError ? err.message : "Could not start checkout.");
      }
    } finally {
      setActionPending(false);
    }
  }

  async function cancelSubscription() {
    if (!tenantId) return;
    setActionPending(true);
    setActionError(null);
    try {
      await api.post(`/tenants/${tenantId}/billing/cancel`, {});
      await load();
    } catch (err) {
      if (err instanceof ApiError && (err.status === 501 || err.status === 404)) {
        setActionError(err.message);
      } else {
        setActionError(err instanceof ApiError ? err.message : "Could not cancel the subscription.");
      }
    } finally {
      setActionPending(false);
    }
  }

  const subscription = billing?.subscription ?? null;
  const notConfigured = billing !== null && !billing.providerConfigured;

  return (
    <Layout
      crumbs={[
        { label: "Organizations", to: "/" },
        { label: tenant?.name ?? "...", to: `/tenants/${tenantId}` },
        { label: "Billing" },
      ]}
      tenantName={tenant?.name}
    >
      <ErrorBanner message={loadError} />
      <ErrorBanner message={actionError} />

      <section className="panel">
        <h1>Billing</h1>
        <p className="callout">
          Real subscription and invoice status for this organization — nothing below is estimated or fabricated. See
          the "Plan &amp; Usage" page for current plan limits and real usage counts.
        </p>

        {billing === null ? (
          <p className="muted">Loading...</p>
        ) : notConfigured ? (
          <div className="callout">
            <p>
              No real billing provider (Razorpay or Stripe) is configured on this server. Self-serve checkout and
              cancellation aren't available yet — plan changes go through the existing manual/admin path on the
              "Plan &amp; Usage" page instead.
            </p>
          </div>
        ) : subscription ? (
          <div className="plan-badge-row">
            <Badge tone={statusTone(subscription.status)}>{subscription.status}</Badge>
            <span className="muted">
              {PLAN_LABELS[subscription.plan_id]} plan via {subscription.provider === "razorpay" ? "Razorpay" : "Stripe"}
            </span>
            {subscription.current_period_end && (
              <span className="muted">Renews {new Date(subscription.current_period_end).toLocaleDateString()}</span>
            )}
          </div>
        ) : (
          <p className="muted">No subscription on record yet for this organization.</p>
        )}

        {billing && !notConfigured && (
          <div className="plan-badge-row" style={{ marginTop: "1rem" }}>
            {PAYABLE_PLANS.map((plan) => (
              <button
                key={plan}
                className="btn btn-secondary"
                disabled={actionPending || subscription?.plan_id === plan}
                onClick={() => startCheckout(plan)}
              >
                {subscription ? `Switch to ${PLAN_LABELS[plan]}` : `Subscribe to ${PLAN_LABELS[plan]}`}
              </button>
            ))}
            {subscription && subscription.status !== "canceled" && (
              <button className="btn btn-secondary" disabled={actionPending} onClick={cancelSubscription}>
                Cancel subscription
              </button>
            )}
          </div>
        )}
      </section>

      {billing && billing.unbilledOverageEvents.length > 0 && (
        <section className="panel">
          <h2>Usage overage</h2>
          <p className="callout">
            This organization went over its plan's limit for these resources. Metered overage billing is not yet
            priced in this product — these are recorded for visibility only, not billed.
          </p>
          <ul>
            {billing.unbilledOverageEvents.map((event) => (
              <li key={event.id}>
                {event.resource}: {event.usageAtTime} used against a {event.limitAtTime} limit (
                {new Date(event.recordedAt).toLocaleString()})
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="panel">
        <h2>Invoices</h2>
        {invoices === null ? (
          <p className="muted">Loading...</p>
        ) : invoices.length === 0 ? (
          <p className="muted">No real invoices on record yet for this organization.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Issued</th>
                  <th>Amount</th>
                  <th>Status</th>
                  <th>Provider</th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((invoice) => (
                  <tr key={invoice.id}>
                    <td>{new Date(invoice.issued_at).toLocaleDateString()}</td>
                    <td>{formatAmount(invoice.amount, invoice.currency)}</td>
                    <td>
                      <Badge tone={invoice.status === "paid" ? "success" : invoice.status === "failed" ? "danger" : "neutral"}>
                        {invoice.status}
                      </Badge>
                    </td>
                    <td>{invoice.provider === "razorpay" ? "Razorpay" : "Stripe"}</td>
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
