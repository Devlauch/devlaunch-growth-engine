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
import { notificationsRouter } from "./routes/notifications.js";
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
import { competitorsRouter } from "./routes/competitors.js";
import { contentCalendarsRouter, contentDraftsRouter } from "./routes/contentStrategy.js";
import { seoRouter } from "./routes/seo.js";
import { leadIntelligenceRouter } from "./routes/leadIntelligence.js";
import { conversionOptimizationRouter } from "./routes/conversionOptimization.js";
import { marketingIntelligenceRouter } from "./routes/marketingIntelligence.js";
import { usageRouter } from "./routes/usage.js";
import { apiRequestCounterMiddleware } from "./lib/usageTracking.js";
import { planRouter } from "./routes/planUsage.js";
import { reportsRouter } from "./routes/reports.js";
import { reportSchedulesRouter } from "./routes/reportSchedules.js";
import { workflowsRouter } from "./routes/workflows.js";
import { growthAnalyzerRouter } from "./routes/growthAnalyzer.js";
import { landingPagesRouter } from "./routes/landingPages.js";
import { publicLandingPagesRouter } from "./routes/publicLandingPages.js";
import { chatbotAdminRouter } from "./routes/chatbotAdmin.js";
import { publicChatbotRouter } from "./routes/publicChatbot.js";
import { dealsRouter } from "./routes/deals.js";
import { meetingsRouter } from "./routes/meetings.js";
import { growthAnalyticsRouter } from "./routes/growthAnalytics.js";
import { campaignAttributionRouter } from "./routes/campaignAttribution.js";
import { chatwootWebhooksRouter } from "./routes/chatwootWebhooks.js";
import { companiesRouter } from "./routes/companies.js";
import { contactsRouter } from "./routes/contacts.js";
import { notesRouter } from "./routes/notes.js";
import { leadActivityRouter } from "./routes/leadActivity.js";
import { chatwootIntegrationRouter } from "./routes/chatwootIntegration.js";
import { crmDashboardRouter } from "./routes/crmDashboard.js";
import { dealHealthRouter } from "./routes/dealHealth.js";
import { meetingPrepRouter, objectionInsightsRouter } from "./routes/meetingPrep.js";
import { contentAttributionRouter, channelPerformanceRouter } from "./routes/contentAttribution.js";
import { hunterContactsRouter } from "./routes/hunterContacts.js";
import { listmonkIntegrationRouter } from "./routes/listmonkIntegration.js";
import { listmonkWebhooksRouter } from "./routes/listmonkWebhooks.js";
import { postizIntegrationRouter } from "./routes/postizIntegration.js";
import { postizWebhooksRouter } from "./routes/postizWebhooks.js";
import { prospectingCampaignsRouter } from "./routes/prospectingCampaigns.js";
import { leadPromotionRouter } from "./routes/leadPromotion.js";
import { qualificationSettingsRouter } from "./routes/qualificationSettings.js";
import { growthAdvisorRouter } from "./routes/growthAdvisor.js";
import { publicGrowthRouter } from "./routes/publicGrowth.js";
import { internalGrowthRouter } from "./routes/internalGrowth.js";

export function createApp(): express.Express {
  const app = express();

  app.disable("x-powered-by");
  app.use(
    express.json({
      limit: "1mb",
      // Captures the exact raw request bytes onto req.rawBody — needed by
      // routes/chatwootWebhooks.ts to verify Chatwoot's HMAC-SHA256
      // webhook signature, which is computed over the raw bytes Chatwoot
      // sent, not a re-serialization of the parsed JSON body. Harmless for
      // every other route (nothing else reads req.rawBody today).
      verify: (req, _res, buf) => {
        (req as express.Request).rawBody = buf;
      },
    }),
  );
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
  app.use("/api/v1/public", publicCors, publicLandingPagesRouter);
  app.use("/api/v1/public", publicCors, publicChatbotRouter);
  app.use("/api/v1/public", publicCors, listmonkWebhooksRouter);
  // DevLaunch's own internal customer-acquisition workspace: unauthenticated
  // website-growth-audit and demo-request capture (real crawl via
  // growthAnalyzer.ts, real lead ingestion, per-IP rate-limited). See
  // routes/publicGrowth.ts / routes/internalGrowth.ts.
  app.use("/api/v1/public", publicCors, publicGrowthRouter);

  app.use("/api/v1/webhooks/postiz", publicCors, postizWebhooksRouter);

  // Chatwoot AgentBot webhook receiver — Chatwoot itself is the caller
  // (no user session/JWT), authenticated via its own HMAC request
  // signature (see routes/chatwootWebhooks.ts), same unauthenticated-CORS
  // posture as the public widget surface above.
  app.use("/api/v1/webhooks/chatwoot", publicCors, chatwootWebhooksRouter);

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
  // Milestone 3 Phase 1 real-deployment fix: the three dedicated provider
  // integration routers (chatwoot/listmonk/postiz) MUST be mounted before
  // the generic `/integrations` registry router below — that router
  // defines its own `POST /:provider/connect` and `POST
  // /:provider/health-check` routes, which otherwise silently shadow
  // (intercept and fully respond to) every request meant for a dedicated
  // router's own, more-correct `/connect`/`/health-check` endpoints,
  // since Express resolves prefix-matched middleware in registration
  // order and the first one that sends a response wins. Confirmed via a
  // real end-to-end Postiz connect call during Milestone 3 Phase 1
  // real-world testing: it silently returned the generic router's
  // "pending_setup" response shape instead of ever reaching
  // postizIntegrationRouter's real GET /public/v1/me verification —
  // discovered only because a real external call was made, exactly the
  // kind of bug mocked tests cannot catch. Other sub-paths
  // (/sync-subscribers, /social-accounts, /conversations, etc.) were
  // never affected, only the two routes both routers happen to define.
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/integrations/chatwoot", mainCors, chatwootIntegrationRouter);
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/integrations/listmonk", mainCors, listmonkIntegrationRouter);
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/integrations/postiz", mainCors, postizIntegrationRouter);
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/integrations", mainCors, integrationsRouter);
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/discovery-sources", mainCors, discoverySourcesRouter);
  app.use(
    "/api/v1/tenants/:tenantId/projects/:projectId/prospecting-campaigns",
    mainCors,
    prospectingCampaignsRouter,
  );
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
  app.use(
    "/api/v1/tenants/:tenantId/projects/:projectId/leads/:leadId/promote-to-crm",
    mainCors,
    leadPromotionRouter,
  );
  app.use(
    "/api/v1/tenants/:tenantId/projects/:projectId/qualification-settings",
    mainCors,
    qualificationSettingsRouter,
  );
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/learning-loop", mainCors, learningLoopRouter);
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/competitors", mainCors, competitorsRouter);
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/content-calendars", mainCors, contentCalendarsRouter);
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/content-drafts", mainCors, contentDraftsRouter);
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/seo", mainCors, seoRouter);
  app.use(
    "/api/v1/tenants/:tenantId/projects/:projectId/leads/:leadId/intelligence",
    mainCors,
    leadIntelligenceRouter,
  );
  app.use(
    "/api/v1/tenants/:tenantId/projects/:projectId/conversion-optimization",
    mainCors,
    conversionOptimizationRouter,
  );
  app.use(
    "/api/v1/tenants/:tenantId/projects/:projectId/marketing-intelligence",
    mainCors,
    marketingIntelligenceRouter,
  );
  app.use("/api/v1/tenants/:tenantId/agent-executions", mainCors, tenantAgentExecutionRouter);
  app.use("/api/v1/tenants/:tenantId/approvals", mainCors, approvalsRouter);
  app.use("/api/v1/tenants/:tenantId/audit-events", mainCors, auditEventsRouter);
  app.use("/api/v1/tenants/:tenantId/notifications", mainCors, notificationsRouter);
  app.use("/api/v1/tenants/:tenantId/usage", mainCors, usageRouter);
  // Subscription plan + quota enforcement (data model + manual/admin-only
  // plan changes — no real payment processing; see routes/planUsage.ts).
  app.use("/api/v1/tenants/:tenantId/plan", mainCors, planRouter);
  // Client PDF reports (on-demand + scheduled) — additive only, mounted
  // after everything else. See docs/.../REPORT_FILES_DIR in config/env.ts
  // and apps/api/src/routes/reports.ts / reportSchedules.ts for details.
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/reports", mainCors, reportsRouter);
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/report-schedules", mainCors, reportSchedulesRouter);
  // Phase 4: cross-agent workflow orchestration (client onboarding -> ... ->
  // analytics/learning), one stage per advance call. See apps/api/src/workflow/.
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/workflows", mainCors, workflowsRouter);

  // Customer Acquisition Engine (growth analyzer, landing pages, prospect
  // discovery extensions, chatbot, sales pipeline, growth/revenue analytics).
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/growth-analyses", mainCors, growthAnalyzerRouter);
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/landing-pages", mainCors, landingPagesRouter);
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/chatbot", mainCors, chatbotAdminRouter);
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/deals", mainCors, dealHealthRouter);
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/deals", mainCors, dealsRouter);
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/meetings", mainCors, meetingsRouter);
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/companies", mainCors, companiesRouter);
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/contacts", mainCors, contactsRouter);
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/notes", mainCors, notesRouter);
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/leads/:leadId/activity", mainCors, leadActivityRouter);
  // (chatwoot/listmonk/postiz integration routers are mounted earlier,
  // before the generic /integrations registry router — see that comment.)
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/crm-dashboard", mainCors, crmDashboardRouter);
  app.use(
    "/api/v1/tenants/:tenantId/projects/:projectId/leads/:leadId/meetings/:meetingId/prep",
    mainCors,
    meetingPrepRouter,
  );
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/objection-insights", mainCors, objectionInsightsRouter);
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/content-attribution", mainCors, contentAttributionRouter);
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/channel-performance", mainCors, channelPerformanceRouter);
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/hunter", mainCors, hunterContactsRouter);
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/growth-analytics", mainCors, growthAnalyticsRouter);
  app.use(
    "/api/v1/tenants/:tenantId/projects/:projectId/campaign-attribution",
    mainCors,
    campaignAttributionRouter,
  );
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/growth-advisor", mainCors, growthAdvisorRouter);
  // DevLaunch's own internal customer-acquisition workspace (trials/CAC/
  // audit-requests/demo-requests) — `assertInternalTenant` inside this
  // router 403s any tenant id other than the one designated internal
  // workspace tenant, so mounting it on the normal tenant-scoped path is
  // safe: it's just another tenant, RLS-isolated like any other.
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/internal-growth", mainCors, internalGrowthRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
