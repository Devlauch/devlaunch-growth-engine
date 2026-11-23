import { createHmac } from "node:crypto";
import { describe, it, expect, vi, beforeEach } from "vitest";

// Real env.ts (not a partial mock) — same trap PlanUsagePage.ts/
// chatwootWebhooks.test.ts's own comment documents: partially mocking
// config/env.js breaks logger.ts's pino({ level: env.logLevel }) call.
process.env.RAZORPAY_KEY_ID = "rzp_test_key_id";
process.env.RAZORPAY_KEY_SECRET = "rzp_test_key_secret";
process.env.RAZORPAY_WEBHOOK_SECRET = "rzp_test_webhook_secret";
process.env.RAZORPAY_PLAN_ID_STARTER = "plan_starter_123";
process.env.STRIPE_SECRET_KEY = "sk_test_123";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_123";
process.env.STRIPE_PRICE_ID_STARTER = "price_starter_123";

const { RazorpayBillingProvider } = await import("../src/lib/razorpayBillingProvider.js");
const { StripeBillingProvider } = await import("../src/lib/stripeBillingProvider.js");
const { getActiveBillingProvider, NotConfiguredBillingProvider, BillingNotConfiguredError } = await import(
  "../src/lib/billingProvider.js"
);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("RazorpayBillingProvider — webhook signature verification", () => {
  const SECRET = "rzp_test_webhook_secret";

  function sign(body: string, secret = SECRET): string {
    return createHmac("sha256", secret).update(body).digest("hex");
  }

  it("accepts a correctly signed raw body", () => {
    const provider = new RazorpayBillingProvider();
    const body = JSON.stringify({ event: "subscription.activated" });
    expect(provider.verifyWebhookSignature(body, sign(body))).toBe(true);
  });

  it("rejects a tampered body whose signature no longer matches (replay/tamper protection)", () => {
    const provider = new RazorpayBillingProvider();
    const body = JSON.stringify({ event: "subscription.activated" });
    const signature = sign(body);
    const tamperedBody = JSON.stringify({ event: "subscription.activated", amount: 999999 });
    expect(provider.verifyWebhookSignature(tamperedBody, signature)).toBe(false);
  });

  it("rejects a body signed with the wrong secret", () => {
    const provider = new RazorpayBillingProvider();
    const body = JSON.stringify({ event: "subscription.activated" });
    expect(provider.verifyWebhookSignature(body, sign(body, "wrong-secret"))).toBe(false);
  });

  it("rejects when no signature header is present", () => {
    const provider = new RazorpayBillingProvider();
    expect(provider.verifyWebhookSignature("{}", undefined)).toBe(false);
  });

  it("rejects every signature when RAZORPAY_WEBHOOK_SECRET is not configured", () => {
    const originalSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    delete process.env.RAZORPAY_WEBHOOK_SECRET;
    vi.resetModules();
    return import("../src/lib/razorpayBillingProvider.js").then(({ RazorpayBillingProvider: Fresh }) => {
      const provider = new Fresh();
      const body = JSON.stringify({ event: "x" });
      expect(provider.verifyWebhookSignature(body, sign(body))).toBe(false);
      process.env.RAZORPAY_WEBHOOK_SECRET = originalSecret;
    });
  });
});

describe("RazorpayBillingProvider — checkout session creation (mocked HTTP)", () => {
  it("creates a real subscription via POST /v1/subscriptions and returns its short_url as checkoutUrl", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse(200, {
        id: "sub_abc123",
        status: "created",
        short_url: "https://rzp.io/i/testlink",
        notes: { tenantId: "tenant-1", planId: "starter" },
      }),
    );
    const provider = new RazorpayBillingProvider(fetcher);

    const result = await provider.createCheckoutSession({
      tenantId: "tenant-1",
      planId: "starter",
      successUrl: "https://app.example.com/success",
      cancelUrl: "https://app.example.com/cancel",
    });

    expect(result).toEqual({
      checkoutUrl: "https://rzp.io/i/testlink",
      providerSessionId: "sub_abc123",
      providerSubscriptionId: "sub_abc123",
    });

    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://api.razorpay.com/v1/subscriptions");
    expect((init as RequestInit).method).toBe("POST");
    const sentBody = JSON.parse((init as RequestInit).body as string);
    expect(sentBody).toMatchObject({ plan_id: "plan_starter_123", notes: { tenantId: "tenant-1", planId: "starter" } });
  });

  it("throws BillingNotConfiguredError for a plan with no configured Razorpay plan id", async () => {
    const provider = new RazorpayBillingProvider(vi.fn());
    await expect(
      provider.createCheckoutSession({
        tenantId: "tenant-1",
        planId: "growth",
        successUrl: "https://a",
        cancelUrl: "https://b",
      }),
    ).rejects.toThrow(BillingNotConfiguredError);
  });
});

describe("StripeBillingProvider — webhook signature verification", () => {
  const SECRET = "whsec_test_123";

  function sign(body: string, timestamp: number, secret = SECRET): string {
    const hmac = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
    return `t=${timestamp},v1=${hmac}`;
  }

  it("accepts a correctly signed raw body within the tolerance window", () => {
    const provider = new StripeBillingProvider();
    const body = JSON.stringify({ id: "evt_1", type: "invoice.paid" });
    const ts = Math.floor(Date.now() / 1000);
    expect(provider.verifyWebhookSignature(body, sign(body, ts))).toBe(true);
  });

  it("rejects a tampered body whose signature no longer matches", () => {
    const provider = new StripeBillingProvider();
    const body = JSON.stringify({ id: "evt_1", type: "invoice.paid" });
    const ts = Math.floor(Date.now() / 1000);
    const header = sign(body, ts);
    const tamperedBody = JSON.stringify({ id: "evt_1", type: "invoice.paid", amount: 999999 });
    expect(provider.verifyWebhookSignature(tamperedBody, header)).toBe(false);
  });

  it("rejects a stale timestamp outside Stripe's documented 5-minute default tolerance", () => {
    const provider = new StripeBillingProvider();
    const body = JSON.stringify({ id: "evt_1", type: "invoice.paid" });
    const staleTs = Math.floor(Date.now() / 1000) - 10 * 60;
    expect(provider.verifyWebhookSignature(body, sign(body, staleTs))).toBe(false);
  });

  it("accepts when ANY v1 signature in the header matches (secret-rotation support)", () => {
    const provider = new StripeBillingProvider();
    const body = JSON.stringify({ id: "evt_1", type: "invoice.paid" });
    const ts = Math.floor(Date.now() / 1000);
    const goodSig = createHmac("sha256", SECRET).update(`${ts}.${body}`).digest("hex");
    const header = `t=${ts},v1=deadbeef00000000000000000000000000000000000000000000000000000000,v1=${goodSig}`;
    expect(provider.verifyWebhookSignature(body, header)).toBe(true);
  });

  it("rejects malformed header with no t= or v1=", () => {
    const provider = new StripeBillingProvider();
    expect(provider.verifyWebhookSignature("{}", "garbage")).toBe(false);
  });
});

describe("StripeBillingProvider — checkout session creation (mocked HTTP)", () => {
  it("creates a real Checkout Session via POST /v1/checkout/sessions and returns its url", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse(200, {
        id: "cs_test_123",
        url: "https://checkout.stripe.com/c/pay/cs_test_123",
        subscription: null,
      }),
    );
    const provider = new StripeBillingProvider(fetcher);

    const result = await provider.createCheckoutSession({
      tenantId: "tenant-1",
      planId: "starter",
      successUrl: "https://app.example.com/success",
      cancelUrl: "https://app.example.com/cancel",
      customerEmail: "owner@example.com",
    });

    expect(result).toEqual({
      checkoutUrl: "https://checkout.stripe.com/c/pay/cs_test_123",
      providerSessionId: "cs_test_123",
      providerSubscriptionId: null,
    });

    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://api.stripe.com/v1/checkout/sessions");
    const sentParams = new URLSearchParams((init as RequestInit).body as string);
    expect(sentParams.get("mode")).toBe("subscription");
    expect(sentParams.get("line_items[0][price]")).toBe("price_starter_123");
    expect(sentParams.get("metadata[tenantId]")).toBe("tenant-1");
    expect(sentParams.get("metadata[planId]")).toBe("starter");
  });

  it("throws BillingNotConfiguredError for a plan with no configured Stripe price id", async () => {
    const provider = new StripeBillingProvider(vi.fn());
    await expect(
      provider.createCheckoutSession({
        tenantId: "tenant-1",
        planId: "growth",
        successUrl: "https://a",
        cancelUrl: "https://b",
      }),
    ).rejects.toThrow(BillingNotConfiguredError);
  });
});

describe("getActiveBillingProvider — resolution order", () => {
  it("falls back to NotConfiguredBillingProvider when neither provider is configured", () => {
    const razorpay = new (class {
      name = "razorpay" as const;
      isConfigured() {
        return false;
      }
    })() as unknown as InstanceType<typeof RazorpayBillingProvider>;
    const stripe = new (class {
      name = "stripe" as const;
      isConfigured() {
        return false;
      }
    })() as unknown as InstanceType<typeof StripeBillingProvider>;

    const provider = getActiveBillingProvider({}, { razorpay, stripe });
    expect(provider).toBeInstanceOf(NotConfiguredBillingProvider);
  });

  it("picks the single configured provider when only one is configured", () => {
    const configuredStripe = { name: "stripe" as const, isConfigured: () => true } as unknown as InstanceType<
      typeof StripeBillingProvider
    >;
    const unconfiguredRazorpay = { name: "razorpay" as const, isConfigured: () => false } as unknown as InstanceType<
      typeof RazorpayBillingProvider
    >;

    const provider = getActiveBillingProvider({}, { razorpay: unconfiguredRazorpay, stripe: configuredStripe });
    expect(provider.name).toBe("stripe");
  });

  it("prefers the currency-mapped provider when both are configured", () => {
    const configuredStripe = { name: "stripe" as const, isConfigured: () => true } as unknown as InstanceType<
      typeof StripeBillingProvider
    >;
    const configuredRazorpay = { name: "razorpay" as const, isConfigured: () => true } as unknown as InstanceType<
      typeof RazorpayBillingProvider
    >;

    const provider = getActiveBillingProvider(
      { preferredCurrency: "INR" },
      { razorpay: configuredRazorpay, stripe: configuredStripe },
    );
    expect(provider.name).toBe("razorpay");
  });
});

beforeEach(() => {
  vi.clearAllMocks();
});
