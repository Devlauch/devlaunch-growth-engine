// Fixed color roles for charts. Status roles are reserved for state (good/warning/serious/critical) and are
// never reused as "series N" colors. The categorical ramp is used only for
// open-ended groupings (e.g. lead source) and is assigned in this fixed
// order, never cycled per-render.

export const STATUS_COLORS = {
  good: "#0ca30c", // succeeded / active / approved
  info: "#3987e5", // running / queued / in-progress (neutral, not a severity)
  warning: "#fab219", // needs_approval
  critical: "#d03b3b", // failed / rejected
  neutral: "#5b6476", // unknown/other status
} as const;

// Fixed-order categorical ramp (dark column), slots 1/3/7/2/4/5/6/8 avoided
// cycling — always assign in this order by first-seen category.
export const CATEGORICAL_COLORS = [
  "#3987e5", // blue
  "#199e70", // aqua
  "#9085e9", // violet
  "#d95926", // orange
  "#c98500", // yellow
  "#d55181", // magenta
  "#008300", // green
  "#e66767", // red
];

export function colorForIndex(i: number): string {
  return CATEGORICAL_COLORS[i % CATEGORICAL_COLORS.length];
}

export function colorForExecutionStatus(status: string): string {
  switch (status) {
    case "succeeded":
      return STATUS_COLORS.good;
    case "failed":
      return STATUS_COLORS.critical;
    case "needs_approval":
      return STATUS_COLORS.warning;
    case "running":
    case "queued":
      return STATUS_COLORS.info;
    default:
      return STATUS_COLORS.neutral;
  }
}

export function colorForProjectStatus(status: string): string {
  switch (status) {
    case "active":
      return STATUS_COLORS.good;
    case "suspended":
    case "disabled":
      return STATUS_COLORS.critical;
    default:
      return STATUS_COLORS.neutral;
  }
}
