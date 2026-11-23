import type { ReactNode } from "react";

export function Badge({ tone, children }: { tone: "neutral" | "info" | "success" | "warn" | "danger"; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function sourceBadgeTone(source: string): "info" | "neutral" {
  return source === "public_widget" || source === "discovery" ? "info" : "neutral";
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
    case "discovery":
      return "Discovery";
    default:
      return source;
  }
}

export function discoveredOrgStatusTone(status: string): "neutral" | "info" | "success" | "warn" | "danger" {
  switch (status) {
    case "researched":
      return "success";
    case "duplicate":
      return "warn";
    case "archived":
      return "neutral";
    default: // new
      return "info";
  }
}

// How a discovered_organizations/discovered_contacts row's data was
// obtained — see packages/db/migrations/268_add_prospect_discovery_fields.sql.
export function sourceConfidenceTone(sourceConfidence: string): "neutral" | "info" | "success" | "warn" | "danger" {
  switch (sourceConfidence) {
    case "verified":
      return "success";
    case "inferred":
      return "info";
    default: // unconfirmed
      return "neutral";
  }
}

// discovered_contacts.verification_status — see 028_create_discovered_contacts.sql.
export function contactVerificationTone(status: string): "neutral" | "info" | "success" | "warn" | "danger" {
  switch (status) {
    case "verified":
      return "success";
    case "risky":
      return "warn";
    case "invalid":
      return "danger";
    case "role_based":
      return "info";
    default: // unverified
      return "neutral";
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
