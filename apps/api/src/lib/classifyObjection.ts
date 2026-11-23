/**
 * classifyObjection: a small, deterministic, rule-based objection-theme
 * classifier over free text (a reply's raw_content, or a CRM note body),
 * in the exact same style as apps/api/src/lib/classifyReply.ts — ordered,
 * word-boundary-aware, case-insensitive keyword/pattern rules. This is NOT
 * an LLM call — no LLM API key is wired up anywhere in this codebase (see
 * classifyReply.ts's header comment for the same statement).
 *
 * This is deliberately a SEPARATE file/function from classifyReply.ts
 * (never edited) rather than folded into it or into
 * ReplyClassification — it answers a different question. classifyReply
 * answers "what kind of reply is this, for CRM-task automation purposes"
 * (interested / not_now / wrong_person / unsubscribe / unclassified).
 * classifyObjection answers "what free-text THEME explains a lost deal"
 * (price / timing / competitor / no budget / no authority / not
 * interested), which apps/api/src/lib/lostDealAnalysis.ts uses to find
 * real, text-grounded patterns across a tenant's lost deals.
 *
 * Rule priority (most specific/actionable reasons first, generic decline
 * language last, same reasoning as classifyReply.ts's rule ordering):
 *   1. no_budget / price / competitor — concrete, high-confidence reasons
 *      with distinctive phrasing.
 *   2. no_authority — a clear "wrong decision-maker" signal.
 *   3. timing — a softer "not now" signal.
 *   4. not_interested — the generic catch-all decline phrasing, checked
 *      last so it doesn't swallow a more specific, more useful reason
 *      ("not interested" would otherwise match the tail end of "not
 *      interested because it's too expensive").
 *   5. "none" is the honest fallback when no theme is detected — never a
 *      forced guess.
 */

export type ObjectionTheme =
  | "price"
  | "timing"
  | "competitor"
  | "no_budget"
  | "no_authority"
  | "not_interested"
  | "none";

export type ObjectionConfidence = "high" | "medium" | "low";

export interface ClassifyObjectionResult {
  theme: ObjectionTheme;
  confidence: ObjectionConfidence;
}

interface ObjectionRule {
  theme: Exclude<ObjectionTheme, "none">;
  confidence: ObjectionConfidence;
  patterns: RegExp[];
}

const RULES: ObjectionRule[] = [
  {
    theme: "no_budget",
    confidence: "high",
    patterns: [
      /\bno\s+budget\b/i,
      /\bdon'?t\s+have\s+(the\s+)?budget\b/i,
      /\bbudget\s+(has\s+been\s+|was\s+)?cut\b/i,
      /\bcan'?t\s+afford\b/i,
      /\bnot\s+budgeted\s+for\b/i,
      /\bno\s+funding\b/i,
    ],
  },
  {
    theme: "price",
    confidence: "high",
    patterns: [
      /\btoo\s+expensive\b/i,
      /\bpricing\s+is\s+(too\s+)?high\b/i,
      /\bprice\s+is\s+(too\s+)?high\b/i,
      /\bout\s+of\s+(our\s+)?price\s+range\b/i,
      /\bcosts?\s+too\s+much\b/i,
      /\ba\s+cheaper\s+(option|alternative)\b/i,
      /\bcan'?t\s+justify\s+the\s+(cost|price)\b/i,
    ],
  },
  {
    theme: "competitor",
    confidence: "high",
    patterns: [
      /\b(went|going)\s+with\s+(a\s+)?competitor\b/i,
      /\bchose\s+a\s+different\s+(vendor|provider|solution|tool)\b/i,
      /\balready\s+(using|have)\s+a\s+(different\s+)?(tool|vendor|provider|solution)\b/i,
      /\bgoing\s+with\s+(another|a\s+different)\s+(vendor|provider|company)\b/i,
      /\bsigned\s+with\s+someone\s+else\b/i,
      /\bdecided\s+to\s+go\s+with\s+[\w.'-]+(\s[\w.'-]+)?\s+instead\b/i,
    ],
  },
  {
    theme: "no_authority",
    confidence: "medium",
    patterns: [
      /\bnot\s+my\s+decision\b/i,
      /\bneed\s+(approval|sign[\s-]?off)\s+from\b/i,
      /\bi'?m\s+not\s+the\s+decision[\s-]?maker\b/i,
      /\bhave\s+to\s+check\s+with\s+(my\s+)?(boss|manager|team|leadership)\b/i,
      /\bnot\s+authorized\s+to\b/i,
      /\babove\s+my\s+pay\s+grade\b/i,
    ],
  },
  {
    theme: "timing",
    confidence: "medium",
    patterns: [
      /\bbad\s+timing\b/i,
      /\bnot\s+the\s+right\s+time\b/i,
      /\brevisit\s+(this\s+)?(next|later)\s+(quarter|year|month)\b/i,
      /\bcome\s+back\s+(to\s+us\s+)?(in\s+)?(a\s+)?(few\s+)?(months?|quarter)\b/i,
      /\btoo\s+busy\s+right\s+now\b/i,
      /\bnot\s+a\s+priority\s+right\s+now\b/i,
      /\bmaybe\s+(next|later)\s+(quarter|year)\b/i,
    ],
  },
  {
    theme: "not_interested",
    confidence: "medium",
    patterns: [
      /\bnot\s+interested\b/i,
      /\bno\s+longer\s+interested\b/i,
      /\bnot\s+a\s+(good\s+)?fit\b/i,
      /\bdon'?t\s+need\s+(this|it)\b/i,
      /\bno\s+need\s+for\s+(this|it)\b/i,
      /\bgoing\s+to\s+pass\b/i,
    ],
  },
];

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Classifies free text into an objection theme bucket. Deterministic:
 * same input always yields the same output. See module doc for rule
 * ordering/rationale.
 */
export function classifyObjection(text: string | null | undefined): ClassifyObjectionResult {
  const normalized = normalize(text ?? "");

  if (normalized.length === 0) {
    return { theme: "none", confidence: "low" };
  }

  for (const rule of RULES) {
    if (rule.patterns.some((pattern) => pattern.test(normalized))) {
      return { theme: rule.theme, confidence: rule.confidence };
    }
  }

  return { theme: "none", confidence: "low" };
}
