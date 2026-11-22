import type { ReactNode } from "react";
import { IconTrendDown, IconTrendUp } from "./Icons";

// A stat tile: one real number from the API, never a fabricated/placeholder
// value. Pages pass 0 explicitly when there's genuinely nothing yet — this
// component never invents a number itself. `trend` is likewise optional and
// must be computed from real data by the caller (e.g. this period vs. the
// last); omit it entirely rather than pass a guessed number.
export function StatCard({
  icon,
  label,
  value,
  hint,
  trend,
}: {
  icon: ReactNode;
  label: string;
  value: ReactNode;
  hint?: string;
  trend?: { direction: "up" | "down" | "flat"; label: string };
}) {
  return (
    <div className="stat-card">
      <div className="stat-card-icon">{icon}</div>
      <div className="stat-card-body">
        <div className="stat-top-row">
          <span className="stat-value">{value}</span>
          {trend ? (
            <span className={`stat-trend stat-trend-${trend.direction}`}>
              {trend.direction === "up" ? <IconTrendUp width={12} height={12} /> : null}
              {trend.direction === "down" ? <IconTrendDown width={12} height={12} /> : null}
              {trend.label}
            </span>
          ) : null}
        </div>
        <span className="stat-label">{label}</span>
        {hint ? <span className="stat-hint">{hint}</span> : null}
      </div>
    </div>
  );
}

export function StatGrid({ children }: { children: ReactNode }) {
  return <div className="stat-grid">{children}</div>;
}
