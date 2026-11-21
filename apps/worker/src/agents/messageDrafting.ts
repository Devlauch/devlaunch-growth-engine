import { z } from "zod";
import type { AgentDefinition } from "@devlaunch/agent-sdk";

const CHANNELS = ["email", "whatsapp", "call_script", "linkedin_note"] as const;

export const messageDraftingInputSchema = z.object({
  leadId: z.string().min(1),
  // A fixed allow-list of factual claims about the product/offer this
  // tenant has pre-approved for use. The agent NEVER invents claims of its
  // own — it only ever composes from this list plus evidence.facts.
  approvedClaims: z.array(z.string().min(1).max(500)),
  evidence: z.object({
    summary: z.string().max(5000),
    facts: z.array(z.string().min(1).max(1000)),
  }),
});
export type MessageDraftingInput = z.infer<typeof messageDraftingInputSchema>;

const variantSchema = z.object({
  channel: z.enum(CHANNELS),
  subject: z.string().max(300).optional(),
  body: z.string().min(1),
});

export const messageDraftingOutputSchema = z.object({
  leadId: z.string(),
  variants: z.array(variantSchema).min(1),
  unsourcedClaims: z.array(z.string()),
});
export type MessageDraftingOutput = z.infer<typeof messageDraftingOutputSchema>;

/**
 * AgentDefinition for `message-drafting` v1 (roadmap item 9, "Personalized
 * message drafting").
 *
 * IMPORTANT — this is real, deterministic, evidence-grounded templating,
 * NOT a call to an external LLM API. This environment has no LLM API key
 * wired up, and fabricating a "real AI-generated" claim would violate this
 * codebase's no-fake-data convention (see marketResearch.ts's `mock: true`
 * stub for the same principle applied to research). Every sentence this
 * function writes is built out of (a) the caller-supplied `approvedClaims`
 * allow-list and (b) `evidence.facts` verbatim — nothing else is ever
 * asserted about the lead or the offer. Swapping in a real LLM call behind
 * this same function signature (same input/output schema) is a natural
 * future upgrade, not something to fake now.
 */
export const messageDraftingDefinition: AgentDefinition = {
  id: "message-drafting",
  version: "1",
  name: "Message Drafting",
  description:
    "Drafts 2-3 evidence-grounded message variants per lead (email, WhatsApp, call script, LinkedIn note) using only " +
    "caller-approved claims and caller-supplied evidence. Flags any claim it would otherwise want to make but that " +
    "isn't backed by approved claims or evidence as an unsourced claim for human review.",
  inputSchema: messageDraftingInputSchema,
  outputSchema: messageDraftingOutputSchema,
  requiredPermissions: ["agent:message-drafting:run"],
  tools: [],
};

/**
 * Candidate claims a real drafting pass would like to make, beyond what was
 * explicitly approved/evidenced. Kept as a short, honest fixed list rather
 * than invented per-lead text, so flagging logic has something concrete to
 * flag. A future LLM-backed version would generate these dynamically; here
 * they exist purely to exercise/demonstrate the "flag claims with no
 * source" requirement deterministically.
 */
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
  // Deterministic "strongest" heuristic: the longest approved claim is
  // treated as the most specific/substantive one. No ranking model, no
  // fabricated scoring — just a stable, explainable tie-break.
  return [...approvedClaims].sort((a, b) => b.length - a.length)[0];
}

function topFacts(facts: string[], count: number): string[] {
  return facts.slice(0, count);
}

export async function runMessageDrafting(rawInput: unknown): Promise<MessageDraftingOutput> {
  const input = messageDraftingInputSchema.parse(rawInput);
  const { leadId, approvedClaims, evidence } = input;

  const unsourcedClaims = CANDIDATE_UNVERIFIED_CLAIMS.filter(
    (claim) => !isClaimSourced(claim, approvedClaims, evidence.facts),
  );

  const topClaim = strongestClaim(approvedClaims);
  const facts = topFacts(evidence.facts, 2);
  const factLine = facts.length > 0 ? facts.join("; ") : evidence.summary || "your recent activity";

  const variants: MessageDraftingOutput["variants"] = [];

  // Email
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

  // WhatsApp
  variants.push({
    channel: "whatsapp",
    body:
      `Hi! ${topClaim ? `${topClaim}. ` : ""}${facts[0] ? `Saw that ${facts[0]}.` : evidence.summary} ` +
      `Mind if I share a bit more?`,
  });

  // Call script
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

  // LinkedIn note (<300 chars)
  const linkedinBase = `${topClaim ? `${topClaim}. ` : ""}${facts[0] ?? evidence.summary}`;
  const linkedinNote = `Hi — ${linkedinBase} Would love to connect and share more.`.slice(0, 299);
  variants.push({
    channel: "linkedin_note",
    body: linkedinNote,
  });

  const output: MessageDraftingOutput = {
    leadId,
    variants,
    unsourcedClaims,
  };

  // Defensive: validate our own output against outputSchema before
  // returning, so a bug here fails loudly instead of persisting a
  // schema-invalid row into message_drafts/message_draft_variants.
  return messageDraftingOutputSchema.parse(output);
}
