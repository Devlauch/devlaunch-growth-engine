import express from "express";
import cors from "cors";
import { pinoHttp } from "pino-http";
import { logger } from "./lib/logger.js";
import { env } from "./config/env.js";
import { notFoundHandler, errorHandler } from "./middleware/errorHandler.js";

import { healthRouter } from "./routes/health.js";
import { authRouter } from "./routes/auth.js";
import { tenantsRouter } from "./routes/tenants.js";
import { membershipsRouter } from "./routes/memberships.js";
import { projectsRouter } from "./routes/projects.js";
import { profileRouter } from "./routes/profile.js";
import { icpProfilesRouter } from "./routes/icpProfiles.js";
import { agentTemplatesRouter } from "./routes/agentTemplates.js";
import { agentInstancesRouter } from "./routes/agentInstances.js";
import { agentRunsRouter } from "./routes/agentRuns.js";
import { projectAgentExecutionsRouter, tenantAgentExecutionRouter } from "./routes/agentExecutions.js";
import { approvalsRouter } from "./routes/approvals.js";
import { auditEventsRouter } from "./routes/auditEvents.js";
import { publicLeadsRouter } from "./routes/publicLeads.js";
import { leadsRouter } from "./routes/leads.js";
import { campaignsRouter } from "./routes/campaigns.js";
import { analyticsRouter } from "./routes/analytics.js";
import { integrationsRouter } from "./routes/integrations.js";
import { discoverySourcesRouter, discoveredOrganizationsRouter } from "./routes/discovery.js";
import { scoringRubricsRouter, leadScoresRouter } from "./routes/scoring.js";
import { priorityQueueRouter } from "./routes/priorityQueue.js";
import {
  suppressionRouter,
  consentRecordsRouter,
  countrySendSettingsRouter,
  publicUnsubscribeRouter,
} from "./routes/compliance.js";
import { messageDraftsRouter } from "./routes/messaging.js";
import { sequencesRouter } from "./routes/sequences.js";
import { sendingDomainsRouter, warmupConfigsRouter, sendHealthRouter } from "./routes/sendingSetup.js";
import { onboardingRouter } from "./routes/onboarding.js";
import { repliesRouter } from "./routes/replies.js";
import { learningLoopRouter } from "./routes/learningLoop.js";
import { usageRouter } from "./routes/usage.js";
import { apiRequestCounterMiddleware } from "./lib/usageTracking.js";

export function createApp(): express.Express {
  const app = express();

  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));
  app.use(
    pinoHttp({
      logger,
      autoLogging: { ignore: (req: import("node:http").IncomingMessage) => req.url === "/api/v1/health" },
    }),
  );
  // Real usage tracking (api_request volume) — see src/lib/usageTracking.ts
  // for why this is an in-memory counter + periodic flush rather than a
  // synchronous insert per request. Mounted globally/first so it sees
  // every request, regardless of which router below ultimately handles it.
  app.use(apiRequestCounterMiddleware);

  // Main (authenticated) API surface: only the configured dashboard
  // origin(s) by default.
  const mainCors = cors({ origin: env.corsAllowedOrigins, credentials: true });

  // Public widget surface: reflects any Origin so the *browser* lets the
  // request through at all — the actual allow/deny decision is made by
  // publicLeadsRouter against each project's own allowed_origins, which is
  // the real security boundary (a CORS header is not one by itself).
  const publicCors = cors({ origin: true, credentials: false });

  app.use("/api/v1/health", mainCors, healthRouter);
  app.use("/api/v1/public", publicCors, publicLeadsRouter);
  app.use("/api/v1/public", publicCors, publicUnsubscribeRouter);

  app.use("/api/v1/auth", mainCors, authRouter);
  app.use("/api/v1/tenants", mainCors, tenantsRouter);
  app.use("/api/v1/tenants/:tenantId/memberships", mainCors, membershipsRouter);
  app.use("/api/v1/tenants/:tenantId/projects", mainCors, projectsRouter);
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/profile", mainCors, profileRouter);
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/icp-profiles", mainCors, icpProfilesRouter);
  app.use("/api/v1/agent-templates", mainCors, agentTemplatesRouter);
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/agent-instances", mainCors, agentInstancesRouter);
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/agent-runs", mainCors, agentRunsRouter);
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/agent-executions", mainCors, projectAgentExecutionsRouter);
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/leads", mainCors, leadsRouter);
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/campaigns", mainCors, campaignsRouter);
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/analytics", mainCors, analyticsRouter);
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/integrations", mainCors, integrationsRouter);
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/discovery-sources", mainCors, discoverySourcesRouter);
  app.use(
    "/api/v1/tenants/:tenantId/projects/:projectId/discovered-organizations",
    mainCors,
    discoveredOrganizationsRouter,
  );
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/scoring-rubrics", mainCors, scoringRubricsRouter);
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/lead-scores", mainCors, leadScoresRouter);
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/priority-queue", mainCors, priorityQueueRouter);
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/suppression-list", mainCors, suppressionRouter);
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/consent-records", mainCors, consentRecordsRouter);
  app.use(
    "/api/v1/tenants/:tenantId/projects/:projectId/country-send-settings",
    mainCors,
    countrySendSettingsRouter,
  );
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/message-drafts", mainCors, messageDraftsRouter);
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/sequences", mainCors, sequencesRouter);
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/sending-domains", mainCors, sendingDomainsRouter);
  app.use(
    "/api/v1/tenants/:tenantId/projects/:projectId/sending-domains/:sendingDomainId/warmup",
    mainCors,
    warmupConfigsRouter,
  );
  app.use(
    "/api/v1/tenants/:tenantId/projects/:projectId/sending-domains/:sendingDomainId/health",
    mainCors,
    sendHealthRouter,
  );
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/onboarding", mainCors, onboardingRouter);
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/leads/:leadId/replies", mainCors, repliesRouter);
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/learning-loop", mainCors, learningLoopRouter);
  app.use("/api/v1/tenants/:tenantId/agent-executions", mainCors, tenantAgentExecutionRouter);
  app.use("/api/v1/tenants/:tenantId/approvals", mainCors, approvalsRouter);
  app.use("/api/v1/tenants/:tenantId/audit-events", mainCors, auditEventsRouter);
  app.use("/api/v1/tenants/:tenantId/usage", mainCors, usageRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
