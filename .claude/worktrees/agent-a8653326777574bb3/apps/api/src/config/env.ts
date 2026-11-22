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
};
