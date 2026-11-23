import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { Errors } from "../lib/httpError.js";
import { env } from "../config/env.js";
import { PLAN_NAMES } from "../config/planLimits.js";
import {
  getActiveBillingProvider,
  getTenantBillingCurrencyPreference,
  BillingNotConfiguredError,
  BillingProviderApiError,
  type BillingProvider,
} from "../lib/billingProvider.js";
import { RazorpayBillingProvider } from "../lib/razorpayBillingProvider.js";
import { StripeBillingProvider } from "../lib/stripeBillingProvider.js";
import { listUnbilledOverageEvents } from "../lib/billingOverage.js";

function providerByName(name: "razorpay" | "stripe"): BillingProvider {
  return name === "razorpay" ? new RazorpayBillingProvider() : new StripeBillingProvider();
}

/**
 * Milestone 4 (P3): tenant-facing real SaaS billing endpoints. Mounted at
 * /api/v1/tenants/:tenantId/billing — see this change's handback for the
 * exact app.ts wiring line (app.ts is not edited by this change, per
 * instructions).
 *
 * Every endpoint here honestly reports `not_configured` (never a
 * fabricated checkout URL/subscription/invoice) when no real billing
 * provider is set up — which is every environment this codebase has run
 * in. The existing manual/admin plan-change path
 * (PATCH /api/v1/tenants/:tenantId/plan, routes/planUsage.ts) keeps
 * working unchanged as the fallback/override.
 *
 * Same local owner/admin role gate as routes/planUsage.ts (no shared RBAC
 * helper exists yet in this codebase).
 */
export const billingRouter = Router({ mergeParams: true });
billingRouter.use(requireAuth, requireTenantMembership);

function requireRole(req: import("express").Request, allowed: readonly string[]) {
  if (req.isPlatformAdmin) return;
  if (!req.membershipRole || !allowed.includes(req.membershipRole)) {
    throw Errors.forbidden(`Requires one of role: ${allowed.join(", ")}`);
  }
}

/**
 * GET /api/v1/tenants/:tenantId/billing
 *
 * Which provider is currently active for this tenant (per
 * getActiveBillingProvider()'s real resolution order), its configured
 * status, the tenant's most recent real billing_subscriptions row (if
 * any), and any real unbilled overage events (see billingOverage.ts).
 */
billingRouter.get("/", async (req, res, next) => {
  try {
    const currency = await getTenantBillingCurrencyPreference(req.tenantDb!, req.tenantId as string);
    const provider = getActiveBillingProvider({ preferredCurrency: currency });

    const subscriptionResult = await req.tenantDb!.query(
      `SELECT provider, provider_subscription_id, plan_id, status, current_period_end, created_at, updated_at
       FROM billing_subscriptions
       WHERE tenant_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [req.tenantId],
    );

    const overageEvents = await listUnbilledOverageEvents(req.tenantDb!, req.tenantId as string);

    res.json({
      activeProvider: provider.name,
      providerConfigured: provider.isConfigured(),
      subscription: subscriptionResult.rows[0] ?? null,
      unbilledOverageEvents: overageEvents,
    });
  } catch (err) {
    next(err);
  }
});

const checkoutSchema = z.object({
  planId: z.enum(PLAN_NAMES),
  // Optional per-request override of the auto-resolved provider — lets a
  // tenant explicitly pick (e.g. an India-based customer who wants
  // Razorpay even though BILLING_PROVIDER_DEFAULT is "stripe").
  provider: z.enum(["razorpay", "stripe"]).optional(),
});

/**
 * POST /api/v1/tenants/:tenantId/billing/checkout — owner-only.
 *
 * Creates a REAL checkout session via whichever billing provider resolves
 * for this tenant (see getActiveBillingProvider()'s documented resolution
 * order). 501s with `not_configured` — never a fabricated checkout URL —
 * when no real provider is set up, which is every environment this
 * codebase has been run in.
 */
billingRouter.post("/checkout", async (req, res, next) => {
  try {
    requireRole(req, ["owner"]);
    const body = checkoutSchema.parse(req.body);

    if (body.planId === "free") {
      throw Errors.badRequest("The free plan has no checkout — use PATCH .../plan to move a tenant to free directly.");
    }

    const currency = await getTenantBillingCurrencyPreference(req.tenantDb!, req.tenantId as string);
    const provider = body.provider
      ? getActiveBillingProvider({ preferredCurrency: body.provider === "razorpay" ? "INR" : "USD" })
      : getActiveBillingProvider({ preferredCurrency: currency });

    if (!provider.isConfigured()) {
      res.status(501).json({
        error: "not_configured",
        message:
          "No real billing provider is configured on this server (RAZORPAY_KEY_ID/KEY_SECRET or STRIPE_SECRET_KEY " +
          "are not set). Use the existing manual/admin plan-change path instead: " +
          "PATCH /api/v1/tenants/:tenantId/plan.",
      });
      return;
    }

    const membershipRow = await req.tenantDb!.query<{ email: string | null }>(
      `SELECT u.email FROM users u WHERE u.id = $1`,
      [req.userId],
    );

    const session = await provider.createCheckoutSession({
      tenantId: req.tenantId as string,
      planId: body.planId,
      successUrl: `${env.dashboardBaseUrl}/tenants/${req.tenantId}/billing?checkout=success`,
      cancelUrl: `${env.dashboardBaseUrl}/tenants/${req.tenantId}/billing?checkout=canceled`,
      customerEmail: membershipRow.rows[0]?.email ?? null,
    });

    res.json({
      provider: provider.name,
      checkoutUrl: session.checkoutUrl,
      providerSessionId: session.providerSessionId,
    });
  } catch (err) {
    if (err instanceof BillingNotConfiguredError) {
      res.status(501).json({ error: "not_configured", message: err.message });
      return;
    }
    if (err instanceof BillingProviderApiError) {
      next(Errors.badGateway(err.message));
      return;
    }
    next(err);
  }
});

/**
 * POST /api/v1/tenants/:tenantId/billing/cancel — owner-only.
 *
 * Cancels the tenant's real subscription via the SAME provider the
 * subscription was created with (billing_subscriptions.provider — not
 * whatever getActiveBillingProvider() would resolve to today, which could
 * have drifted since checkout). Gracefully reports not_configured if
 * there is no real subscription row, rather than pretending one was
 * canceled.
 */
billingRouter.post("/cancel", async (req, res, next) => {
  try {
    requireRole(req, ["owner"]);

    const subscriptionResult = await req.tenantDb!.query<{
      provider: "razorpay" | "stripe";
      provider_subscription_id: string;
    }>(
      `SELECT provider, provider_subscription_id FROM billing_subscriptions
       WHERE tenant_id = $1 AND status NOT IN ('canceled')
       ORDER BY created_at DESC LIMIT 1`,
      [req.tenantId],
    );

    if (subscriptionResult.rowCount === 0) {
      res.status(404).json({
        error: "no_active_subscription",
        message:
          "No active real billing-provider subscription is on record for this tenant. If a plan change was made " +
          "manually (PATCH .../plan), there is nothing to cancel via a provider.",
      });
      return;
    }

    const row = subscriptionResult.rows[0]!;
    const provider = providerByName(row.provider);

    if (!provider.isConfigured()) {
      res.status(501).json({
        error: "not_configured",
        message: `This tenant's subscription was created via ${row.provider}, which is no longer configured on this server. Cannot call its cancel API for real — use the manual/admin plan-change path instead.`,
      });
      return;
    }

    const result = await provider.cancelSubscription(row.provider_subscription_id);

    await req.tenantDb!.query(
      `UPDATE billing_subscriptions SET status = $3 WHERE provider = $1 AND provider_subscription_id = $2`,
      [row.provider, row.provider_subscription_id, result.status],
    );

    res.json({ provider: row.provider, status: result.status });
  } catch (err) {
    if (err instanceof BillingNotConfiguredError) {
      res.status(501).json({ error: "not_configured", message: err.message });
      return;
    }
    if (err instanceof BillingProviderApiError) {
      next(Errors.badGateway(err.message));
      return;
    }
    next(err);
  }
});

const invoicesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
});

/**
 * GET /api/v1/tenants/:tenantId/billing/invoices
 *
 * Real invoice records only — populated solely from real webhook events
 * (routes/billingWebhooks.ts's invoice_paid handling). Never synthesizes
 * an invoice.
 */
billingRouter.get("/invoices", async (req, res, next) => {
  try {
    const query = invoicesQuerySchema.parse(req.query);
    const result = await req.tenantDb!.query(
      `SELECT id, provider, provider_invoice_id, amount, currency, status, issued_at, paid_at
       FROM billing_invoices
       WHERE tenant_id = $1
       ORDER BY issued_at DESC
       LIMIT $2`,
      [req.tenantId, query.limit],
    );
    res.json({ invoices: result.rows });
  } catch (err) {
    next(err);
  }
});
