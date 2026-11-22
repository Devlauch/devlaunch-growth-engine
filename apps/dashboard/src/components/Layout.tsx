import { useEffect, useState, type ReactNode } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { NotificationBell } from "./NotificationBell";
import {
  IconBell,
  IconBuilding,
  IconChart,
  IconChevronsLeft,
  IconClose,
  IconInbox,
  IconKey,
  IconLayers,
  IconMenu,
  IconPlug,
  IconSearch,
  IconSettings,
  IconCompass,
  IconTarget,
  IconUsers,
  IconZap,
} from "./Icons";

const SIDEBAR_COLLAPSED_KEY = "devlaunch.sidebarCollapsed";

// Derive short initials for the header avatar from the real logged-in user —
// never a placeholder. Falls back to the email's first letter when no full
// name is set.
function initialsFor(fullName: string | null | undefined, email: string | undefined): string {
  if (fullName && fullName.trim()) {
    const parts = fullName.trim().split(/\s+/);
    const first = parts[0]?.[0] ?? "";
    const last = parts.length > 1 ? parts[parts.length - 1]?.[0] ?? "" : "";
    return (first + last).toUpperCase() || "?";
  }
  if (email) return email[0]?.toUpperCase() ?? "?";
  return "?";
}

export interface LayoutProps {
  children: ReactNode;
  crumbs?: { label: string; to?: string }[];
  /** Organization name, shown as the sidebar's contextual section header once inside a tenant. */
  tenantName?: string;
  /** Project name, shown once inside a project; also unlocks the in-page project sub-nav. */
  projectName?: string;
  /** Whether the current project has a leads route/data available (always true today — kept
   * explicit so a future project type without leads can omit the nav item instead of linking nowhere). */
  hasLeads?: boolean;
}

function NavLink({
  to,
  active,
  icon,
  children,
  onClick,
}: {
  to: string;
  active: boolean;
  icon: ReactNode;
  children: ReactNode;
  onClick?: () => void;
}) {
  return (
    <Link to={to} className={active ? "nav-item nav-item-active" : "nav-item"} onClick={onClick}>
      <span className="nav-icon">{icon}</span>
      <span>{children}</span>
    </Link>
  );
}

function AnchorNavItem({ href, icon, children, onClick }: { href: string; icon: ReactNode; children: ReactNode; onClick?: () => void }) {
  return (
    <a href={href} className="nav-item nav-item-sub" onClick={onClick}>
      <span className="nav-icon">{icon}</span>
      <span>{children}</span>
    </a>
  );
}

export function Layout({ children, crumbs, tenantName, projectName, hasLeads = true }: LayoutProps) {
  const { user, logout } = useAuth();
  const location = useLocation();
  const { tenantId, projectId } = useParams<{ tenantId?: string; projectId?: string }>();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
    } catch {
      return false;
    }
  });

  // Close the mobile nav whenever the route changes underneath it.
  useEffect(() => {
    setMobileNavOpen(false);
  }, [location.pathname]);

  const closeMobileNav = () => setMobileNavOpen(false);

  function toggleCollapsed() {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? "1" : "0");
      } catch {
        // ignore — collapsed state just won't persist across reloads
      }
      return next;
    });
  }

  const sidebarClass = [
    "sidebar",
    mobileNavOpen ? "sidebar-open" : "",
    collapsed ? "sidebar-collapsed" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="shell">
      <aside className={sidebarClass}>
        <div className="sidebar-header">
          <Link to="/" className="brand" onClick={closeMobileNav}>
            <span className="brand-mark">DL</span>
            <span className="brand-text">
              DevLaunch <span className="brand-accent">Growth Engine</span>
            </span>
          </Link>
          <div className="sidebar-header-actions">
            <button type="button" className="sidebar-close" aria-label="Close menu" onClick={closeMobileNav}>
              <IconClose />
            </button>
            <button
              type="button"
              className="sidebar-collapse-btn"
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              onClick={toggleCollapsed}
            >
              <IconChevronsLeft width={15} height={15} />
            </button>
          </div>
        </div>

        <nav className="sidebar-nav" aria-label="Primary">
          <span className="nav-section-label">Workspace</span>
          <NavLink to="/" active={location.pathname === "/"} icon={<IconBuilding />} onClick={closeMobileNav}>
            Organizations
          </NavLink>

          {tenantId ? (
            <>
              <span className="nav-section-label">{tenantName ?? "Organization"}</span>
              <NavLink
                to={`/tenants/${tenantId}`}
                active={location.pathname === `/tenants/${tenantId}`}
                icon={<IconLayers />}
                onClick={closeMobileNav}
              >
                Projects
              </NavLink>
              <NavLink
                to={`/tenants/${tenantId}/audit-log`}
                active={location.pathname === `/tenants/${tenantId}/audit-log`}
                icon={<IconInbox />}
                onClick={closeMobileNav}
              >
                Audit Log
              </NavLink>
              <NavLink
                to={`/tenants/${tenantId}/usage`}
                active={location.pathname === `/tenants/${tenantId}/usage`}
                icon={<IconChart />}
                onClick={closeMobileNav}
              >
                Usage
              </NavLink>
              <NavLink
                to={`/tenants/${tenantId}/plan-usage`}
                active={location.pathname === `/tenants/${tenantId}/plan-usage`}
                icon={<IconChart />}
                onClick={closeMobileNav}
              >
                Plan &amp; Usage
              </NavLink>

              {projectId ? (
                <>
                  <span className="nav-section-label">{projectName ?? "Project"}</span>
                  <AnchorNavItem href="#agents-section" icon={<IconZap />} onClick={closeMobileNav}>
                    Agent Executions
                  </AnchorNavItem>
                  {hasLeads ? (
                    <AnchorNavItem href="#leads-section" icon={<IconUsers />} onClick={closeMobileNav}>
                      Leads
                    </AnchorNavItem>
                  ) : null}
                  <NavLink
                    to={`/tenants/${tenantId}/projects/${projectId}/discovery`}
                    active={location.pathname.startsWith(`/tenants/${tenantId}/projects/${projectId}/discovery`)}
                    icon={<IconCompass />}
                    onClick={closeMobileNav}
                  >
                    Discovery
                  </NavLink>
                  <NavLink
                    to={`/tenants/${tenantId}/projects/${projectId}/priority-queue`}
                    active={location.pathname.startsWith(`/tenants/${tenantId}/projects/${projectId}/priority-queue`)}
                    icon={<IconInbox />}
                    onClick={closeMobileNav}
                  >
                    Priority Queue
                  </NavLink>
                  <NavLink
                    to={`/tenants/${tenantId}/projects/${projectId}/scoring`}
                    active={location.pathname.startsWith(`/tenants/${tenantId}/projects/${projectId}/scoring`)}
                    icon={<IconChart />}
                    onClick={closeMobileNav}
                  >
                    Scoring
                  </NavLink>
                  <NavLink
                    to={`/tenants/${tenantId}/projects/${projectId}/campaigns`}
                    active={location.pathname.startsWith(`/tenants/${tenantId}/projects/${projectId}/campaigns`)}
                    icon={<IconTarget />}
                    onClick={closeMobileNav}
                  >
                    Campaigns
                  </NavLink>
                  <NavLink
                    to={`/tenants/${tenantId}/projects/${projectId}/workflows`}
                    active={location.pathname.startsWith(`/tenants/${tenantId}/projects/${projectId}/workflows`)}
                    icon={<IconZap />}
                    onClick={closeMobileNav}
                  >
                    Workflows
                  </NavLink>
                  <NavLink
                    to={`/tenants/${tenantId}/projects/${projectId}/analytics`}
                    active={location.pathname.startsWith(`/tenants/${tenantId}/projects/${projectId}/analytics`)}
                    icon={<IconChart />}
                    onClick={closeMobileNav}
                  >
                    Analytics
                  </NavLink>
                  <NavLink
                    to={`/tenants/${tenantId}/projects/${projectId}/reports`}
                    active={location.pathname.startsWith(`/tenants/${tenantId}/projects/${projectId}/reports`)}
                    icon={<IconChart />}
                    onClick={closeMobileNav}
                  >
                    Reports
                  </NavLink>
                  <NavLink
                    to={`/tenants/${tenantId}/projects/${projectId}/integrations`}
                    active={location.pathname.startsWith(`/tenants/${tenantId}/projects/${projectId}/integrations`)}
                    icon={<IconPlug />}
                    onClick={closeMobileNav}
                  >
                    Integrations
                  </NavLink>
                  <span className="nav-section-label">Marketing Intelligence</span>
                  <NavLink
                    to={`/tenants/${tenantId}/projects/${projectId}/competitor-intelligence`}
                    active={location.pathname.startsWith(
                      `/tenants/${tenantId}/projects/${projectId}/competitor-intelligence`,
                    )}
                    icon={<IconTarget />}
                    onClick={closeMobileNav}
                  >
                    Competitors
                  </NavLink>
                  <NavLink
                    to={`/tenants/${tenantId}/projects/${projectId}/content-strategy`}
                    active={location.pathname.startsWith(
                      `/tenants/${tenantId}/projects/${projectId}/content-strategy`,
                    )}
                    icon={<IconLayers />}
                    onClick={closeMobileNav}
                  >
                    Content Strategy
                  </NavLink>
                  <NavLink
                    to={`/tenants/${tenantId}/projects/${projectId}/seo`}
                    active={location.pathname.startsWith(`/tenants/${tenantId}/projects/${projectId}/seo`)}
                    icon={<IconSearch />}
                    onClick={closeMobileNav}
                  >
                    Technical SEO
                  </NavLink>
                  <NavLink
                    to={`/tenants/${tenantId}/projects/${projectId}/lead-intelligence`}
                    active={location.pathname.startsWith(
                      `/tenants/${tenantId}/projects/${projectId}/lead-intelligence`,
                    )}
                    icon={<IconUsers />}
                    onClick={closeMobileNav}
                  >
                    Lead Intelligence
                  </NavLink>
                  <NavLink
                    to={`/tenants/${tenantId}/projects/${projectId}/conversion-optimization`}
                    active={location.pathname.startsWith(
                      `/tenants/${tenantId}/projects/${projectId}/conversion-optimization`,
                    )}
                    icon={<IconChart />}
                    onClick={closeMobileNav}
                  >
                    Conversion Optimization
                  </NavLink>
                  <NavLink
                    to={`/tenants/${tenantId}/projects/${projectId}/marketing-intelligence`}
                    active={location.pathname.startsWith(
                      `/tenants/${tenantId}/projects/${projectId}/marketing-intelligence`,
                    )}
                    icon={<IconBell />}
                    onClick={closeMobileNav}
                  >
                    Ask &amp; Reports
                  </NavLink>
                  <NavLink
                    to={`/tenants/${tenantId}/projects/${projectId}/onboarding`}
                    active={location.pathname.startsWith(`/tenants/${tenantId}/projects/${projectId}/onboarding`)}
                    icon={<IconZap />}
                    onClick={closeMobileNav}
                  >
                    Onboarding
                  </NavLink>
                  <NavLink
                    to={`/tenants/${tenantId}/projects/${projectId}/widget-settings`}
                    active={location.pathname.startsWith(`/tenants/${tenantId}/projects/${projectId}/widget-settings`)}
                    icon={<IconKey />}
                    onClick={closeMobileNav}
                  >
                    Widget Settings
                  </NavLink>
                  <NavLink
                    to={`/tenants/${tenantId}/projects/${projectId}/sending-setup`}
                    active={location.pathname.startsWith(`/tenants/${tenantId}/projects/${projectId}/sending-setup`)}
                    icon={<IconSettings />}
                    onClick={closeMobileNav}
                  >
                    Sending Setup
                  </NavLink>
                  <AnchorNavItem href="#settings-section" icon={<IconKey />} onClick={closeMobileNav}>
                    Settings
                  </AnchorNavItem>
                </>
              ) : null}
            </>
          ) : null}
        </nav>

        <div className="sidebar-footer">
          {user ? (
            <>
              <span className="sidebar-user" title={user.email}>
                {user.email}
              </span>
              <button type="button" className="btn-link" onClick={logout}>
                Log out
              </button>
            </>
          ) : null}
        </div>
      </aside>

      {mobileNavOpen ? <button type="button" className="sidebar-overlay" aria-label="Close menu" onClick={closeMobileNav} /> : null}

      <div className="main">
        <header className="topheader">
          <button type="button" className="mobile-menu-btn" aria-label="Open menu" onClick={() => setMobileNavOpen(true)}>
            <IconMenu />
          </button>
          {crumbs && crumbs.length > 0 ? (
            <nav className="crumbs" aria-label="Breadcrumb">
              {crumbs.map((c, i) => (
                <span key={i}>
                  {c.to ? <Link to={c.to}>{c.label}</Link> : <span>{c.label}</span>}
                  {i < crumbs.length - 1 ? <span className="crumb-sep">/</span> : null}
                </span>
              ))}
            </nav>
          ) : (
            <span />
          )}

          <label className="header-search">
            <IconSearch width={16} height={16} />
            <input type="text" placeholder="Search" disabled aria-label="Search (coming soon)" />
          </label>

          <div className="header-actions">
            {tenantId ? <NotificationBell tenantId={tenantId} /> : null}
            {user ? (
              <span className="header-avatar" title={user.fullName ?? user.email}>
                {initialsFor(user.fullName, user.email)}
              </span>
            ) : null}
          </div>
        </header>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}
