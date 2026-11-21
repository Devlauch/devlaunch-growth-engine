import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { EmptyState } from "../EmptyState";
import type { LeadsPerDay } from "../../api/types";

// A 30-day leads-per-day time series, straight from GET .../analytics/overview
// (GROUP BY date_trunc('day', created_at) in apps/api/src/routes/analytics.ts).
// Uses the same chart library (recharts) and visual language as
// StatusBarChart — no new charting dependency. Renders the real EmptyState
// when there are zero leads in the window, never a fabricated trend line.
export function LeadsTimeSeries({ data }: { data: LeadsPerDay[] }) {
  const total = data.reduce((sum, d) => sum + d.count, 0);

  return (
    <div className="chart-card">
      <h3 className="chart-title">Leads per day (last 30 days)</h3>
      {total === 0 ? (
        <EmptyState title="No data yet" hint="This chart will populate once leads start coming in." />
      ) : (
        <div className="chart-body" style={{ height: 220 }}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: -16 }}>
              <defs>
                <linearGradient id="leadsTimeSeriesFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#3987e5" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="#3987e5" stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis
                dataKey="day"
                tickFormatter={(value: string) => new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                tick={{ fill: "var(--muted)", fontSize: 11.5 }}
                tickLine={false}
                axisLine={false}
                minTickGap={24}
              />
              <YAxis allowDecimals={false} tick={{ fill: "var(--muted)", fontSize: 11.5 }} tickLine={false} axisLine={false} width={32} />
              <Tooltip
                cursor={{ stroke: "var(--border)" }}
                contentStyle={{
                  background: "var(--bg-elevated)",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  color: "var(--text)",
                  fontSize: 12.5,
                }}
                labelFormatter={(value: string) => new Date(value).toLocaleDateString()}
                formatter={(value: number) => [`${value}`, "Leads"]}
              />
              <Area type="monotone" dataKey="count" stroke="#3987e5" strokeWidth={2} fill="url(#leadsTimeSeriesFill)" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
