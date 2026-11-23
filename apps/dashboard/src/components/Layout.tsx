import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { NotificationBell } from "./NotificationBell";
import { api, ApiError } from "../api/client";
import type { Tenant } from "../api/types";
import { brandCssVars } from "../lib/theme";
import {
  IconBell,
  IconBuilding,
  IconChart,
  IconChevronDown,
  IconChevronsLeft,
  IconClose,
  IconCompass,
  IconInbox,
  IconKey,
  IconLayers,
  IconMenu,
  IconPlug,
  IconSearch,
  IconSettings,
  IconTarget,
  IconUsers,
  IconZap,
} from "./Icons";

const SIDEBAR_COLLAPSED_KEY = "devlaunch.sidebarCollapsed";
const NAV_GROUPS_STATE_KEY = "devlaunch.navGroupsCollapsed";

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

interface NavItemDef {
  label: string;
  icon: ReactNode;
  to?: string;
  /** In-page anchor instead of a route (e.g. "#leads-section") — used for sections that live
   * on an existing page rather than having their own route. */
  anchor?: string;
  /** Omit this item entirely when false (e.g. a project type without leads). */
  show?: boolean;
}

interface NavGroupDef {
  id: string;
  label: string;
  items: NavItemDef[];
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

function loadCollapsedGroups(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(NAV_GROUPS_STATE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

/** A named, collapsible section of the sidebar nav (OVERVIEW, ACQUISITION, ...). Expanded by
 * default; collapsed state is remembered per group across the whole app, not just this page. */
function NavGroup({
  group,
  collapsed,
  onToggle,
  pathname,
  closeMobileNav,
}: {
  group: NavGroupDef;
  collapsed: boolean;
  onToggle: () => void;
  pathname: string;
  closeMobileNav: () => void;
}) {
  const visibleItems = group.items.filter((item) => item.show !== false);
  if (visibleItems.length === 0) return null;

  return (
    <div className="nav-group">
      <button type="button" className="nav-group-header" onClick={onToggle} aria-expanded={!collapsed}>
        <span>{group.label}</span>
        <IconChevronDown width={13} height={13} className={collapsed ? "nav-group-chevron nav-group-chevron-collapsed" : "nav-group-chevron"} />
      </button>
      {collapsed ? null : (
        <div className="nav-group-items">
          {visibleItems.map((item) =>
            item.anchor ? (
              <AnchorNavItem key={item.label} href={item.anchor} icon={item.icon} onClick={closeMobileNav}>
                {item.label}
              </AnchorNavItem>
            ) : (
              <NavLink
                key={item.label}
                to={item.to as string}
                active={pathname === item.to || pathname.startsWith(`${item.to}/`)}
                icon={item.icon}
                onClick={closeMobileNav}
              >
                {item.label}
              </NavLink>
            ),
          )}
        </div>
      )}
    </div>
  );
}

export function Layout({ children, crumbs, tenantName, projectName, hasLeads = true }: LayoutProps) {
  const { user, logout } = useAuth();
  const location = useLocation();
  const { tenantId, projectId } = useParams<{ tenantId?: string; projectId?: string }>();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const profileMenuRef = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>(loadCollapsedGroups);

  // Real per-tenant white-label theming: once inside a tenant, fetch its
  // branding (logo_url/primary_color — packages/db/migrations/
  // 210_add_branding_to_tenants.sql) and apply it as a live CSS
  // custom-property override + wordmark swap, not just a settings form
  // that does nothing. Self-contained here (rather than threaded through
  // every page's props) so this stays an additive change to Layout.tsx.
  const [brand, setBrand] = useState<{ logoUrl: string | null; primaryColor: string | null } | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!tenantId) {
      setBrand(null);
      return;
    }
    api
      .get<{ tenant: Tenant }>(`/tenants/${tenantId}`)
      .then((res) => {
        if (cancelled) return;
        setBrand({ logoUrl: res.tenant.logo_url ?? null, primaryColor: res.tenant.primary_color ?? null });
      })
      .catch((err) => {
        // Non-fatal: branding is a visual enhancement, not something that
        // should block the rest of the shell from rendering.
        if (!(err instanceof ApiError)) throw err;
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

  // Close the mobile nav whenever the route changes underneath it.
  useEffect(() => {
    setMobileNavOpen(false);
    setProfileMenuOpen(false);
  }, [location.pathname]);

  // Close the profile menu on an outside click.
  useEffect(() => {
    if (!profileMenuOpen) return;
    function handleClick(e: MouseEvent) {
      if (profileMenuRef.current && !profileMenuRef.current.contains(e.target as Node)) {
        setProfileMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [profileMenuOpen]);

  const closeMobileNav = () => setMobileNavOpen(false);
  const themeVars = brandCssVars(brand?.primaryColor);

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

  function toggleGroup(groupId: string) {
    setCollapsedGroups((prev) => {
      const next = { ...prev, [groupId]: !prev[groupId] };
      try {
        localStorage.setItem(NAV_GROUPS_STATE_KEY, JSON.stringify(next));
      } catch {
        // ignore — group expand/collapse just won't persist across reloads
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

  const tBase = tenantId ? `/tenants/${tenantId}` : "";
  const pBase = tenantId && projectId ? `/tenants/${tenantId}/projects/${projectId}` : "";

  // Grouped exactly per the design system's named sections. Every entry maps
  // to a real, already-existing route or in-page anchor — nothing invented.
  // A small number of existing pages (Analytics, Lead Intelligence,
  // Conversion Optimization, DevLaunch Acquisition, the project Onboarding
  // wizard, Agent Executions) aren't named in that taxonomy explicitly; each
  // is placed in the closest-fitting group rather than dropped, per "keep
  // all existing valid routes." "Ask & Reports" (marketing-intelligence) and
  // "Marketing Intelligence" in the spec are the same underlying route/
  // feature in this codebase, so it appears once (Overview), not twice.
  const navGroups: NavGroupDef[] = projectId
    ? [
        {
          id: "overview",
          label: "Overview",
          items: [
            { label: "Growth Dashboard", to: tBase, icon: <IconLayers /> },
            { label: "DevLaunch Acquisition", to: `${pBase}/internal-growth`, icon: <IconTarget /> },
            { label: "Growth Advisor", to: `${pBase}/growth-advisor`, icon: <IconBell /> },
            { label: "Ask & Reports", to: `${pBase}/marketing-intelligence`, icon: <IconBell /> },
          ],
        },
        {
          id: "acquisition",
          label: "Acquisition",
          items: [
            { label: "Discovery", to: `${pBase}/discovery`, icon: <IconCompass /> },
            { label: "Prospecting Campaigns", to: `${pBase}/prospecting-campaigns`, icon: <IconCompass /> },
            { label: "Leads", anchor: "#leads-section", icon: <IconUsers />, show: hasLeads },
            { label: "Lead Intelligence", to: `${pBase}/lead-intelligence`, icon: <IconUsers /> },
            { label: "Priority Queue", to: `${pBase}/priority-queue`, icon: <IconInbox /> },
            { label: "Scoring", to: `${pBase}/scoring`, icon: <IconChart /> },
          ],
        },
        {
          id: "marketing",
          label: "Marketing",
          items: [
            { label: "Growth Analyzer", to: `${pBase}/growth-analyzer`, icon: <IconZap /> },
            { label: "Landing Pages", to: `${pBase}/landing-pages`, icon: <IconLayers /> },
            { label: "Content Strategy", to: `${pBase}/content-strategy`, icon: <IconLayers /> },
            { label: "Technical SEO", to: `${pBase}/seo`, icon: <IconSearch /> },
            { label: "Competitors", to: `${pBase}/competitor-intelligence`, icon: <IconTarget /> },
            { label: "Conversion Optimization", to: `${pBase}/conversion-optimization`, icon: <IconChart /> },
            { label: "Social Content Calendar", to: `${pBase}/social-content-calendar`, icon: <IconInbox /> },
          ],
        },
        {
          id: "engagement",
          label: "Engagement",
          items: [
            { label: "Campaigns", to: `${pBase}/campaigns`, icon: <IconTarget /> },
            { label: "Listmonk (email)", to: `${pBase}/integrations/listmonk`, icon: <IconPlug /> },
            { label: "Chatwoot (live chat)", to: `${pBase}/integrations/chatwoot`, icon: <IconPlug /> },
            { label: "Postiz (social)", to: `${pBase}/integrations/postiz`, icon: <IconPlug /> },
            { label: "AI Chatbot", to: `${pBase}/chatbot`, icon: <IconBell /> },
            { label: "Widget Settings", to: `${pBase}/widget-settings`, icon: <IconKey /> },
            { label: "Sending Setup", to: `${pBase}/sending-setup`, icon: <IconSettings /> },
          ],
        },
        {
          id: "sales",
          label: "Sales & CRM",
          items: [
            { label: "Sales Pipeline", to: `${pBase}/sales-pipeline`, icon: <IconTarget /> },
            { label: "Companies", to: `${pBase}/companies`, icon: <IconBuilding /> },
            { label: "CRM Dashboard", to: `${pBase}/crm-dashboard`, icon: <IconChart /> },
            { label: "Revenue Intelligence", to: `${pBase}/revenue-intelligence`, icon: <IconChart /> },
          ],
        },
        {
          id: "automation",
          label: "Automation & Intelligence",
          items: [
            { label: "Workflows", to: `${pBase}/workflows`, icon: <IconZap /> },
            { label: "Agent Executions", anchor: "#agents-section", icon: <IconZap /> },
            { label: "AI Agent Center", to: `${pBase}/agents`, icon: <IconChart /> },
            { label: "Workflow Automation", to: `${pBase}/workflow-automation`, icon: <IconChart /> },
            { label: "Growth Experiments", to: `${pBase}/growth-experiments`, icon: <IconChart /> },
            { label: "Feedback & Surveys", to: `${pBase}/feedback-surveys`, icon: <IconInbox /> },
            { label: "Competitor Monitoring", to: `${pBase}/competitor-monitoring`, icon: <IconChart /> },
          ],
        },
        {
          id: "analytics",
          label: "Analytics",
          items: [
            { label: "Analytics", to: `${pBase}/analytics`, icon: <IconChart /> },
            { label: "Growth Analytics", to: `${pBase}/growth-analytics`, icon: <IconChart /> },
            { label: "Site Analytics", to: `${pBase}/site-analytics`, icon: <IconChart /> },
            { label: "Advanced Analytics", to: `${pBase}/advanced-analytics`, icon: <IconChart /> },
            { label: "Visitor Attribution", to: `${pBase}/visitor-attribution`, icon: <IconChart /> },
            { label: "Reports", to: `${pBase}/reports`, icon: <IconChart /> },
          ],
        },
        {
          id: "settings",
          label: "Workspace Settings",
          items: [
            { label: "Branding & Profile", to: `${tBase}/branding`, icon: <IconKey /> },
            { label: "Integrations", to: `${pBase}/integrations`, icon: <IconPlug /> },
            { label: "Project Onboarding", to: `${pBase}/onboarding`, icon: <IconZap /> },
            { label: "Usage", to: `${tBase}/usage`, icon: <IconChart /> },
            { label: "Plan & Usage", to: `${tBase}/plan-usage`, icon: <IconChart /> },
            { label: "Billing", to: `${tBase}/billing`, icon: <IconChart /> },
            { label: "Audit Log", to: `${tBase}/audit-log`, icon: <IconInbox /> },
            { label: "Settings", anchor: "#settings-section", icon: <IconSettings /> },
          ],
        },
      ]
    : tenantId
      ? [
          {
            id: "settings",
            label: "Workspace Settings",
            items: [
              { label: "Growth Dashboard", to: tBase, icon: <IconLayers /> },
              { label: "Branding & Profile", to: `${tBase}/branding`, icon: <IconKey /> },
              { label: "Usage", to: `${tBase}/usage`, icon: <IconChart /> },
              { label: "Plan & Usage", to: `${tBase}/plan-usage`, icon: <IconChart /> },
              { label: "Billing", to: `${tBase}/billing`, icon: <IconChart /> },
              { label: "Audit Log", to: `${tBase}/audit-log`, icon: <IconInbox /> },
            ],
          },
        ]
      : [];

  return (
    <div className="shell" style={themeVars as React.CSSProperties | undefined}>
      <aside className={sidebarClass}>
        <div className="sidebar-header">
          <Link to="/" className="brand" onClick={closeMobileNav}>
            {brand?.logoUrl ? (
              <img src={brand.logoUrl} alt={tenantName ?? "Organization logo"} className="brand-logo" />
            ) : (
              <>
                <span className="brand-mark">DL</span>
                <span className="brand-text">
                  DevLaunch <span className="brand-accent">Growth Engine</span>
                </span>
              </>
            )}
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

        {tenantId ? <div className="sidebar-workspace-label">{tenantName ?? "Organization"}</div> : null}
        {projectId ? <div className="sidebar-workspace-sublabel">{projectName ?? "Project"}</div> : null}

        <nav className="sidebar-nav" aria-label="Primary">
          {navGroups.map((group) => (
            <NavGroup
              key={group.id}
              group={group}
              // When the whole sidebar is in icon-only mode, there's no
              // room for a group header/toggle to click — always show
              // every item (as icons) rather than let a group get stuck
              // collapsed with no visible way to reopen it.
              collapsed={!collapsed && Boolean(collapsedGroups[group.id])}
              onToggle={() => toggleGroup(group.id)}
              pathname={location.pathname}
              closeMobileNav={closeMobileNav}
            />
          ))}
        </nav>
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
              <div className="profile-menu" ref={profileMenuRef}>
                <button
                  type="button"
                  className="header-avatar"
                  title={user.fullName ?? user.email}
                  onClick={() => setProfileMenuOpen((v) => !v)}
                  aria-haspopup="menu"
                  aria-expanded={profileMenuOpen}
                >
                  {initialsFor(user.fullName, user.email)}
                </button>
                {profileMenuOpen ? (
                  <div className="profile-menu-dropdown" role="menu">
                    <div className="profile-menu-email">{user.email}</div>
                    <button type="button" className="profile-menu-item" role="menuitem" onClick={logout}>
                      Log out
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </header>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}
