import type { ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./auth/AuthContext";
import { LoginPage } from "./pages/LoginPage";
import { HomePage } from "./pages/HomePage";
import { LandingPage } from "./pages/LandingPage";
import { TenantPage } from "./pages/TenantPage";
import { BrandingPage } from "./pages/BrandingPage";
import { ProjectPage } from "./pages/ProjectPage";
import { ExecutionPage } from "./pages/ExecutionPage";
import { CampaignsPage } from "./pages/CampaignsPage";
import { CampaignDetailPage } from "./pages/CampaignDetailPage";
import { AnalyticsPage } from "./pages/AnalyticsPage";
import { IntegrationsPage } from "./pages/IntegrationsPage";
import { DiscoveryPage } from "./pages/DiscoveryPage";
import { ScoringPage } from "./pages/ScoringPage";
import { PriorityQueuePage } from "./pages/PriorityQueuePage";
import { WidgetSettingsPage } from "./pages/WidgetSettingsPage";
import { SendingSetupPage } from "./pages/SendingSetupPage";
import { OnboardingWizardPage } from "./pages/OnboardingWizardPage";

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="page-loading">Loading...</div>;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

// "/" is the public landing page for signed-out visitors, and the
// organizations dashboard for signed-in ones — same route, no separate
// marketing path, no redirect loop with /login.
function RootRoute() {
  const { user, loading } = useAuth();
  if (loading) return <div className="page-loading">Loading...</div>;
  if (!user) return <LandingPage />;
  return <HomePage />;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
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
        path="/tenants/:tenantId/branding"
        element={
          <RequireAuth>
            <BrandingPage />
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
