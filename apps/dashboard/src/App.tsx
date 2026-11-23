import type { ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./auth/AuthContext";
import { LoginPage } from "./pages/LoginPage";
import { OnboardingPage } from "./pages/OnboardingPage";
import { LandingPage } from "./pages/LandingPage";
import { getLastActiveTenantId } from "./lib/lastActiveTenant";
import { TenantPage } from "./pages/TenantPage";
import { ProjectPage } from "./pages/ProjectPage";
import { ExecutionPage } from "./pages/ExecutionPage";
import { CampaignsPage } from "./pages/CampaignsPage";
import { CampaignDetailPage } from "./pages/CampaignDetailPage";
import { AnalyticsPage } from "./pages/AnalyticsPage";
import { ReportsPage } from "./pages/ReportsPage";
import { UsagePage } from "./pages/UsagePage";
import { PlanUsagePage } from "./pages/PlanUsagePage";
import { BillingPage } from "./pages/BillingPage";
import { AuditLogPage } from "./pages/AuditLogPage";
import { BrandingPage } from "./pages/BrandingPage";
import { IntegrationsPage } from "./pages/IntegrationsPage";
import { DiscoveryPage } from "./pages/DiscoveryPage";
import { ScoringPage } from "./pages/ScoringPage";
import { PriorityQueuePage } from "./pages/PriorityQueuePage";
import { WidgetSettingsPage } from "./pages/WidgetSettingsPage";
import { SendingSetupPage } from "./pages/SendingSetupPage";
import { OnboardingWizardPage } from "./pages/OnboardingWizardPage";
import { CompetitorIntelligencePage } from "./pages/CompetitorIntelligencePage";
import { ContentStrategyPage } from "./pages/ContentStrategyPage";
import { SeoAuditPage } from "./pages/SeoAuditPage";
import { LeadIntelligencePage } from "./pages/LeadIntelligencePage";
import { ConversionOptimizationPage } from "./pages/ConversionOptimizationPage";
import { MarketingIntelligencePage } from "./pages/MarketingIntelligencePage";
import { WorkflowPage } from "./pages/WorkflowPage";
import { GrowthAnalyzerPage } from "./pages/GrowthAnalyzerPage";
import { LandingPageBuilderPage } from "./pages/LandingPageBuilderPage";
import { ChatbotConfigPage } from "./pages/ChatbotConfigPage";
import { SalesPipelinePage } from "./pages/SalesPipelinePage";
import { CompaniesPage } from "./pages/CompaniesPage";
import { ChatwootIntegrationPage } from "./pages/ChatwootIntegrationPage";
import { GrowthAnalyticsPage } from "./pages/GrowthAnalyticsPage";
import { SiteAnalyticsPage } from "./pages/SiteAnalyticsPage";
import { CrmDashboardPage } from "./pages/CrmDashboardPage";
import { ListmonkIntegrationPage } from "./pages/ListmonkIntegrationPage";
import { LeadDetailPage } from "./pages/LeadDetailPage";
import { PostizIntegrationPage } from "./pages/PostizIntegrationPage";
import { ProspectingCampaignsPage } from "./pages/ProspectingCampaignsPage";
import { GrowthAdvisorPage } from "./pages/GrowthAdvisorPage";
import { AcquisitionWorkspacePage } from "./pages/AcquisitionWorkspacePage";
import { RevenueIntelligencePage } from "./pages/RevenueIntelligencePage";
import { VisitorRevenueAttributionPage } from "./pages/VisitorRevenueAttributionPage";
import { AiAgentCenterPage } from "./pages/AiAgentCenterPage";
import { WorkflowAutomationPage } from "./pages/WorkflowAutomationPage";
import { AdvancedAnalyticsPage } from "./pages/AdvancedAnalyticsPage";
import { GrowthExperimentsPage } from "./pages/GrowthExperimentsPage";
import { FeedbackSurveysPage } from "./pages/FeedbackSurveysPage";
import { CompetitorMonitoringPage } from "./pages/CompetitorMonitoringPage";
import { SocialContentCalendarPage } from "./pages/SocialContentCalendarPage";

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="page-loading">Loading...</div>;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

// "/" is the public landing page for signed-out visitors, and a smart
// redirect for signed-in ones: straight into their organization's
// dashboard (never a list page — each account owns at most one
// organization, see docs/DECISIONS.md), or to /onboarding if they don't
// have one yet.
function RootRoute() {
  const { user, loading, memberships } = useAuth();
  if (loading) return <div className="page-loading">Loading...</div>;
  if (!user) return <LandingPage />;
  if (memberships.length === 0) return <Navigate to="/onboarding" replace />;

  const lastActiveId = getLastActiveTenantId();
  const target =
    memberships.find((m) => m.tenantId === lastActiveId) ??
    memberships.find((m) => m.role === "owner") ??
    memberships[0];
  return <Navigate to={`/tenants/${target.tenantId}`} replace />;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/onboarding" element={<OnboardingPage />} />
      <Route path="/" element={<RootRoute />} />
      <Route
        path="/tenants/:tenantId"
        element={
          <RequireAuth>
            <TenantPage />
          </RequireAuth>
        }
      />
      <Route
        path="/tenants/:tenantId/projects/:projectId"
        element={
          <RequireAuth>
            <ProjectPage />
          </RequireAuth>
        }
      />
      <Route
        path="/tenants/:tenantId/usage"
        element={
          <RequireAuth>
            <UsagePage />
          </RequireAuth>
        }
      />
      <Route
        path="/tenants/:tenantId/billing"
        element={
          <RequireAuth>
            <BillingPage />
          </RequireAuth>
        }
      />
      <Route
        path="/tenants/:tenantId/plan-usage"
        element={
          <RequireAuth>
            <PlanUsagePage />
          </RequireAuth>
        }
      />
      <Route
        path="/tenants/:tenantId/audit-log"
        element={
          <RequireAuth>
            <AuditLogPage />
          </RequireAuth>
        }
      />
      <Route
        path="/tenants/:tenantId/branding"
        element={
          <RequireAuth>
            <BrandingPage />
          </RequireAuth>
        }
      />
      <Route
        path="/tenants/:tenantId/projects/:projectId/campaigns"
        element={
          <RequireAuth>
            <CampaignsPage />
          </RequireAuth>
        }
      />
      <Route
        path="/tenants/:tenantId/projects/:projectId/campaigns/:campaignId"
        element={
          <RequireAuth>
            <CampaignDetailPage />
          </RequireAuth>
        }
      />
      <Route
        path="/tenants/:tenantId/projects/:projectId/analytics"
        element={
          <RequireAuth>
            <AnalyticsPage />
          </RequireAuth>
        }
      />
      <Route
        path="/tenants/:tenantId/projects/:projectId/reports"
        element={
          <RequireAuth>
            <ReportsPage />
          </RequireAuth>
        }
      />
      <Route
        path="/tenants/:tenantId/projects/:projectId/integrations"
        element={
          <RequireAuth>
            <IntegrationsPage />
          </RequireAuth>
        }
      />
      <Route
        path="/tenants/:tenantId/projects/:projectId/discovery"
        element={
          <RequireAuth>
            <DiscoveryPage />
          </RequireAuth>
        }
      />
      <Route
        path="/tenants/:tenantId/projects/:projectId/prospecting-campaigns"
        element={
          <RequireAuth>
            <ProspectingCampaignsPage />
          </RequireAuth>
        }
      />
      <Route
        path="/tenants/:tenantId/projects/:projectId/scoring"
        element={
          <RequireAuth>
            <ScoringPage />
          </RequireAuth>
        }
      />
      <Route
        path="/tenants/:tenantId/projects/:projectId/priority-queue"
        element={
          <RequireAuth>
            <PriorityQueuePage />
          </RequireAuth>
        }
      />
      <Route
        path="/tenants/:tenantId/projects/:projectId/widget-settings"
        element={
          <RequireAuth>
            <WidgetSettingsPage />
          </RequireAuth>
        }
      />
      <Route
        path="/tenants/:tenantId/projects/:projectId/sending-setup"
        element={
          <RequireAuth>
            <SendingSetupPage />
          </RequireAuth>
        }
      />
      <Route
        path="/tenants/:tenantId/projects/:projectId/onboarding"
        element={
          <RequireAuth>
            <OnboardingWizardPage />
          </RequireAuth>
        }
      />
      <Route
        path="/tenants/:tenantId/projects/:projectId/competitor-intelligence"
        element={
          <RequireAuth>
            <CompetitorIntelligencePage />
          </RequireAuth>
        }
      />
      <Route
        path="/tenants/:tenantId/projects/:projectId/content-strategy"
        element={
          <RequireAuth>
            <ContentStrategyPage />
          </RequireAuth>
        }
      />
      <Route
        path="/tenants/:tenantId/projects/:projectId/seo"
        element={
          <RequireAuth>
            <SeoAuditPage />
          </RequireAuth>
        }
      />
      <Route
        path="/tenants/:tenantId/projects/:projectId/lead-intelligence"
        element={
          <RequireAuth>
            <LeadIntelligencePage />
          </RequireAuth>
        }
      />
      <Route
        path="/tenants/:tenantId/projects/:projectId/conversion-optimization"
        element={
          <RequireAuth>
            <ConversionOptimizationPage />
          </RequireAuth>
        }
      />
      <Route
        path="/tenants/:tenantId/projects/:projectId/marketing-intelligence"
        element={
          <RequireAuth>
            <MarketingIntelligencePage />
          </RequireAuth>
        }
      />
      <Route
        path="/tenants/:tenantId/projects/:projectId/workflows"
        element={
          <RequireAuth>
            <WorkflowPage />
          </RequireAuth>
        }
      />
      <Route
        path="/tenants/:tenantId/projects/:projectId/growth-analyzer"
        element={
          <RequireAuth>
            <GrowthAnalyzerPage />
          </RequireAuth>
        }
      />
      <Route
        path="/tenants/:tenantId/projects/:projectId/landing-pages"
        element={
          <RequireAuth>
            <LandingPageBuilderPage />
          </RequireAuth>
        }
      />
      <Route
        path="/tenants/:tenantId/projects/:projectId/chatbot"
        element={
          <RequireAuth>
            <ChatbotConfigPage />
          </RequireAuth>
        }
      />
      <Route
        path="/tenants/:tenantId/projects/:projectId/sales-pipeline"
        element={
          <RequireAuth>
            <SalesPipelinePage />
          </RequireAuth>
        }
      />
      <Route
        path="/tenants/:tenantId/projects/:projectId/companies"
        element={
          <RequireAuth>
            <CompaniesPage />
          </RequireAuth>
        }
      />
      <Route
        path="/tenants/:tenantId/projects/:projectId/leads/:leadId"
        element={
          <RequireAuth>
            <LeadDetailPage />
          </RequireAuth>
        }
      />
      <Route
        path="/tenants/:tenantId/projects/:projectId/integrations/chatwoot"
        element={
          <RequireAuth>
            <ChatwootIntegrationPage />
          </RequireAuth>
        }
      />
      <Route
        path="/tenants/:tenantId/projects/:projectId/growth-analytics"
        element={
          <RequireAuth>
            <GrowthAnalyticsPage />
          </RequireAuth>
        }
      />
      <Route
        path="/tenants/:tenantId/projects/:projectId/site-analytics"
        element={
          <RequireAuth>
            <SiteAnalyticsPage />
          </RequireAuth>
        }
      />
      <Route
        path="/tenants/:tenantId/projects/:projectId/crm-dashboard"
        element={
          <RequireAuth>
            <CrmDashboardPage />
          </RequireAuth>
        }
      />
      <Route
        path="/tenants/:tenantId/projects/:projectId/integrations/listmonk"
        element={
          <RequireAuth>
            <ListmonkIntegrationPage />
          </RequireAuth>
        }
      />
      <Route
        path="/tenants/:tenantId/projects/:projectId/integrations/postiz"
        element={
          <RequireAuth>
            <PostizIntegrationPage />
          </RequireAuth>
        }
      />
      <Route
        path="/tenants/:tenantId/projects/:projectId/growth-advisor"
        element={
          <RequireAuth>
            <GrowthAdvisorPage />
          </RequireAuth>
        }
      />
      <Route
        path="/tenants/:tenantId/projects/:projectId/internal-growth"
        element={
          <RequireAuth>
            <AcquisitionWorkspacePage />
          </RequireAuth>
        }
      />
      <Route
        path="/tenants/:tenantId/projects/:projectId/revenue-intelligence"
        element={
          <RequireAuth>
            <RevenueIntelligencePage />
          </RequireAuth>
        }
      />
      <Route
        path="/tenants/:tenantId/projects/:projectId/visitor-attribution"
        element={
          <RequireAuth>
            <VisitorRevenueAttributionPage />
          </RequireAuth>
        }
      />
      <Route
        path="/tenants/:tenantId/projects/:projectId/agents"
        element={
          <RequireAuth>
            <AiAgentCenterPage />
          </RequireAuth>
        }
      />
      <Route
        path="/tenants/:tenantId/projects/:projectId/workflow-automation"
        element={
          <RequireAuth>
            <WorkflowAutomationPage />
          </RequireAuth>
        }
      />
      <Route
        path="/tenants/:tenantId/projects/:projectId/advanced-analytics"
        element={
          <RequireAuth>
            <AdvancedAnalyticsPage />
          </RequireAuth>
        }
      />
      <Route
        path="/tenants/:tenantId/projects/:projectId/growth-experiments"
        element={
          <RequireAuth>
            <GrowthExperimentsPage />
          </RequireAuth>
        }
      />
      <Route
        path="/tenants/:tenantId/projects/:projectId/feedback-surveys"
        element={
          <RequireAuth>
            <FeedbackSurveysPage />
          </RequireAuth>
        }
      />
      <Route
        path="/tenants/:tenantId/projects/:projectId/competitor-monitoring"
        element={
          <RequireAuth>
            <CompetitorMonitoringPage />
          </RequireAuth>
        }
      />
      <Route
        path="/tenants/:tenantId/projects/:projectId/social-content-calendar"
        element={
          <RequireAuth>
            <SocialContentCalendarPage />
          </RequireAuth>
        }
      />
      <Route
        path="/tenants/:tenantId/executions/:executionId"
        element={
          <RequireAuth>
            <ExecutionPage />
          </RequireAuth>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
