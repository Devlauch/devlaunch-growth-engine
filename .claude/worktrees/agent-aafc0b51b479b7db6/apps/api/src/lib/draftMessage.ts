/**
 * Pure message-drafting logic, ported from
 * apps/worker/src/agents/messageDrafting.ts's `runMessageDrafting`
 * (roadmap item 9, "Personalized message drafting"). apps/api has no
 * runtime dependency on the worker process/package (agents only execute
 * inside apps/worker today — see apps/api/package.json), so this is an
 * intentional, small duplication of a pure function rather than a new
 * cross-package dependency for one computation. Keep this in sync with
 * messageDrafting.ts's algorithm exactly if either changes.
 *
 * This is real, deterministic, evidence-grounded templating, NOT a call to
 * an external LLM API — see messageDrafting.ts's doc comment for the full
 * rationale. Every sentence is built out of the caller-supplied
 * `approvedClaims` allow-list and `evidence.facts` verbatim.
 */

export type DraftMessageChannel = "email" | "whatsapp" | "call_script" | "linkedin_note";

export interface DraftMessageEvidence {
  summary: string;
  facts: string[];
}

export interface DraftMessageVariant {
  channel: DraftMessageChannel;
  subject?: string;
  body: string;
}

export interface DraftMessageResult {
  variants: DraftMessageVariant[];
  unsourcedClaims: string[];
}

const CANDIDATE_UNVERIFIED_CLAIMS = [
  "trusted by industry leaders",
  "the #1 solution in the market",
  "guaranteed results within 30 days",
];

function isClaimSourced(claim: string, approvedClaims: string[], facts: string[]): boolean {
  const normalized = claim.trim().toLowerCase();
  return (
    approvedClaims.some((c) => c.trim().toLowerCase() === normalized) ||
    facts.some((f) => f.trim().toLowerCase().includes(normalized))
  );
}

function strongestClaim(approvedClaims: string[]): string | null {
  if (approvedClaims.length === 0) return null;
  return [...approvedClaims].sort((a, b) => b.length - a.length)[0];
}

function topFacts(facts: string[], count: number): string[] {
  return facts.slice(0, count);
}

export function draftMessage(
  approvedClaims: string[],
  evidence: DraftMessageEvidence,
): DraftMessageResult {
  const unsourcedClaims = CANDIDATE_UNVERIFIED_CLAIMS.filter(
    (claim) => !isClaimSourced(claim, approvedClaims, evidence.facts),
  );

  const topClaim = strongestClaim(approvedClaims);
  const facts = topFacts(evidence.facts, 2);
  const factLine = facts.length > 0 ? facts.join("; ") : evidence.summary || "your recent activity";

  const variants: DraftMessageVariant[] = [];

  variants.push({
    channel: "email",
    subject: topClaim ? `Quick note: ${topClaim}` : `Following up`,
    body:
      `Hi there,\n\n` +
      (topClaim ? `${topClaim}. ` : "") +
      `${facts.length > 0 ? `We noticed: ${factLine}.` : evidence.summary} ` +
      `Would you be open to a short conversation about how this could help your team?\n\n` +
      `Best,\nThe team`,
  });

  variants.push({
    channel: "whatsapp",
    body:
      `Hi! ${topClaim ? `${topClaim}. ` : ""}${facts[0] ? `Saw that ${facts[0]}.` : evidence.summary} ` +
      `Mind if I share a bit more?`,
  });

  const scriptLines = [
    `Opening: Introduce yourself and reference why you're calling this lead specifically.`,
    topClaim ? `Value point: ${topClaim}.` : `Value point: (no approved claim available — ask before stating any benefit).`,
    ...facts.map((f) => `Evidence point: ${f}.`),
    `Close: Ask for a 15-minute follow-up call and confirm best contact method.`,
  ];
  variants.push({
    channel: "call_script",
    body: scriptLines.join("\n"),
  });

  const linkedinBase = `${topClaim ? `${topClaim}. ` : ""}${facts[0] ?? evidence.summary}`;
  const linkedinNote = `Hi — ${linkedinBase} Would love to connect and share more.`.slice(0, 299);
  variants.push({
    channel: "linkedin_note",
    body: linkedinNote,
  });

  return { variants, unsourcedClaims };
}
