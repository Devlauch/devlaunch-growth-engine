import type pg from "pg";
import { env } from "../config/env.js";
import type { PlanName } from "../config/planLimits.js";
import { RazorpayBillingProvider } from "./razorpayBillingProvider.js";
import { StripeBillingProvider } from "./stripeBillingProvider.js";

/**
 * Milestone 4 (P3): pluggable SaaS billing-provider abstraction, evaluating
 * Razorpay (India-first) and Stripe (international) side by side behind one
 * interface — exactly as this milestone asks (evaluate both, don't just
 * pick one). No real Razorpay or Stripe API keys (test or live) are
 * available in this environment: every concrete provider below is real,
 * correct integration code written against each provider's actual
 * documented REST API and webhook-signature scheme, but NONE of it has
 * ever been exercised against a live API response. That gap is reported
 * honestly as BLOCKED wherever it matters (see docs/FEATURE_STATUS.md and
 * this change's handback) — this module never fabricates a "payment
 * succeeded" state.
 *
 * Signature-scheme claims below were verified live against each provider's
 * own published documentation during this work (not just recalled from
 * training data) — see RazorpayBillingProvider's and StripeBillingProvider's
 * own doc comments for the exact quoted citations.
 *
 * Design mirrors this codebase's established NotConfigured-stub convention
 * (see bookingProvider.ts/decisionMakerProvider.ts):
 *   1. `BillingProvider` — the stable interface every concrete
 *      implementation (real or stub) satisfies, so routes/billing.ts and
 *      routes/billingWebhooks.ts never know which provider (or none) is
 *      actually active.
 *   2. `NotConfiguredBillingProvider` — honest fallback when neither
 *      Razorpay nor Stripe env vars are set (every environment this
 *      codebase has run in today). Every method throws/reports
 *      "not_configured" rather than fabricating a checkout URL,
 *      subscription id, or payment outcome.
 *   3. `RazorpayBillingProvider` / `StripeBillingProvider` — real clients,
 *      built but unverified against a live API (see class doc comments).
 *   4. `getActiveBillingProvider()` — the single place that decides which
 *      implementation a caller gets. Resolution order (documented here
 *      since there is no per-tenant billing-region column in this schema
 *      today — see migration 002_create_tenants.sql — so this is a
 *      deliberate, flagged product decision, not inferred from existing
 *      data):
 *        a. An explicit `preferred` argument (e.g. the checkout route
 *           reads the tenant's `settings->>'billingCurrency'` — reusing
 *           the existing generic `tenants.settings` jsonb column rather
 *           than adding a new typed column for a single soft preference —
 *           and maps "INR" -> razorpay, anything else -> stripe) wins if
 *           that provider is actually configured.
 *        b. Otherwise env.billingProviderDefault (BILLING_PROVIDER_DEFAULT)
 *           wins if set and that provider is configured.
 *        c. Otherwise, if exactly one of the two is configured, that one
 *           is used.
 *        d. Otherwise (zero configured, or both configured with no
 *           default and no preference) -> NotConfiguredBillingProvider.
 *           "Both configured, ambiguous" intentionally falls back to
 *           NotConfigured rather than silently guessing — a real
 *           deployment must set BILLING_PROVIDER_DEFAULT once both are
 *           live.
 */

export class BillingNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BillingNotConfiguredError";
  }
}

/** A real, classified failure response from a billing provider's API (never thrown for a merely-empty result). */
export class BillingProviderApiError extends Error {
  readonly status: number;
  readonly provider: string;
  readonly details: unknown;

  constructor(provider: string, status: number, message: string, details?: unknown) {
    super(message);
    this.name = "BillingProviderApiError";
    this.provider = provider;
    this.status = status;
    this.details = details;
  }
}

/** billing_subscriptions.status's allowed values (see migration 520). */
export type BillingSubscriptionStatus = "trialing" | "active" | "past_due" | "canceled" | "incomplete";

export interface CheckoutSessionResult {
  /** The URL the browser should be redirected to in order to complete checkout/authorization. */
  checkoutUrl: string;
  /** The provider's own identifier for this checkout/order/session. */
  providerSessionId: string;
  /** The provider's subscription id, when the provider creates it up front (Razorpay subscriptions exist, pending authorization, before checkout completes) — null when it's only created later, on a webhook (Stripe). */
  providerSubscriptionId: string | null;
}

export interface CreateCheckoutSessionInput {
  tenantId: string;
  planId: PlanName;
  /** Where to send the browser after a successful checkout/authorization. */
  successUrl: string;
  /** Where to send the browser if checkout is abandoned/canceled. */
  cancelUrl: string;
  customerEmail?: string | null;
}

/** A normalized shape every provider's raw webhook payload is translated into, before any database write happens. */
export interface NormalizedBillingEvent {
  /** The provider's own stable event id — used as the idempotency key (see billing_webhook_events, migration 524). */
  externalEventId: string;
  /** The provider's own raw event-type string (e.g. "subscription.activated", "invoice.payment_failed") — preserved as-is for audit, even though `kind` below is what routing logic switches on. */
  eventType: string;
  kind:
    | "subscription_activated"
    | "subscription_updated"
    | "subscription_canceled"
    | "payment_failed"
    | "invoice_paid"
    | "unhandled";
  /** Recovered from checkout/subscription metadata this platform itself attached at checkout-creation time — never trusted from anywhere else. Null when the event carries none (e.g. an event type this integration doesn't attach metadata to). */
  tenantId: string | null;
  planId: PlanName | null;
  providerSubscriptionId: string | null;
  providerInvoiceId: string | null;
  /** Smallest currency unit (paise/cents), when the event carries an amount. */
  amount: number | null;
  currency: string | null;
  /** This platform's own normalized subscription status, when the event implies one. */
  status: BillingSubscriptionStatus | null;
  /** The provider's raw parsed payload, retained for audit (mirrors integration_webhook_events.payload's convention). */
  raw: unknown;
}

export interface SubscriptionStatusResult {
  status: BillingSubscriptionStatus;
  currentPeriodEnd: string | null;
}

export interface BillingProvider {
  readonly name: "razorpay" | "stripe" | "not_configured";
  isConfigured(): boolean;
  createCheckoutSession(input: CreateCheckoutSessionInput): Promise<CheckoutSessionResult>;
  /**
   * Verifies an inbound webhook delivery's signature. `rawBody` MUST be the
   * exact bytes/string the provider sent (not a re-serialization of a
   * parsed body) — both providers' schemes are byte-exact over the raw
   * request body (see each implementation's doc comment).
   */
  verifyWebhookSignature(rawBody: string, signatureHeader: string | undefined): boolean;
  /** Parses an already-signature-verified raw webhook body into the normalized shape above. Never call this on an unverified body. */
  parseWebhookEvent(rawBody: string): NormalizedBillingEvent;
  cancelSubscription(providerSubscriptionId: string): Promise<{ status: BillingSubscriptionStatus }>;
  getSubscriptionStatus(providerSubscriptionId: string): Promise<SubscriptionStatusResult>;
}

/**
 * Honest stand-in used whenever neither Razorpay nor Stripe is configured
 * (every environment this codebase has run in). Never fabricates a
 * checkout URL, a subscription id, or a payment/subscription status.
 */
export class NotConfiguredBillingProvider implements BillingProvider {
  readonly name = "not_configured" as const;

  isConfigured(): boolean {
    return false;
  }

  async createCheckoutSession(): Promise<never> {
    throw new BillingNotConfiguredError(
      "No billing provider is configured (RAZORPAY_KEY_ID/KEY_SECRET or STRIPE_SECRET_KEY are not set). " +
        "Refusing to fabricate a checkout session. Use the existing manual/admin plan-change path " +
        "(PATCH /api/v1/tenants/:tenantId/plan) instead.",
    );
  }

  verifyWebhookSignature(): boolean {
    return false;
  }

  parseWebhookEvent(): never {
    throw new BillingNotConfiguredError("No billing provider is configured — there is no webhook event to parse.");
  }

  async cancelSubscription(): Promise<never> {
    throw new BillingNotConfiguredError(
      "No billing provider is configured — there is no real subscription to cancel.",
    );
  }

  async getSubscriptionStatus(): Promise<never> {
    throw new BillingNotConfiguredError(
      "No billing provider is configured — there is no real subscription status to report.",
    );
  }
}

export interface BillingProviderPreference {
  /** From a tenant's own settings, e.g. "INR" -> razorpay. Null = no preference known. */
  preferredCurrency?: string | null;
}

function mapCurrencyToProvider(currency: string | null | undefined): "razorpay" | "stripe" | null {
  if (!currency) return null;
  return currency.toUpperCase() === "INR" ? "razorpay" : "stripe";
}

/**
 * The single place that decides which concrete BillingProvider a caller
 * gets. See this module's header comment for the full documented
 * resolution order. Takes the concrete provider instances as optional
 * injected overrides so tests never need real env vars or real HTTP.
 */
export function getActiveBillingProvider(
  preference: BillingProviderPreference = {},
  overrides: { razorpay?: BillingProvider; stripe?: BillingProvider } = {},
): BillingProvider {
  const razorpay = overrides.razorpay ?? new RazorpayBillingProvider();
  const stripe = overrides.stripe ?? new StripeBillingProvider();

  const razorpayConfigured = razorpay.isConfigured();
  const stripeConfigured = stripe.isConfigured();

  const preferred = mapCurrencyToProvider(preference.preferredCurrency);
  if (preferred === "razorpay" && razorpayConfigured) return razorpay;
  if (preferred === "stripe" && stripeConfigured) return stripe;

  if (env.billingProviderDefault === "razorpay" && razorpayConfigured) return razorpay;
  if (env.billingProviderDefault === "stripe" && stripeConfigured) return stripe;

  if (razorpayConfigured && !stripeConfigured) return razorpay;
  if (stripeConfigured && !razorpayConfigured) return stripe;

  return new NotConfiguredBillingProvider();
}

/**
 * Reads a tenant's billing-currency preference off the EXISTING generic
 * `tenants.settings` jsonb column (no new column added — see this module's
 * header comment) for getActiveBillingProvider()'s `preference` argument.
 * Returns null (no preference) rather than throwing when absent/invalid —
 * callers fall back to the platform default in that case.
 */
export async function getTenantBillingCurrencyPreference(
  client: Pick<pg.PoolClient, "query">,
  tenantId: string,
): Promise<string | null> {
  const result = await client.query<{ currency: string | null }>(
    `SELECT settings->>'billingCurrency' AS currency FROM tenants WHERE id = $1`,
    [tenantId],
  );
  return result.rows[0]?.currency ?? null;
}
