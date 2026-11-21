import type { ReactNode } from "react";

export function Badge({ tone, children }: { tone: "neutral" | "info" | "success" | "warn" | "danger"; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function sourceBadgeTone(source: string): "info" | "neutral" {
  return source === "public_widget" ? "info" : "neutral";
}

export function sourceLabel(source: string): string {
  switch (source) {
    case "public_widget":
      return "Public widget";
    case "manual":
    case "internal":
      return "Manual";
    case "agent":
      return "Agent";
    case "import":
      return "Import";
    default:
      return source;
  }
}

export function statusTone(status: string): "neutral" | "info" | "success" | "warn" | "danger" {
  switch (status) {
    case "succeeded":
    case "approved_for_outreach":
    case "active":
      return "success";
    case "failed":
    case "rejected":
      return "danger";
    case "running":
    case "queued":
      return "info";
    case "needs_approval":
      return "warn";
    default:
      return "neutral";
  }
}

export function campaignStatusTone(status: string): "neutral" | "info" | "success" | "warn" | "danger" {
  switch (status) {
    case "approved":
      return "success";
    case "rejected":
      return "danger";
    case "pending_approval":
      return "warn";
    case "archived":
      return "neutral";
    default: // draft
      return "info";
  }
}
