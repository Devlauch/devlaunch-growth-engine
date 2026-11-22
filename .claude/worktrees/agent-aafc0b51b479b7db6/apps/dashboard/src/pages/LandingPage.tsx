import { Link } from "react-router-dom";
import { IconKey, IconLayers, IconUsers, IconZap } from "../components/Icons";

// Public marketing/landing page, shown at "/" for signed-out visitors.
// Hard rule: only describe real, already-built capabilities, and never show
// fabricated metrics, customer names, logos, testimonials, or pricing tiers.
// Signed-in visitors never see this — App.tsx renders HomePage instead.

const FEATURES = [
  {
    icon: <IconUsers />,
    title: "Capture leads from any website",
    body:
      "Drop in a small embeddable JavaScript snippet and start collecting leads from your site straight into your project — no separate form backend to run.",
  },
  {
    icon: <IconLayers />,
    title: "Tenant-isolated workspaces",
    body:
      "Every organization you create is its own isolated tenant with its own projects, API keys, and leads — teammates only see the organizations they're a member of.",
  },
  {
    icon: <IconZap />,
    title: "Agent-driven market research",
    body:
      "Set up the market-research agent on a project and run it on demand to get a structured answer about your market, recorded as a named execution you can revisit.",
  },
  {
    icon: <IconKey />,
    title: "Human-approval-gated actions",
    body:
      "Agent actions that need a human sign-off are held for approval rather than run automatically, so nothing happens in your projects without a person in the loop.",
  },
];

export function LandingPage() {
  return (
    <div className="landing">
      <header className="landing-header">
        <div className="landing-header-inner">
          <Link to="/" className="brand">
            DevLaunch <span className="brand-accent">Growth Engine</span>
          </Link>
          <nav className="landing-header-actions">
            <Link to="/login" className="btn-link">
              Sign in
            </Link>
            <Link to="/login" className="btn btn-primary btn-small">
              Get started
            </Link>
          </nav>
        </div>
      </header>

      <main>
        <section className="landing-hero">
          <div className="landing-hero-inner">
            <h1 className="landing-hero-title">
              Capture leads and run agent-assisted research, in one tenant-isolated workspace
            </h1>
            <p className="landing-hero-subtitle">
              DevLaunch Growth Engine is an early-stage internal platform for multi-tenant lead capture via an
              embeddable widget, project-scoped agent executions like market research, and audit-logged,
              human-approval-gated actions — all under one roof.
            </p>
            <div className="landing-hero-actions">
              <Link to="/login" className="btn btn-primary">
                Sign in
              </Link>
              <Link to="/login" className="btn btn-secondary">
                Create an account
              </Link>
            </div>
          </div>
        </section>

        <section className="landing-features">
          <div className="landing-features-inner">
            <h2 className="landing-section-title">How it works</h2>
            <div className="landing-feature-grid">
              {FEATURES.map((f) => (
                <div className="panel landing-feature-card" key={f.title}>
                  <div className="stat-card-icon">{f.icon}</div>
                  <h3 className="landing-feature-title">{f.title}</h3>
                  <p className="muted landing-feature-body">{f.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>
      </main>

      <footer className="landing-footer">
        <div className="landing-footer-inner">
          <span className="brand">
            DevLaunch <span className="brand-accent">Growth Engine</span>
          </span>
          <span className="muted landing-footer-note">Phase 1 internal product.</span>
        </div>
      </footer>
    </div>
  );
}
