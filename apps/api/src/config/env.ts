const required = (name: string, fallback?: string): string => {
  const v = process.env[name] ?? fallback;
  if (v === undefined) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
};

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: required("DATABASE_URL", "postgres://devlaunch:devlaunch@localhost:5432/devlaunch_dev"),
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  logLevel: process.env.LOG_LEVEL ?? "info",

  // DEV ONLY — replace with real auth/OIDC before production. Enables the
  // X-Dev-User-Id header bypass in src/middleware/auth.ts. Default true so
  // Phase 1 is runnable out of the box; must be explicitly set to "false"
  // (and real JWT auth used) in any shared/production environment.
  allowDevAuth: (process.env.ALLOW_DEV_AUTH ?? "true") === "true",

  jwtAccessSecret: process.env.JWT_ACCESS_SECRET ?? "dev-insecure-access-secret-change-me",
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET ?? "dev-insecure-refresh-secret-change-me",
  jwtAccessTtl: process.env.JWT_ACCESS_TTL ?? "15m",
  jwtRefreshTtl: process.env.JWT_REFRESH_TTL ?? "30d",

  // Public lead-capture widget rate limits (per IP and per project public key).
  publicLeadsRateLimitPerIpPerMin: Number(process.env.PUBLIC_LEADS_RATE_LIMIT_PER_IP_PER_MIN ?? 10),
  publicLeadsRateLimitPerKeyPerMin: Number(process.env.PUBLIC_LEADS_RATE_LIMIT_PER_KEY_PER_MIN ?? 60),

  corsAllowedOrigins: (process.env.CORS_ALLOWED_ORIGINS ?? "http://localhost:3000")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  // Milestone 2: encryption-at-rest key for third-party integration
  // credentials (listmonk/chatwoot/postiz API keys, OAuth tokens) stored in
  // integrations.encrypted_credential_ref. Base64-encoded 32 bytes (AES-256).
  // See apps/api/src/lib/credentialEncryption.ts — honestly unconfigured
  // (null) rather than a fallback dev key, since unlike JWT secrets this
  // key protects real third-party secrets a tenant enters.
  integrationCredentialsKey: process.env.INTEGRATION_CREDENTIALS_KEY ?? null,

  // Technical SEO agent (Phase 2 item 3): Core Web Vitals via the free
  // Google PageSpeed Insights API. Optional — null in any environment
  // without a key, in which case apps/api/src/lib/coreWebVitals.ts
  // honestly reports { status: "not_configured" } rather than fabricating
  // numbers. See apps/api/src/lib/dnsVerification.ts for the same
  // injectable/graceful-degradation convention.
  googlePageSpeedApiKey: process.env.GOOGLE_PAGESPEED_API_KEY ?? null,

  // Client PDF reports: local-volume file store (no S3/object storage is
  // configured in this environment). Shared with the `report_files`
  // volume, mounted into both api and worker (see docker-compose.yml) so
  // apps/worker can write the generated PDF and this process can stream it
  // back via GET .../reports/:id/download.
  reportFilesDir: process.env.REPORT_FILES_DIR ?? "./report_files",

  // Sales Conversion Agent: real Calendly-style booking-provider
  // integration (see apps/api/src/lib/bookingProvider.ts). Optional — null
  // in any environment without a key, in which case bookingProvider.ts's
  // NotConfiguredBookingProvider is used and every booking-provider action
  // honestly reports { status: "not_configured" } rather than fabricating
  // a real external booking. Same injectable/graceful-degradation
  // convention as googlePageSpeedApiKey above.
  calendlyApiKey: process.env.CALENDLY_API_KEY ?? null,

  // Chatwoot (apps/api/src/lib/chatwootClient.ts): global/env-var
  // fallback credentials, used only when a given tenant/project has no
  // connected per-tenant credential via getIntegrationCredential() — see
  // getChatwootClientForTenant()'s doc comment in chatwootClient.ts for
  // the full resolution order. Optional — all null in any environment
  // without them, in which case that resolver honestly returns
  // { status: "not_configured" } rather than fabricating a connection.
  // Same injectable/graceful-degradation convention as
  // googlePageSpeedApiKey/calendlyApiKey above.
  chatwootBaseUrl: process.env.CHATWOOT_BASE_URL ?? null,
  chatwootAccountId: process.env.CHATWOOT_ACCOUNT_ID ?? null,
  chatwootApiAccessToken: process.env.CHATWOOT_API_ACCESS_TOKEN ?? null,

  // Shared secret this process checks on inbound Chatwoot AgentBot webhook
  // deliveries (see routes/chatwootWebhooks.ts). CONFIRMED (re-verified
  // 2026-11-22, Milestone 3 real-world pass, no longer just an assumption):
  // real Chatwoot signs agent_bot webhook deliveries with an HMAC-SHA256
  // signature (X-Chatwoot-Signature: sha256=<hex of HMAC(secret,
  // "<timestamp>.<raw body>")>, plus X-Chatwoot-Timestamp — read directly
  // from lib/webhooks/trigger.rb#request_headers in the reference clone,
  // ~/project/Growth/chatwoot:
  //   ts = Time.now.to_i.to_s
  //   headers['X-Chatwoot-Timestamp'] = ts
  //   headers['X-Chatwoot-Signature'] = "sha256=#{OpenSSL::HMAC.hexdigest('SHA256', @secret, "#{ts}.#{body}")}"
  // ), not a bare shared-secret header/query param — this env var is the
  // secret the route HMAC-verifies against. Optional — null disables
  // signature verification entirely and every request is rejected with 503
  // rather than silently accepting unauthenticated events (same convention
  // as listmonkWebhookSecret below).
  chatwootWebhookSecret: process.env.CHATWOOT_WEBHOOK_SECRET ?? null,

  // Listmonk (newsletter/transactional-email) integration — see
  // apps/api/src/lib/listmonkClient.ts / listmonkIntegration.ts. SUPERSEDES
  // an earlier env-var-only design (LISTMONK_BASE_URL/LISTMONK_API_USER/
  // LISTMONK_API_KEY/LISTMONK_WEBHOOK_SECRET) that predated
  // credentialEncryption.ts and integration_webhook_events landing as the
  // shared Milestone 2 foundation. There is no global/shared listmonk
  // credential env var by design: every tenant's listmonk API key is
  // entered via POST .../integrations/listmonk/connect and stored
  // encrypted per-project in integrations.encrypted_credential_ref (see
  // credentialEncryption.ts) — never a plaintext process-wide secret.
  // Inbound bounce/complaint webhooks are verified per-ESP (SendGrid
  // ECDSA signature; SES/Postmark documented gaps) using material stored
  // in that same encrypted credential, not a shared secret env var — see
  // routes/listmonkWebhooks.ts.

  // Postiz (social post scheduling/publishing) integration — see
  // apps/api/src/lib/postizClient.ts. Optional global fallback (a single
  // shared Postiz instance/org), same convention as
  // listmonkBaseUrl/listmonkApiUser/listmonkApiKey above:
  // getPostizClientForTenant() tries a per-tenant connected credential
  // first (via integrationCredentials.ts), then these env vars, and
  // otherwise honestly reports { status: "not_configured" } rather than
  // fabricating a connection. Kept distinct from
  // channelProviders.ts's existing POSTIZ_API_KEY check (that file's
  // isConfigured() continues to read process.env.POSTIZ_API_KEY directly
  // for its own pre-existing channel_provider_configs status sync) — this
  // is the real client's own config surface, with its own base URL.
  postizBaseUrl: process.env.POSTIZ_BASE_URL ?? null,
  postizApiKey: process.env.POSTIZ_API_KEY ?? null,

  // Shared secret this process checks on inbound Postiz webhook deliveries
  // (see routes/postizWebhooks.ts). Optional — null means every webhook
  // request is rejected with 503. NOTE: Postiz's own public API does not
  // document any signature/HMAC scheme for its outbound webhook deliveries
  // (see postizWebhooks.ts's doc comment) — this shared secret is this
  // platform's own best-effort addition (expected as a query param or
  // header on the URL registered in Postiz's dashboard-only /webhooks
  // endpoint), not a Postiz-verified signature. The polling sync job in
  // postizIntegration.ts is the authoritative status/analytics source.
  postizWebhookSecret: process.env.POSTIZ_WEBHOOK_SECRET ?? null,

  // DevLaunch's own internal customer-acquisition workspace (see
  // apps/api/src/lib/internalGrowthWorkspace.ts, migration
  // 421_create_devlaunch_internal_workspace.sql). Optional — null means
  // the code-level default (the migration's own fixed seed ids) is used,
  // which is correct for every environment that ran migrations as-is;
  // these exist only so a real deployment can re-point the workspace at a
  // different tenant/project without a code change.
  devlaunchInternalTenantId: process.env.DEVLAUNCH_INTERNAL_TENANT_ID ?? null,
  devlaunchInternalProjectId: process.env.DEVLAUNCH_INTERNAL_PROJECT_ID ?? null,

  // Public growth-audit / demo-request capture endpoints (routes/
  // publicGrowth.ts) — unauthenticated by design, same per-IP fixed-window
  // rate-limit convention as the public lead-capture widget
  // (publicLeadsRateLimitPerIpPerMin above), kept as its own env var since
  // a website growth audit (a real crawl) is far more expensive per
  // request than a lead-capture form POST and should be throttled harder.
  publicGrowthAuditRateLimitPerIpPerMin: Number(process.env.PUBLIC_GROWTH_AUDIT_RATE_LIMIT_PER_IP_PER_MIN ?? 3),
  publicDemoRequestRateLimitPerIpPerMin: Number(process.env.PUBLIC_DEMO_REQUEST_RATE_LIMIT_PER_IP_PER_MIN ?? 10),

  // Hunter.io contact discovery + email verification (see
  // apps/api/src/lib/hunterProvider.ts). A tenant's own encrypted credential
  // (see integrationCredentials.ts, stored via the existing generic
  // POST /integrations/hunter/connect route) always takes priority; this is
  // only a dev-mode / single-tenant-deployment fallback, same convention as
  // googlePageSpeedApiKey/calendlyApiKey above. Null in every environment
  // this codebase has actually been run in — no real Hunter API key is
  // available here, so HunterProvider's "valid credential" path is built
  // but has never been exercised against the real API (see
  // docs/PHASE_2_HUNTER_VALIDATION.md).
  hunterApiKey: process.env.HUNTER_API_KEY ?? null,

  // Milestone 2 (P1): public, unauthenticated-by-design site-analytics
  // ingestion endpoint (routes/publicAnalytics.ts) -- same per-IP/per-key
  // fixed-window rate-limit convention as publicLeadsRateLimitPer*PerMin
  // above, kept as its own env var since a pageview/event beacon fires far
  // more often per visitor than a lead-capture form submit (once per page
  // navigation, not once per form fill), so the default allowance is
  // intentionally much higher.
  publicAnalyticsRateLimitPerIpPerMin: Number(process.env.PUBLIC_ANALYTICS_RATE_LIMIT_PER_IP_PER_MIN ?? 120),
  publicAnalyticsRateLimitPerKeyPerMin: Number(process.env.PUBLIC_ANALYTICS_RATE_LIMIT_PER_KEY_PER_MIN ?? 1200),

  // Milestone 5 (P4): pluggable LLM intelligence (see
  // apps/api/src/lib/llmProvider.ts). Optional — null in every environment
  // this codebase has actually been run in: NO real Anthropic/OpenAI/any
  // LLM API key is available here (confirmed by
  // docs/BROADER_WORKSTREAM_AUDIT.md). When null, getLlmProvider() returns
  // NotConfiguredLlmProvider and every LLM-enhanced code path
  // (growthAdvisor.ts, chatbotEngine.ts, marketingQa.ts, aiSalesAssistant.ts)
  // honestly falls back to its existing deterministic behavior — same
  // injectable/graceful-degradation convention as googlePageSpeedApiKey/
  // calendlyApiKey/hunterApiKey above. Model id is separately overridable
  // (defaults to a real, documented Messages API model id) so this can be
  // repointed without a code change once a key does exist.
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? null,
  anthropicModel: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5-20250929",

  // Milestone 5: per-tenant monthly LLM token budget (input + output tokens
  // combined), enforced by apps/api/src/lib/llmBudget.ts. `null`/unset means
  // unlimited (no LLM-specific budget check — the quota.ts plan-limit
  // system is unaffected and unrelated). This is deliberately a single
  // platform-wide default rather than a per-plan table in planLimits.ts:
  // there is no product requirement yet for per-plan LLM budgets, and
  // adding one with no real usage data to size it against would be
  // inventing a number — see llmBudget.ts's own doc comment.
  llmMonthlyTokenBudgetPerTenant: process.env.LLM_MONTHLY_TOKEN_BUDGET_PER_TENANT
    ? Number(process.env.LLM_MONTHLY_TOKEN_BUDGET_PER_TENANT)
    : null,

  // Milestone 6 (P5): SERP keyword-rank tracking — see
  // apps/api/src/lib/serpProvider.ts. Optional, same convention as
  // hunterApiKey above: null in this environment (no real SerpApi key is
  // available here), in which case getRankingProvider() returns the
  // honest NotConfiguredRankingProvider stub.
  serpApiKey: process.env.SERPAPI_API_KEY ?? null,

  // Milestone 6 (P5): Clearbit, the B2B decision-maker data provider
  // chosen for this round (see apps/api/src/lib/clearbitProvider.ts). A
  // tenant's own encrypted credential (POST /integrations/clearbit/connect)
  // always takes priority; this is only a dev-mode/single-tenant fallback,
  // same convention as hunterApiKey above. Null in this environment — no
  // real Clearbit API key is available here.
  clearbitApiKey: process.env.CLEARBIT_API_KEY ?? null,

  // Phase 2 provider validation: Apollo.io, a third B2B decision-maker data
  // provider (see apps/api/src/lib/apolloProvider.ts — People Enrichment
  // ("match") endpoint). A tenant's own encrypted credential
  // (POST /integrations/apollo/connect) always takes priority; this is only
  // a dev-mode/single-tenant fallback, same convention as hunterApiKey/
  // clearbitApiKey above. Null in every environment this codebase has
  // actually been run in — no real Apollo API key is available here, so
  // ApolloProvider's "valid credential" path is real, working client code,
  // built and reviewed against Apollo's own published API docs, but never
  // exercised against the live API (see apps/api/test/apolloRealApi.skip.test.ts
  // and its BLOCKED note).
  apolloApiKey: process.env.APOLLO_API_KEY ?? null,

  // Milestone 6 (P5): Google Ads — see
  // apps/api/src/lib/googleAdsProvider.ts. GOOGLE_ADS_CLIENT_ID/
  // _CLIENT_SECRET/_DEVELOPER_TOKEN are platform-level (the one registered
  // Google Ads OAuth app + developer token this deployment uses for every
  // tenant's connection); a tenant's own refresh_token/customerId are
  // stored per-tenant via POST /integrations/google_ads/connect
  // (integrationCredentials.ts). _REFRESH_TOKEN/_CUSTOMER_ID here are only
  // a dev-mode/single-tenant fallback. All null in this environment — no
  // real Google Ads OAuth app or developer token is available here, so
  // this path is real, working client code (see googleAdsProvider.ts) that
  // has never been exercised against the live API.
  googleAdsClientId: process.env.GOOGLE_ADS_CLIENT_ID ?? null,
  googleAdsClientSecret: process.env.GOOGLE_ADS_CLIENT_SECRET ?? null,
  googleAdsDeveloperToken: process.env.GOOGLE_ADS_DEVELOPER_TOKEN ?? null,
  googleAdsRefreshToken: process.env.GOOGLE_ADS_REFRESH_TOKEN ?? null,
  googleAdsCustomerId: process.env.GOOGLE_ADS_CUSTOMER_ID ?? null,

  // Milestone 6 (P5): Meta Ads — see apps/api/src/lib/metaAdsProvider.ts.
  // META_ADS_APP_ID/_APP_SECRET are platform-level (the one registered
  // Meta app this deployment uses for every tenant's OAuth connection); a
  // tenant's own long-lived access token is stored per-tenant via
  // POST /integrations/meta_ads/connect. _ACCESS_TOKEN here is only a
  // dev-mode/single-tenant fallback. All null in this environment.
  metaAdsAppId: process.env.META_ADS_APP_ID ?? null,
  metaAdsAppSecret: process.env.META_ADS_APP_SECRET ?? null,
  metaAdsAccessToken: process.env.META_ADS_ACCESS_TOKEN ?? null,

  // Milestone 6 (P5): WhatsApp Business Cloud API — see
  // apps/api/src/lib/whatsAppProvider.ts. A tenant's own phone-number id +
  // access token are stored per-tenant via
  // POST /integrations/whatsapp_business/connect; the _PHONE_NUMBER_ID/
  // _ACCESS_TOKEN vars here are only a dev-mode/single-tenant fallback.
  // _APP_SECRET and _WEBHOOK_VERIFY_TOKEN are platform-level (this
  // deployment's one registered Meta app secret, used to HMAC-verify every
  // inbound delivery-status webhook, and the dashboard-configured verify
  // token for the subscription handshake) — all null in this environment,
  // in which case webhook verification honestly rejects every inbound
  // request rather than accepting one unauthenticated.
  whatsappBusinessPhoneNumberId: process.env.WHATSAPP_BUSINESS_PHONE_NUMBER_ID ?? null,
  whatsappBusinessAccessToken: process.env.WHATSAPP_BUSINESS_ACCESS_TOKEN ?? null,
  whatsappBusinessAppSecret: process.env.WHATSAPP_BUSINESS_APP_SECRET ?? null,
  whatsappBusinessWebhookVerifyToken: process.env.WHATSAPP_BUSINESS_WEBHOOK_VERIFY_TOKEN ?? null,

  // Milestone 4 (P3): real SaaS billing — see
  // apps/api/src/lib/billingProvider.ts. Billing credentials are
  // PLATFORM-level, not per-tenant (unlike listmonk/chatwoot/postiz, a
  // billing provider account belongs to DevLaunch itself, not to each
  // tenant), so these are plain env vars rather than an
  // integrationCredentials.ts-encrypted per-tenant row. All null in every
  // environment this codebase has been run in: no real Razorpay or Stripe
  // account exists here.
  //
  // Razorpay (India-first): key_id/key_secret are the standard API
  // credential pair (HTTP Basic auth against api.razorpay.com). The
  // webhook secret is a SEPARATE value set only when registering a
  // webhook endpoint in the Razorpay dashboard — CONFIRMED (fetched live
  // from Razorpay's own docs, razorpay.com/docs/webhooks/validate-test/,
  // during this work): "X-Razorpay-Signature" = hex(HMAC-SHA256(raw
  // request body, webhook secret)), no timestamp concatenation (unlike
  // Stripe) and no documented replay-protection window — see
  // billingProvider.ts's doc comment for the exact citations.
  razorpayKeyId: process.env.RAZORPAY_KEY_ID ?? null,
  razorpayKeySecret: process.env.RAZORPAY_KEY_SECRET ?? null,
  razorpayWebhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET ?? null,
  // Razorpay Plan ids (created once, out-of-band, via the Razorpay
  // dashboard or POST /v1/plans — this codebase does not create Plans
  // itself) that this platform's "starter"/"growth"/"enterprise" PlanName
  // values map to. "free" never has a checkout (nothing to pay for).
  // Optional — checkout for a given plan reports not_configured when its
  // id is missing, same convention as the keys above.
  razorpayPlanIdStarter: process.env.RAZORPAY_PLAN_ID_STARTER ?? null,
  razorpayPlanIdGrowth: process.env.RAZORPAY_PLAN_ID_GROWTH ?? null,
  razorpayPlanIdEnterprise: process.env.RAZORPAY_PLAN_ID_ENTERPRISE ?? null,

  // Stripe (international): secret key is the standard Bearer-auth'd API
  // credential; the webhook secret (`whsec_...`) is a separate per-endpoint
  // value issued when registering a webhook endpoint in the Stripe
  // dashboard — CONFIRMED (fetched live from Stripe's own docs,
  // docs.stripe.com/webhooks, during this work): header "Stripe-Signature"
  // = "t=<ts>,v1=<hex hmac>,...", signed payload is literally
  // "<ts>.<raw body>", HMAC-SHA256, 5-minute default tolerance, compare
  // against every v1 value present (supports secret rotation) — see
  // billingProvider.ts's doc comment for the exact citations.
  stripeSecretKey: process.env.STRIPE_SECRET_KEY ?? null,
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? null,
  // Stripe Price ids (created once, out-of-band, via the Stripe dashboard
  // or API — this codebase does not create Products/Prices itself) that
  // this platform's plan names map to. Same optional/not_configured
  // convention as the Razorpay plan ids above.
  stripePriceIdStarter: process.env.STRIPE_PRICE_ID_STARTER ?? null,
  stripePriceIdGrowth: process.env.STRIPE_PRICE_ID_GROWTH ?? null,
  stripePriceIdEnterprise: process.env.STRIPE_PRICE_ID_ENTERPRISE ?? null,

  // Platform-wide default when BOTH Razorpay and Stripe happen to be
  // configured and neither a request nor a tenant's own currency
  // preference picks one — see getActiveBillingProvider() in
  // billingProvider.ts for the full resolution order. Optional;
  // "razorpay" | "stripe" | null (null = just pick whichever single
  // provider is configured, or report not_configured if zero are).
  billingProviderDefault: (process.env.BILLING_PROVIDER_DEFAULT ?? null) as "razorpay" | "stripe" | null,

  // Base URL the dashboard is served from, used only to build Stripe
  // Checkout's required success_url/cancel_url and Razorpay subscriptions'
  // callback_url. Optional — falls back to localhost so a dev environment
  // with neither provider configured never needs it set.
  dashboardBaseUrl: process.env.DASHBOARD_BASE_URL ?? "http://localhost:3000",

  // Milestone 3 — lead-magnet file uploads (closes the gap
  // 265_create_lead_magnets.sql's own comment documents: file_url was a
  // client-supplied-URL stub with no real upload/storage infra). Same
  // "no object storage configured in this environment" situation as PDF
  // reports (see reportFilesDir above) — local-disk storage behind a
  // pluggable FileStorage interface (apps/api/src/lib/fileStorage.ts) is
  // the real, working default; LocalDiskFileStorage writes here, on its
  // own dedicated `lead_magnet_files` volume (docker-compose.yml), never
  // mixed with the report_files volume.
  leadMagnetFilesDir: process.env.LEAD_MAGNET_FILES_DIR ?? "./lead_magnet_files",

  // Max accepted upload size in bytes. 25MB default — large enough for a
  // typical whitepaper/checklist PDF, small enough to bound local-disk
  // usage and request memory (uploads are buffered in memory by multer
  // before validation/storage — see routes/leadMagnetUploads.ts).
  leadMagnetMaxFileSizeBytes: Number(process.env.LEAD_MAGNET_MAX_FILE_SIZE_BYTES ?? 25 * 1024 * 1024),

  // HMAC-SHA256 secret for time-limited signed lead-magnet download links
  // (apps/api/src/lib/signedDownloadUrl.ts). Same "reuse a server-side-only
  // secret already in env rather than add new configuration surface"
  // convention as lib/suppression.ts's unsubscribe tokens — falls back to
  // jwtAccessSecret when unset, same as that module does.
  leadMagnetDownloadSecret: process.env.LEAD_MAGNET_DOWNLOAD_SECRET ?? null,

  // Custom-domain DNS verification (apps/api/src/lib/customDomainVerification.ts).
  // The TXT record a tenant must publish is `_devlaunch-verify.<domain>`;
  // this prefix is configurable only so a self-hosted fork can rebrand it
  // without a code change — every environment this codebase actually runs
  // in uses the default.
  customDomainVerificationTxtPrefix: process.env.CUSTOM_DOMAIN_VERIFICATION_TXT_PREFIX ?? "_devlaunch-verify",

  // ACME (Let's Encrypt) certificate provisioning (apps/api/src/lib/acmeClient.ts).
  // Defaults to the real, public Let's Encrypt production directory URL;
  // overridable to Let's Encrypt's staging directory for testing, or any
  // other RFC 8555-compliant ACME v2 server. No account key / real public
  // DNS control exists in this environment — see acmeClient.ts's doc
  // comment for exactly what that blocks.
  acmeDirectoryUrl: process.env.ACME_DIRECTORY_URL ?? "https://acme-v02.api.letsencrypt.org/directory",
  acmeAccountContactEmail: process.env.ACME_ACCOUNT_CONTACT_EMAIL ?? null,
};
