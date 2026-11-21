import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { pool } from "./db/pool.js";

const app = createApp();

const server = app.listen(env.port, () => {
  logger.info({ port: env.port, nodeEnv: env.nodeEnv, allowDevAuth: env.allowDevAuth }, "api listening");
  if (env.allowDevAuth) {
    logger.warn("ALLOW_DEV_AUTH is true: X-Dev-User-Id header auth is DEV ONLY — disable before production");
  }
});

async function shutdown(signal: string) {
  logger.info({ signal }, "shutting down api");
  server.close(() => {
    pool
      .end()
      .catch(() => undefined)
      .finally(() => process.exit(0));
  });
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
