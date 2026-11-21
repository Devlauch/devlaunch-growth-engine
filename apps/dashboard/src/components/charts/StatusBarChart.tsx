import { Bar, BarChart, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { EmptyState } from "../EmptyState";

export interface StatusSegment {
  key: string;
  label: string;
  value: number;
  color: string;
}

// A horizontal bar breakdown (e.g. leads by status, executions by status).
// Each bar is directly labeled with its category + count, so no legend box
// is needed. Renders the real "no data yet" empty state when every segment
// is zero — this never synthesizes a distribution to fill the chart.
export function StatusBarChart({ title, segments }: { title: string; segments: StatusSegment[] }) {
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  const nonZero = segments.filter((s) => s.value > 0);

  return (
    <div className="chart-card">
      <h3 className="chart-title">{title}</h3>
      {total === 0 ? (
        <EmptyState title="No data yet" hint="This chart will populate once there's real activity to show." />
      ) : (
        <div className="chart-body" style={{ height: Math.max(nonZero.length, 1) * 36 + 16 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={nonZero}
              layout="vertical"
              margin={{ top: 4, right: 28, bottom: 4, left: 4 }}
              barCategoryGap={10}
            >
              <XAxis type="number" hide domain={[0, "dataMax"]} />
              <YAxis
                type="category"
                dataKey="label"
                width={110}
                tickLine={false}
                axisLine={false}
                tick={{ fill: "var(--muted)", fontSize: 12.5 }}
              />
              <Tooltip
                cursor={{ fill: "rgba(23,26,51,0.04)" }}
                contentStyle={{
                  background: "var(--bg-elevated)",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  color: "var(--text)",
                  fontSize: 12.5,
                }}
                formatter={(value: number) => [`${value}`, "Count"]}
              />
              <Bar dataKey="value" radius={[4, 4, 4, 4]} maxBarSize={18}>
                {nonZero.map((s) => (
                  <Cell key={s.key} fill={s.color} />
                ))}
                <LabelList
                  dataKey="value"
                  position="right"
                  style={{ fill: "var(--text)", fontSize: 12, fontWeight: 600 }}
                />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
