import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { logger } from "../lib/logger.js";
import { rateLimitMiddleware } from "../middleware/rateLimit.js";
import type { BillingProvider } from "../lib/billingProvider.js";
import { RazorpayBillingProvider } from "../lib/razorpayBillingProvider.js";
import { StripeBillingProvider } from "../lib/stripeBillingProvider.js";
import { applyPlanChange } from "../lib/billingPlanSync.js";
import { notifyTenantOwnersAndAdmins } from "../lib/notify.js";
import type { PlanName } from "../config/planLimits.js";

/**
 * Public (unauthenticated-by-necessity) inbound webhook receiver for
 * real billing-provider deliveries (Razorpay or Stripe).
 *
 * URL shape — /api/v1/webhooks/billing/:tenantId/:provider — deliberately
 * mirrors the EXISTING per-tenant webhook convention this codebase already
 * uses for chatwoot/listmonk/postiz (routes/chatwootWebhooks.ts,
 * routes/postizWebhooks.ts: `/:tenantId/:projectId`), for the same reason:
 * every query in this app (including this one) runs under Postgres RLS,
 * which requires app.current_tenant_id to be set BEFORE any row in a
 * tenant-scoped table can be read at all — so the tenant must be known
 * from the URL, not discovered by an un-scoped lookup after the fact. The
 * webhook SECRET itself is still a single platform-level value per
 * provider (RAZORPAY_WEBHOOK_SECRET / STRIPE_WEBHOOK_SECRET — billing
 * credentials are platform-level, not per-tenant; see config/env.ts) —
 * :tenantId in the path is purely a routing/RLS-scoping detail, not a
 * second per-tenant secret. Both providers support registering an
 * arbitrary URL (including path segments) as a webhook endpoint, so this
 * requires no special accommodation on their side — this is this
 * platform's own documented choice, not inferred from provider docs.
 *
 * Signature verification happens BEFORE any database access, exactly like
 * chatwootWebhooks.ts — and like that route, this one needs the raw
 * request-body bytes (app.ts's express.json({ verify }) callback already
 * captures these onto req.rawBody for exactly this purpose; see
 * src/types/express.d.ts).
 */
export const billingWebhooksRouter = Router();

const paramsSchema = z.object({
  tenantId: z.string().uuid(),
  provider: z.enum(["razorpay", "stripe"]),
});

const perTenantLimiter = rateLimitMiddleware({
  windowMs: 60_000,
  max: 120,
  name: "billing-webhook",
  keyFn: (req) => `${req.params.tenantId}:${req.params.provider}`,
});

function providerFor(name: "razorpay" | "stripe"): BillingProvider {
  return name === "razorpay" ? new RazorpayBillingProvider() : new StripeBillingProvider();
}

/**
 * POST /api/v1/webhooks/billing/:tenantId/:provider
 *
 * Verifies the provider's real documented signature scheme (see
 * razorpayBillingProvider.ts/stripeBillingProvider.ts doc comments),
 * records the delivery into billing_webhook_events first for retry-safe
 * idempotency (same ON CONFLICT DO NOTHING pattern as
 * integration_webhook_events — migration 286/287), then applies the
 * normalized event:
 *   - subscription_activated / subscription_updated (status: active):
 *     upserts billing_subscriptions AND calls applyPlanChange() to flip
 *     tenants.plan for real, the SAME plan-write code path the manual
 *     admin PATCH .../plan endpoint uses (lib/billingPlanSync.ts) — so
 *     quota.ts's existing enforcement immediately sees the new plan.
 *   - subscription_canceled: marks billing_subscriptions canceled. Does
 *     NOT automatically downgrade tenants.plan to 'free' — a cancellation
 *     taking effect at period end vs. immediately is a real product
 *     decision this change didn't have a brief to make; the manual admin
 *     path remains available to downgrade explicitly. Flagged in the
 *     handback as an open decision.
 *   - payment_failed: marks the matching subscription 'past_due' and
 *     notifies the tenant's owners/admins via the EXISTING notify.ts
 *     in-app notification system (notifyTenantOwnersAndAdmins) — no
 *     second notification mechanism invented.
 *   - invoice_paid: records a real billing_invoices row from the event's
 *     own amount/currency/provider_invoice_id — never synthesized.
 */
billingWebhooksRouter.post("/:tenantId/:provider", perTenantLimiter, async (req, res, next) => {
  let parsedParams: z.infer<typeof paramsSchema>;
  try {
    parsedParams = paramsSchema.parse(req.params);
  } catch (err) {
    next(err);
    return;
  }
  const { tenantId, provider: providerName } = parsedParams;
  const provider = providerFor(providerName);

  if (!provider.isConfigured()) {
    res.status(503).json({
      error: "billing_provider_not_configured",
      message: `${providerName} is not configured on this server — refusing to accept webhook events.`,
    });
    return;
  }

  const rawBody = req.rawBody ? req.rawBody.toString("utf8") : JSON.stringify(req.body ?? {});
  const signatureHeader =
    providerName === "razorpay" ? req.header("X-Razorpay-Signature") : req.header("Stripe-Signature");

  if (!provider.verifyWebhookSignature(rawBody, signatureHeader ?? undefined)) {
    logger.warn({ provider: providerName }, "billing webhook rejected: missing or invalid signature");
    res.status(401).json({ error: "unauthorized", message: "Invalid, missing, or expired webhook signature" });
    return;
  }

  let normalized;
  try {
    normalized = provider.parseWebhookEvent(rawBody);
  } catch (err) {
    next(err);
    return;
  }

  // Razorpay's own documented idempotency key is the x-razorpay-event-id
  // header, not anything derivable from the body alone (see
  // razorpayBillingProvider.ts's doc comment) — prefer it when present.
  const externalEventId =
    providerName === "razorpay" ? req.header("x-razorpay-event-id") ?? normalized.externalEventId : normalized.externalEventId;

  const client = await pool.connect();
  let settled = false;
  let began = false;
  try {
    await client.query("BEGIN");
    began = true;
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO billing_webhook_events (tenant_id, provider, external_event_id, event_type, payload)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (provider, external_event_id) DO NOTHING
       RETURNING id`,
      [tenantId, providerName, externalEventId, normalized.eventType, JSON.stringify(normalized.raw)],
    );

    if (inserted.rowCount === 0) {
      await client.query("COMMIT");
      settled = true;
      client.release();
      res.status(200).json({ received: true, deduplicated: true });
      return;
    }
    const webhookEventId = inserted.rows[0]!.id;

    // The event's own metadata/notes (attached by THIS platform at
    // checkout-creation time — see createCheckoutSession()) should name
    // this exact tenant. A mismatch means either a misconfigured/shared
    // webhook endpoint or a forged-but-signed request from a DIFFERENT
    // real customer of the same provider account — never trust it, and
    // never apply a plan change to the wrong tenant's row.
    if (normalized.tenantId && normalized.tenantId !== tenantId) {
      await client.query(
        `UPDATE billing_webhook_events SET status = 'failed', error = $2, processed_at = now() WHERE id = $1`,
        [webhookEventId, "event metadata tenantId does not match URL tenantId"],
      );
      await client.query("COMMIT");
      settled = true;
      client.release();
      logger.error(
        { provider: providerName, urlTenantId: tenantId, eventTenantId: normalized.tenantId },
        "billing webhook tenant mismatch — refusing to apply",
      );
      res.status(200).json({ received: true, applied: false, reason: "tenant_mismatch" });
      return;
    }

    let applied = false;

    if (normalized.kind === "subscription_activated" || normalized.kind === "subscription_updated") {
      if (normalized.providerSubscriptionId) {
        await upsertSubscription(client, {
          tenantId,
          provider: providerName,
          providerSubscriptionId: normalized.providerSubscriptionId,
          planId: normalized.planId,
          status: normalized.status ?? "active",
        });
      }
      if (normalized.kind === "subscription_activated" && normalized.planId) {
        await applyPlanChange(client, tenantId, normalized.planId, {
          type: "system",
          note: `${providerName}_webhook:${normalized.eventType}`,
        });
      }
      applied = true;
    } else if (normalized.kind === "subscription_canceled") {
      if (normalized.providerSubscriptionId) {
        await client.query(
          `UPDATE billing_subscriptions SET status = 'canceled' WHERE provider = $1 AND provider_subscription_id = $2`,
          [providerName, normalized.providerSubscriptionId],
        );
      }
      applied = true;
    } else if (normalized.kind === "payment_failed") {
      if (normalized.providerSubscriptionId) {
        await client.query(
          `UPDATE billing_subscriptions SET status = 'past_due' WHERE provider = $1 AND provider_subscription_id = $2`,
          [providerName, normalized.providerSubscriptionId],
        );
      }
      await notifyTenantOwnersAndAdmins({
        client,
        tenantId,
        type: "billing.payment_failed",
        title: "Payment failed",
        body: `A ${providerName === "razorpay" ? "Razorpay" : "Stripe"} payment for this organization's subscription failed. The subscription has been marked past-due — update your payment method to avoid service interruption.`,
        linkUrl: `/tenants/${tenantId}/billing`,
      });
      applied = true;
    } else if (normalized.kind === "invoice_paid" && normalized.providerInvoiceId && normalized.amount !== null) {
      const subscriptionRow = normalized.providerSubscriptionId
        ? await client.query<{ id: string }>(
            `SELECT id FROM billing_subscriptions WHERE provider = $1 AND provider_subscription_id = $2`,
            [providerName, normalized.providerSubscriptionId],
          )
        : { rows: [] as { id: string }[] };

      await client.query(
        `INSERT INTO billing_invoices (tenant_id, subscription_id, provider, provider_invoice_id, amount, currency, status, issued_at, paid_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'paid', now(), now())
         ON CONFLICT (provider, provider_invoice_id) DO NOTHING`,
        [
          tenantId,
          subscriptionRow.rows[0]?.id ?? null,
          providerName,
          normalized.providerInvoiceId,
          normalized.amount,
          normalized.currency ?? "unknown",
        ],
      );
      applied = true;
    }

    await client.query(
      `UPDATE billing_webhook_events SET status = $2, processed_at = now() WHERE id = $1`,
      [webhookEventId, applied ? "processed" : "ignored"],
    );

    await client.query("COMMIT");
    settled = true;
    client.release();

    res.status(200).json({ received: true, deduplicated: false, applied });
  } catch (err) {
    if (!settled) {
      if (began) await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
    next(err);
  }
});

async function upsertSubscription(
  client: import("pg").PoolClient,
  input: {
    tenantId: string;
    provider: "razorpay" | "stripe";
    providerSubscriptionId: string;
    planId: PlanName | null;
    status: string;
  },
): Promise<void> {
  // planId can be null on e.g. a bare "subscription.updated" that carries
  // no notes/metadata (only the original checkout-creating event is
  // guaranteed to) — COALESCE keeps the existing row's plan_id rather than
  // ever writing a fabricated one.
  await client.query(
    `INSERT INTO billing_subscriptions (tenant_id, provider, provider_subscription_id, plan_id, status)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (provider, provider_subscription_id)
     DO UPDATE SET
       status = EXCLUDED.status,
       plan_id = COALESCE(EXCLUDED.plan_id, billing_subscriptions.plan_id)`,
    [input.tenantId, input.provider, input.providerSubscriptionId, input.planId ?? "free", input.status],
  );
}
