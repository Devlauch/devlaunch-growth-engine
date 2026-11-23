import { Link } from "react-router-dom";
import { IconKey, IconLayers, IconUsers, IconZap } from "../components/Icons";

// Public marketing/landing page, shown at "/" for signed-out visitors.
// Hard rule: only describe real, already-built capabilities, and never show
// fabricated metrics, customer names, logos, testimonials, or pricing tiers.
// Signed-in visitors never see this — App.tsx's RootRoute redirects them
// straight to /onboarding or their organization's dashboard instead.

const EXPLAINER_STEPS = [
  {
    title: "Turn visitors into leads",
    body:
      "Add one small script tag to any page on your site. Every visitor who submits a form or signs up is captured as a lead in your workspace right away — no separate form backend to build or host.",
  },
  {
    title: "Understand your market with AI",
    body:
      "Ask the market-research agent about your industry, your competitors, or your ideal customer. It runs a structured research pass and saves the answer as a named execution you and your team can revisit anytime.",
  },
  {
    title: "Act on it safely",
    body:
      "When an agent suggests something that actually matters — like reaching out to a lead — it's held for a real person to approve first. Nothing touches your leads or your site without someone signing off.",
  },
];

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

// Decorative hero graphic only — an abstract agent/workflow motif built from
// plain shapes, not a chart of any numbers. No data, real or fabricated, is
// encoded in it.
function HeroIllustration() {
  return (
    <svg viewBox="0 0 420 360" xmlns="http://www.w3.org/2000/svg" role="presentation" aria-hidden="true">
      <defs>
        <linearGradient id="heroCardFill" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#34d399" />
          <stop offset="100%" stopColor="#0f766e" />
        </linearGradient>
        <linearGradient id="heroNodeFill" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#10b981" />
          <stop offset="100%" stopColor="#34d399" />
        </linearGradient>
      </defs>

      <rect x="18" y="140" width="384" height="190" rx="20" fill="#ffffff" opacity="0.7" />
      <rect x="40" y="36" width="220" height="150" rx="18" fill="url(#heroCardFill)" />
      <rect x="64" y="64" width="140" height="12" rx="6" fill="#ffffff" opacity="0.85" />
      <rect x="64" y="90" width="172" height="10" rx="5" fill="#ffffff" opacity="0.55" />
      <rect x="64" y="108" width="100" height="10" rx="5" fill="#ffffff" opacity="0.55" />
      <circle cx="78" cy="150" r="10" fill="#ffffff" opacity="0.9" />
      <circle cx="108" cy="150" r="10" fill="#ffffff" opacity="0.6" />
      <circle cx="138" cy="150" r="10" fill="#ffffff" opacity="0.4" />

      <rect x="230" y="150" width="160" height="110" rx="16" fill="#ffffff" stroke="#e6e7f0" strokeWidth="1.5" />
      <circle cx="262" cy="182" r="16" fill="url(#heroNodeFill)" />
      <path d="M254 182h16M262 174v16" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" />
      <rect x="290" y="174" width="80" height="9" rx="4.5" fill="#bbf7d0" />
      <rect x="290" y="192" width="60" height="9" rx="4.5" fill="#edeef6" />
      <rect x="250" y="216" width="120" height="26" rx="13" fill="#f4f5fb" />
      <circle cx="266" cy="229" r="6" fill="#0f9d64" />
      <rect x="282" y="224" width="70" height="9" rx="4.5" fill="#cfd1dd" />

      <g opacity="0.9">
        <circle cx="70" cy="270" r="26" fill="#ffffff" stroke="#e6e7f0" strokeWidth="1.5" />
        <circle cx="70" cy="262" r="8" fill="#0f766e" />
        <path d="M54 282c2-10 8-16 16-16s14 6 16 16" fill="#0f766e" />
      </g>
      <rect x="112" y="252" width="90" height="36" rx="12" fill="#ffffff" stroke="#e6e7f0" strokeWidth="1.5" />
      <rect x="126" y="263" width="60" height="8" rx="4" fill="#bbf7d0" />
      <rect x="126" y="276" width="40" height="8" rx="4" fill="#edeef6" />

      <path
        d="M96 268c20-6 34-6 46 0M262 198v18M202 270h28"
        stroke="#6ee7b7"
        strokeWidth="2"
        strokeDasharray="4 5"
        fill="none"
      />
    </svg>
  );
}

export function LandingPage() {
  return (
    <div className="landing">
      <header className="landing-header">
        <div className="landing-header-inner">
          <Link to="/" className="brand">
            <span className="brand-mark">DL</span>
            <span className="brand-text">
              DevLaunch <span className="brand-accent">Growth Engine</span>
            </span>
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
            <div>
              <span className="landing-hero-eyebrow">
                <IconZap width={13} height={13} /> AI-assisted growth workspace
              </span>
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
            <div className="landing-hero-art">
              <HeroIllustration />
            </div>
          </div>
        </section>

        <section className="landing-explainer" id="how-it-works">
          <div className="landing-explainer-inner">
            <h2 className="landing-section-title">What this actually does for your website</h2>
            <p className="landing-section-subtitle">
              In plain terms: it's a workspace that captures the people visiting your site, researches your market
              for you, and only takes action once a human says yes.
            </p>
            <div className="landing-explainer-grid">
              {EXPLAINER_STEPS.map((step, i) => (
                <div className="landing-explainer-step" key={step.title}>
                  <span className="landing-explainer-step-num">{i + 1}</span>
                  <h3>{step.title}</h3>
                  <p className="muted">{step.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="landing-features" id="features">
          <div className="landing-features-inner">
            <h2 className="landing-section-title">How it works</h2>
            <p className="landing-section-subtitle">What's actually built today, project by project.</p>
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
            <span className="brand-mark">DL</span>
            <span className="brand-text">
              DevLaunch <span className="brand-accent">Growth Engine</span>
            </span>
          </span>
          <nav className="landing-footer-links">
            <Link to="/login">Sign in</Link>
            <a href="#features">Features</a>
          </nav>
          <span className="muted landing-footer-note">Phase 1 internal product.</span>
        </div>
      </footer>
    </div>
  );
}
