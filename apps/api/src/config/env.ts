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

  // Apollo.io People Search (decision-maker discovery) and Google Custom
  // Search JSON API (company discovery). Same convention as hunterApiKey
  // above: a tenant's own encrypted credential (integrationCredentials.ts,
  // stored via POST /integrations/apollo/connect or /integrations/google/
  // connect) always takes priority; these are only a dev-mode/
  // single-tenant-deployment fallback. Null in every environment this
  // codebase has actually been run in — no real Apollo or Google API key is
  // available here (see docs/PHASE_2_CREDENTIAL_AND_COST_REPORT.md).
  apolloApiKey: process.env.APOLLO_API_KEY ?? null,
  // Google's Custom Search JSON API requires BOTH an API key and a
  // Programmable Search Engine ID ("cx") — neither alone is sufficient, see
  // providerCredentials.ts's resolveGoogleSearchCredential.
  googleSearchApiKey: process.env.GOOGLE_SEARCH_API_KEY ?? null,
  googleSearchEngineId: process.env.GOOGLE_SEARCH_ENGINE_ID ?? null,
};
