import type { CSSProperties } from "react";

// Shimmering placeholder blocks shown while real data is in flight — never
// rendered with fabricated numbers inside them, just neutral bars/shapes.
export function Skeleton({ className, style }: { className?: string; style?: CSSProperties }) {
  return <div className={`skeleton ${className ?? ""}`.trim()} style={style} />;
}

export function SkeletonText({ width = "100%" }: { width?: string | number }) {
  return <Skeleton className="skeleton-text" style={{ width }} />;
}

export function SkeletonStatGrid({ count = 3 }: { count?: number }) {
  return (
    <div className="skeleton-stat-grid">
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton key={i} className="skeleton-stat-card" />
      ))}
    </div>
  );
}

export function SkeletonChart() {
  return <Skeleton className="skeleton-chart" />;
}
