/**
 * classifyReply: roadmap item 13 ("Reply handling") — classify an inbound
 * reply as interested / not_now / wrong_person / unsubscribe / unclassified.
 *
 * This is a REAL but deliberately SIMPLE heuristic classifier: ordered,
 * word-boundary-aware, case-insensitive keyword/pattern matching. It is NOT
 * an LLM call — no LLM API key is wired up in this environment. The function
 * signature here (`text in, { classification, confidence } out`) is the
 * seam: a future upgrade can swap the body for a real LLM call (or a
 * classifier that also uses one) without touching any caller
 * (src/routes/replies.ts, and eventually a real inbox-integration poller).
 *
 * Rule priority is intentional, not incidental:
 *   1. unsubscribe is checked FIRST, before anything else, because it
 *      carries legal/compliance weight (CAN-SPAM/GDPR-style opt-out
 *      obligations) and must never lose to a looser "interested" match —
 *      e.g. "stop emailing me, not interested" must classify as
 *      unsubscribe, not not_now.
 *   2. wrong_person next — redirecting outreach to the right contact (or
 *      recording that this one has left) is also a clear, high-value signal
 *      that shouldn't be drowned out by incidental positive words.
 *   3. interested, then not_now — the two "engaged, read the message"
 *      outcomes, interested checked first since a reply that is both
 *      interested-sounding and vaguely declining ("sounds good but not
 *      right now") should land as the more actionable not_now bucket only
 *      when the decline phrasing is unambiguous (see NOT_NOW patterns).
 *   4. unclassified is the fallback when nothing matches — this is the
 *      honest "a human should read this" bucket, not a forced guess.
 *
 * Each rule is a small, independently readable list of regexes rather than
 * one large inscrutable pattern, specifically so it stays easy to audit and
 * extend.
 */

export type ReplyClassification = "interested" | "not_now" | "wrong_person" | "unsubscribe" | "unclassified";
export type ReplyConfidence = "high" | "medium" | "low";

export interface ClassifyReplyResult {
  classification: ReplyClassification;
  confidence: ReplyConfidence;
}

interface ClassificationRule {
  classification: Exclude<ReplyClassification, "unclassified">;
  confidence: ReplyConfidence;
  patterns: RegExp[];
}

// Word-boundary-aware, case-insensitive. Patterns are written over a
// whitespace-normalized version of the input (see normalize() below) so
// phrases spanning punctuation/newlines ("stop.\nEmailing me") still match.
const RULES: ClassificationRule[] = [
  // 1. Unsubscribe — checked first; never let this lose to anything else.
  {
    classification: "unsubscribe",
    confidence: "high",
    patterns: [
      /\bunsubscribe\b/i,
      /\bstop\s+emailing\s+me\b/i,
      /\bstop\s+contacting\s+me\b/i,
      /\bstop\s+messaging\s+me\b/i,
      /\bremove\s+me\b/i,
      /\btake\s+me\s+off\s+(this|your|the)\s+list\b/i,
      /\bopt[\s-]?out\b/i,
      /\bdo\s+not\s+contact\s+me\b/i,
      /\bplease\s+stop\b/i,
    ],
  },
  // 2. Wrong person — high confidence for explicit "wrong contact" phrasing,
  // medium for the softer "left the company" / "contact X instead" signals.
  {
    classification: "wrong_person",
    confidence: "high",
    patterns: [
      /\bwrong\s+person\b/i,
      /\bnot\s+the\s+right\s+(contact|person)\b/i,
      /\byou\s+(have|'ve)\s+the\s+wrong\s+(contact|person|email)\b/i,
    ],
  },
  {
    classification: "wrong_person",
    confidence: "medium",
    patterns: [
      /\bi\s+(don't|do not)\s+work\s+(here|there)\s+any\s*more\b/i,
      /\bno\s+longer\s+(work|employed)\s+(here|there|at)\b/i,
      /\bplease\s+contact\s+[\w.'-]+(\s[\w.'-]+)?\s+instead\b/i,
      /\breach\s+out\s+to\s+[\w.'-]+(\s[\w.'-]+)?\s+instead\b/i,
      /\bi('m| am)\s+no\s+longer\s+(the\s+)?(right\s+)?(contact|person)\b/i,
    ],
  },
  // 3. Interested — checked before not_now so a clearly positive reply
  // ("sounds good, let's talk") isn't misclassified by a later, looser
  // decline rule.
  {
    classification: "interested",
    confidence: "high",
    patterns: [
      /\blet'?s\s+(talk|chat|connect|schedule)\b/i,
      /\bschedule\s+a\s+call\b/i,
      /\bbook\s+a\s+(call|meeting|time)\b/i,
      /\bsend\s+me\s+(a\s+)?(calendar|calendly|invite|link)\b/i,
      /\bi'?m\s+interested\b/i,
      /\bwe'?re\s+interested\b/i,
    ],
  },
  {
    classification: "interested",
    confidence: "medium",
    patterns: [
      // Negative lookbehind excludes "not interested" / "no longer
      // interested" so a decline doesn't get misread as positive interest.
      /(?<!not\s)(?<!no longer\s)\binterested\b/i,
      /\btell\s+me\s+more\b/i,
      /\bsounds\s+good\b/i,
      /\bsounds\s+interesting\b/i,
      /\bwould\s+love\s+to\s+(learn|hear)\s+more\b/i,
      /\bkeen\s+to\s+(learn|hear)\s+more\b/i,
    ],
  },
  // 4. Not now / decline.
  {
    classification: "not_now",
    confidence: "medium",
    patterns: [
      /\bnot\s+interested\b/i,
      /\bnot\s+(right\s+)?now\b/i,
      /\bmaybe\s+later\b/i,
      /\bno\s+thanks?\b/i,
      /\bnot\s+a\s+(good\s+)?fit\b/i,
      /\bcircle\s+back\s+later\b/i,
      /\bcheck\s+back\s+(with\s+me\s+)?(in\s+)?(a\s+)?(few\s+)?(months?|weeks?|quarter)\b/i,
    ],
  },
];

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Classifies raw reply text into a roadmap-item-13 bucket. Deterministic:
 * same input always yields the same output. See module doc for rule
 * ordering/rationale.
 */
export function classifyReply(text: string): ClassifyReplyResult {
  const normalized = normalize(text ?? "");

  if (normalized.length === 0) {
    return { classification: "unclassified", confidence: "low" };
  }

  for (const rule of RULES) {
    if (rule.patterns.some((pattern) => pattern.test(normalized))) {
      return { classification: rule.classification, confidence: rule.confidence };
    }
  }

  return { classification: "unclassified", confidence: "low" };
}
