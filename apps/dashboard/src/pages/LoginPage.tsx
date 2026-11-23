import { useRef, useState, type FormEvent } from "react";
import { Navigate, Link } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { ApiError } from "../api/client";
import { ErrorBanner } from "../components/ErrorBanner";
import {
  IconArrowRight,
  IconBarChart,
  IconCheck,
  IconChevronDown,
  IconEye,
  IconEyeOff,
  IconLock,
  IconMail,
  IconZap,
} from "../components/Icons";

const BENEFITS = [
  "Find & attract ideal customers",
  "Automate campaigns and follow-ups",
  "Track growth with actionable insights",
];

// Decorative "Growth Dashboard" preview — every number here is illustrative
// sample data (labeled below), never a real tenant's metrics. No customer
// names, logos, or fabricated counts appear anywhere on this page.
const SAMPLE_STATS = [
  { label: "Visitors", value: "12.5K", delta: "↑ 24%", color: "var(--gl-chart-green)" },
  { label: "Leads", value: "842", delta: "↑ 24%", color: "var(--gl-chart-blue)" },
  { label: "Customers", value: "214", delta: "↑ 28%", color: "var(--gl-chart-purple)" },
  { label: "Revenue", value: "$48.2K", delta: "↑ 40%", color: "var(--gl-chart-green)" },
];

const SAMPLE_FUNNEL = [
  { label: "Visitors", value: "12.5K", color: "var(--gl-chart-blue)" },
  { label: "Leads", value: "842", color: "var(--gl-chart-purple)" },
  { label: "Customers", value: "214", color: "var(--gl-chart-green)" },
];

const SAMPLE_CHANNELS = [
  { label: "Organic", value: 45, color: "var(--gl-chart-blue)" },
  { label: "Social", value: 35, color: "var(--gl-chart-coral)" },
  { label: "Referral", value: 20, color: "var(--gl-chart-green)" },
];

function Sparkline({ color }: { color: string }) {
  return (
    <svg viewBox="0 0 100 32" width="100%" height="28" preserveAspectRatio="none" aria-hidden="true">
      <path
        d="M2 26 C22 22, 32 15, 48 17 C64 19, 76 8, 98 3 L98 32 L2 32 Z"
        fill={color}
        fillOpacity="0.16"
      />
      <path
        d="M2 26 C22 22, 32 15, 48 17 C64 19, 76 8, 98 3"
        fill="none"
        stroke={color}
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function FunnelGraphic() {
  return (
    <svg viewBox="0 0 80 72" width="64" height="64" aria-hidden="true" style={{ flex: "none" }}>
      <polygon points="4,4 76,4 66,24 14,24" fill="var(--gl-chart-blue)" />
      <polygon points="15,27 65,27 56,47 24,47" fill="var(--gl-chart-purple)" />
      <polygon points="25,50 55,50 48,68 32,68" fill="var(--gl-chart-green)" />
    </svg>
  );
}

function DonutChart() {
  const circumference = 2 * Math.PI * 13;
  let offset = 0;
  return (
    <svg viewBox="0 0 36 36" width="64" height="64" aria-hidden="true" style={{ flex: "none" }}>
      <circle cx="18" cy="18" r="13" fill="none" stroke="var(--border-soft)" strokeWidth="5" />
      {SAMPLE_CHANNELS.map((c) => {
        const dash = (c.value / 100) * circumference;
        const el = (
          <circle
            key={c.label}
            cx="18"
            cy="18"
            r="13"
            fill="none"
            stroke={c.color}
            strokeWidth="5"
            strokeDasharray={`${dash} ${circumference - dash}`}
            strokeDashoffset={-offset}
            transform="rotate(-90 18 18)"
          />
        );
        offset += dash;
        return el;
      })}
    </svg>
  );
}

function GrowthDashboardPreview() {
  return (
    <div className="gl-dashboard">
      <div className="gl-dashboard-panel">
        <div className="gl-dashboard-header">
          <span className="gl-dashboard-title">
            <IconBarChart width={16} height={16} /> Growth Dashboard
          </span>
          <span className="gl-dashboard-sample-tag">
            Sample data <IconChevronDown width={13} height={13} />
          </span>
        </div>

        <div className="gl-dashboard-stats">
          {SAMPLE_STATS.map((s) => (
            <div className="gl-stat-card" key={s.label}>
              <div className="gl-stat-value">{s.value}</div>
              <div className="gl-stat-label">{s.label}</div>
              <div className="gl-stat-delta" style={{ color: s.color }}>
                {s.delta}
              </div>
              <Sparkline color={s.color} />
            </div>
          ))}
        </div>

        <div className="gl-dashboard-row">
          <div className="gl-dashboard-card">
            <h4>Growth Funnel</h4>
            <div className="gl-funnel-wrap">
              <FunnelGraphic />
              <ul className="gl-funnel-legend">
                {SAMPLE_FUNNEL.map((f) => (
                  <li key={f.label}>
                    <span className="gl-funnel-dot" style={{ background: f.color }} />
                    {f.label}
                    <strong>{f.value}</strong>
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <div className="gl-dashboard-card">
            <h4>Top Channels</h4>
            <div className="gl-channels">
              <DonutChart />
              <ul className="gl-channel-list">
                {SAMPLE_CHANNELS.map((c) => (
                  <li key={c.label}>
                    <span className="gl-funnel-dot" style={{ background: c.color }} />
                    {c.label}
                    <strong>{c.value}%</strong>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </div>

      <div className="gl-growth-strip" aria-hidden="true">
        <svg viewBox="0 0 460 96" fill="none">
          <line x1="20" y1="84" x2="440" y2="84" stroke="var(--gl-showcase-accent)" strokeOpacity="0.2" />
          <path
            d="M10 74 C110 68, 200 54, 290 36 C345 25, 395 15, 445 6 L445 84 L10 84 Z"
            fill="var(--gl-showcase-accent)"
            fillOpacity="0.12"
          />
          <path
            d="M10 74 C110 68, 200 54, 290 36 C345 25, 395 15, 445 6"
            stroke="var(--gl-showcase-accent)"
            strokeWidth="3"
            strokeLinecap="round"
          />
          <circle cx="90" cy="67" r="4.5" fill="var(--gl-showcase-accent)" />
          <circle cx="190" cy="54" r="5" fill="var(--gl-showcase-accent)" />
          <circle cx="290" cy="36" r="5.5" fill="var(--gl-showcase-accent)" />
          <circle cx="390" cy="17" r="6" fill="var(--gl-showcase-accent)" />
        </svg>
        <div className="gl-growth-badge">
          <span>Sample</span>
        </div>
      </div>
    </div>
  );
}

export function LoginPage() {
  const { user, login, register } = useAuth();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  if (user) return <Navigate to="/" replace />;

  function switchMode(next: "login" | "register") {
    setError(null);
    setMode(next);
    cardRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      if (mode === "login") {
        await login(email, password);
      } else {
        await register(email, password, fullName || undefined);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="gl-page">
      <div className="gl-backdrop" aria-hidden="true">
        <svg className="gl-backdrop-curve" viewBox="0 0 180 1000" preserveAspectRatio="none" fill="currentColor">
          <path d="M0,0 L165,0 C110,190 55,380 80,580 C105,750 135,890 175,1000 L0,1000 Z" />
        </svg>
      </div>

      <header className="gl-header">
        <Link to="/" className="gl-logo">
          <span className="gl-logo-mark">
            <IconBarChart width={20} height={20} />
          </span>
          <span className="gl-logo-text">DevLaunch</span>
        </Link>
        <nav className="gl-nav">
          <a href="/#features">Features</a>
          <a href="/#how-it-works">How It Works</a>
          <span className="gl-nav-inert" title="Not available yet">
            Pricing
          </span>
          <span className="gl-nav-inert" title="Not available yet">
            About
          </span>
        </nav>
        <button type="button" className="btn gl-signin-btn" onClick={() => switchMode("login")}>
          Sign In
        </button>
      </header>

      <main className="gl-main">
        <div className="gl-hero-content">
          <span className="gl-eyebrow">
            <IconZap width={13} height={13} /> AI-Powered Growth Engine
          </span>
          <h1 className="gl-headline">
            Grow Your Business
            <br />
            <span className="gl-headline-accent">Smarter, Faster</span>
          </h1>
          <p className="gl-subtitle">
            Discover customers, automate marketing, and turn leads into revenue — all in one powerful platform.
          </p>
          <ul className="gl-benefits">
            {BENEFITS.map((b) => (
              <li key={b}>
                <span className="gl-benefit-check">
                  <IconCheck width={20} height={20} />
                </span>
                {b}
              </li>
            ))}
          </ul>
          <div className="gl-cta-row">
            <button type="button" className="gl-cta-primary" onClick={() => switchMode("register")}>
              Get Started Free <IconArrowRight width={16} height={16} />
            </button>
            <a href="/#how-it-works" className="gl-cta-secondary">
              See how it works
            </a>
          </div>
          <p className="gl-footnote muted">
            Phase 1 internal product — set up your first tenant workspace in minutes.
          </p>
        </div>

        <div className="gl-showcase-col">
          <GrowthDashboardPreview />

          <div className="gl-login-card" ref={cardRef}>
            <h2>Welcome Back</h2>
            <p className="gl-login-subtitle muted">
              {mode === "login" ? "Sign in to continue to DevLaunch." : "Create your account to get started."}
            </p>

            <ErrorBanner message={error} />

            <form onSubmit={handleSubmit} className="gl-form">
              {mode === "register" ? (
                <label className="gl-input-group">
                  <span className="gl-input-icon">
                    <IconMail width={16} height={16} />
                  </span>
                  <input
                    type="text"
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    placeholder="Full name"
                    autoComplete="name"
                  />
                </label>
              ) : null}
              <label className="gl-input-group">
                <span className="gl-input-icon">
                  <IconMail width={16} height={16} />
                </span>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="Email address"
                  autoComplete="email"
                  aria-label="Email address"
                />
              </label>
              <label className="gl-input-group">
                <span className="gl-input-icon">
                  <IconLock width={16} height={16} />
                </span>
                <input
                  type={showPassword ? "text" : "password"}
                  required
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Password"
                  autoComplete={mode === "login" ? "current-password" : "new-password"}
                  aria-label="Password"
                />
                <button
                  type="button"
                  className="gl-input-toggle"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  aria-pressed={showPassword}
                >
                  {showPassword ? <IconEyeOff width={16} height={16} /> : <IconEye width={16} height={16} />}
                </button>
              </label>
              <button type="submit" className="btn btn-primary gl-submit-btn" disabled={submitting}>
                {submitting ? "Please wait…" : mode === "login" ? "Sign In" : "Create account"}
              </button>
            </form>

            <p className="gl-login-switch">
              {mode === "login" ? (
                <>
                  Don&rsquo;t have an account?{" "}
                  <button type="button" className="btn-link" onClick={() => switchMode("register")}>
                    Sign Up
                  </button>
                </>
              ) : (
                <>
                  Already have an account?{" "}
                  <button type="button" className="btn-link" onClick={() => switchMode("login")}>
                    Sign In
                  </button>
                </>
              )}
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
