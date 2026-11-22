/**
 * Buying-signal detection: a simple, real keyword/phrase heuristic over a
 * block of text ALREADY obtained from permitted public sources elsewhere in
 * the app (e.g. a discovered_organizations.raw_metadata summary, or a
 * crawled page's text). This function does not itself scrape or fetch
 * anything new — it only classifies text the caller already has, and never
 * invents a signal with no backing text (no match => no signal returned).
 *
 * Rules are checked in order, word-boundary-aware, case-insensitive.
 * Confidence reflects how specific the matched phrase was: a precise phrase
 * (e.g. "series a", "raised $10m") is `high`; a more generic phrase (e.g.
 * bare "hiring") is `medium`. Nothing here is ever `low` by default — `low`
 * is reserved for future rules with deliberately weak phrasing; today's
 * rule set only emits `high`/`medium`.
 */

export type BuyingSignalType = "hiring" | "funding" | "expansion" | "leadership_change" | "product_launch" | "other";
export type BuyingSignalConfidence = "high" | "medium" | "low";

export interface DetectedBuyingSignal {
  signalType: BuyingSignalType;
  detail: string;
  confidence: BuyingSignalConfidence;
  sourceUrl?: string;
}

interface SignalRule {
  signalType: BuyingSignalType;
  pattern: RegExp;
  confidence: BuyingSignalConfidence;
  describe: (matchedText: string) => string;
}

// Ordered rule list. More specific/high-value phrases are listed (and thus
// matched) ahead of generic ones for the same signal type isn't required
// here since every match is reported — order only matters for readability.
const RULES: SignalRule[] = [
  // --- funding (checked first: often the most specific, highest-value phrasing) ---
  {
    signalType: "funding",
    pattern: /\bseries\s+[a-e]\b/i,
    confidence: "high",
    describe: (m) => `Mentions a funding round ("${m.trim()}")`,
  },
  {
    signalType: "funding",
    pattern: /\bseed\s+round\b/i,
    confidence: "high",
    describe: (m) => `Mentions a seed round ("${m.trim()}")`,
  },
  {
    signalType: "funding",
    pattern: /\braised\s+\$[\d,.]+\s?(?:k|m|b|million|billion)?\b/i,
    confidence: "high",
    describe: (m) => `Mentions a specific raise amount ("${m.trim()}")`,
  },
  {
    signalType: "funding",
    pattern: /\bfunding\b/i,
    confidence: "medium",
    describe: () => `Mentions "funding"`,
  },

  // --- hiring ---
  {
    signalType: "hiring",
    pattern: /\bopen\s+positions?\b/i,
    confidence: "high",
    describe: (m) => `Mentions open positions ("${m.trim()}")`,
  },
  {
    signalType: "hiring",
    pattern: /\bwe['’]?re\s+hiring\b/i,
    confidence: "high",
    describe: (m) => `Mentions actively hiring ("${m.trim()}")`,
  },
  {
    signalType: "hiring",
    pattern: /\bjoin\s+our\s+team\b/i,
    confidence: "medium",
    describe: (m) => `Mentions joining the team ("${m.trim()}")`,
  },
  {
    signalType: "hiring",
    pattern: /\bhiring\b/i,
    confidence: "medium",
    describe: () => `Mentions "hiring"`,
  },

  // --- expansion ---
  {
    signalType: "expansion",
    pattern: /\bnow\s+expanding\s+to\b/i,
    confidence: "high",
    describe: (m) => `Mentions expanding to a new market ("${m.trim()}")`,
  },
  {
    signalType: "expansion",
    pattern: /\bnew\s+office\b/i,
    confidence: "high",
    describe: (m) => `Mentions a new office ("${m.trim()}")`,
  },
  {
    signalType: "expansion",
    pattern: /\blaunching\s+in\b/i,
    confidence: "medium",
    describe: (m) => `Mentions launching in a new location ("${m.trim()}")`,
  },

  // --- leadership_change ---
  {
    signalType: "leadership_change",
    pattern: /\bnew\s+ceo\b/i,
    confidence: "high",
    describe: (m) => `Mentions a new CEO ("${m.trim()}")`,
  },
  {
    signalType: "leadership_change",
    pattern: /\bappointed\s+as\b/i,
    confidence: "medium",
    describe: (m) => `Mentions a leadership appointment ("${m.trim()}")`,
  },

  // --- product_launch ---
  {
    signalType: "product_launch",
    pattern: /\bnow\s+available\b/i,
    confidence: "medium",
    describe: (m) => `Mentions a product now available ("${m.trim()}")`,
  },
  {
    signalType: "product_launch",
    pattern: /\blaunches\b/i,
    confidence: "medium",
    describe: () => `Mentions "launches"`,
  },
  {
    signalType: "product_launch",
    pattern: /\bintroducing\b/i,
    confidence: "medium",
    describe: () => `Mentions "introducing"`,
  },
];

/**
 * Scans `text` against the ordered rule list and returns one detected
 * signal per matching rule (a block of text can legitimately surface more
 * than one signal type, e.g. both "hiring" and "new office"). Returns an
 * empty array if nothing matches — never fabricates a signal.
 */
export function detectBuyingSignals(text: string, sourceUrl?: string): DetectedBuyingSignal[] {
  if (!text || text.trim().length === 0) return [];

  const signals: DetectedBuyingSignal[] = [];
  for (const rule of RULES) {
    const match = rule.pattern.exec(text);
    if (match) {
      signals.push({
        signalType: rule.signalType,
        detail: rule.describe(match[0]),
        confidence: rule.confidence,
        ...(sourceUrl ? { sourceUrl } : {}),
      });
    }
  }
  return signals;
}
