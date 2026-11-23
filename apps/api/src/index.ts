// Sentry must be initialized before any other import that could throw (so a
// startup-time crash in those imports is still reported). SENTRY_DSN is read
// directly from process.env here, not via config/env.js, specifically so
// this stays the very first thing this process does.
import * as Sentry from "@sentry/node";

if (process.env.SENTRY_DSN) {
  // Explicit, not implicit: Sentry.init() is only ever called when a real
  // DSN is configured. Without SENTRY_DSN set, this block is skipped
  // entirely and Sentry.init() is never called — Sentry's SDK functions
  // (captureException, etc.) remain safe no-ops throughout this process in
  // that case, but we don't rely on that silently; see errorHandler.ts's
  // doc comment for where captureException is actually called.
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV,
    // Conservative default: trace a small sample of transactions rather than
    // all of them (no real production traffic volume data exists yet to size
    // this against — see env.ts's llmMonthlyTokenBudgetPerTenant doc comment
    // for the same "no real usage data to size it against" reasoning).
    tracesSampleRate: 0.1,
  });
}

import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { pool, withTenantContext, assertDatabaseRoleRespectsRls } from "./db/pool.js";
import { startApiRequestUsageFlush, stopApiRequestUsageFlush } from "./lib/usageTracking.js";

const app = createApp();

const server = app.listen(env.port, () => {
  logger.info({ port: env.port, nodeEnv: env.nodeEnv, allowDevAuth: env.allowDevAuth }, "api listening");
  if (env.allowDevAuth) {
    logger.warn("ALLOW_DEV_AUTH is true: X-Dev-User-Id header auth is DEV ONLY — disable before production");
  }
});

void assertDatabaseRoleRespectsRls().catch((err) => {
  logger.error({ err }, "database role RLS check failed");
  process.exit(1);
});

// Real usage tracking: periodically flush the in-memory api_request
// counter (src/lib/usageTracking.ts) into usage_events.
startApiRequestUsageFlush(withTenantContext);

async function shutdown(signal: string) {
  logger.info({ signal }, "shutting down api");
  stopApiRequestUsageFlush();
  server.close(() => {
    pool
      .end()
      .catch(() => undefined)
      .finally(() => process.exit(0));
  });
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
