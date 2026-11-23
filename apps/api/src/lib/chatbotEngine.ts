/**
 * chatbotEngine: Phase roadmap item 4, "Website AI Lead Capture Agent".
 *
 * Same honesty convention as src/lib/marketingQa.ts and
 * src/lib/draftMessage.ts: there is no LLM API key configured in this
 * environment, so question-answering here is a REAL deterministic
 * retrieval engine, NOT a fake/random responder and NOT an LLM call.
 *
 *   - Knowledge entries are client-approved Q&A/FAQ rows
 *     (chatbot_knowledge_sources, status='approved' AND is_active=true
 *     ONLY -- see 271_create_chatbot_knowledge_sources.sql's doc comment
 *     and src/routes/chatbotAdmin.ts's approval gate).
 *   - `matchKnowledge` scores every candidate entry against the visitor's
 *     message using real term-frequency/keyword overlap (the same "basic
 *     TF, lowercased, stopword-filtered" spirit as
 *     src/lib/keywordExtraction.ts), weighted by WHERE the overlapping
 *     word appears (question > tags > answer body).
 *   - Below `confidenceThreshold`, there is NO match: the caller (routes/
 *     publicChatbot.ts) must show the project's honest, configured
 *     fallback message ("I don't have an answer for that -- want to leave
 *     your details?") and never fabricate an answer.
 *
 * Swap-in-ready seam: `matchKnowledge(visitorMessage, knowledgeSources,
 * confidenceThreshold)` in, `KnowledgeMatch | null` out. A future version
 * can replace the body of this function with a real LLM/embedding-based
 * retrieval call without any caller needing to change, exactly like
 * marketingQa.ts's `answerQuestion` and draftMessage.ts's `draftMessage`
 * document as their own upgrade seam.
 */

export interface KnowledgeSourceCandidate {
  id: string;
  question: string;
  answer: string;
  tags: string[];
}

export interface KnowledgeMatch {
  sourceId: string;
  answer: string;
  /** 0..1, rounded to 3 decimal places. */
  confidence: number;
}

/** Below this score, matchKnowledge returns null (honest "no answer"). */
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.2;

export const DEFAULT_EXCHANGES_BEFORE_QUALIFYING = 3;

// Small, hardcoded English stopword list -- same spirit as
// keywordExtraction.ts's STOPWORDS (not imported directly: that module
// keeps its list private, and chat messages are short/conversational
// rather than page text, so a couple of conversational filler words are
// added here: "please", "thanks", "hi", "hello").
const ENGINE_STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "then", "else", "so", "of", "to", "in", "on", "at", "for",
  "with", "without", "by", "from", "up", "down", "out", "about", "into", "over", "after", "is", "are",
  "was", "were", "be", "been", "being", "it", "its", "this", "that", "these", "those", "as", "we", "you",
  "your", "our", "us", "they", "their", "he", "she", "his", "her", "them", "i", "my", "me", "do", "does",
  "did", "can", "could", "will", "would", "should", "may", "might", "must", "not", "no", "yes", "all",
  "any", "each", "more", "most", "other", "some", "such", "only", "own", "same", "than", "too", "very",
  "just", "also", "here", "there", "when", "where", "who", "whom", "which", "what", "how", "why", "has",
  "have", "had", "having", "shall", "get", "gets", "got", "one", "two", "new", "please", "thanks", "thank",
  "hi", "hello", "hey", "want", "like", "know",
]);

const WORD_RE = /[a-z][a-z0-9'-]*/g;

function tokenize(text: string): string[] {
  const matches = (text ?? "").toLowerCase().match(WORD_RE) ?? [];
  return matches.filter((word) => word.length >= 2 && !ENGINE_STOPWORDS.has(word));
}

/**
 * Scores every candidate knowledge entry against `visitorMessage` using
 * weighted term overlap (question matches weigh 3x, tag matches 2x, answer
 * matches 1x) normalized against the maximum possible weight for the
 * query, so the result is always a comparable 0..1 confidence. Returns the
 * single best-scoring entry, or `null` when either there are no usable
 * query tokens, no candidates, or the best score is below
 * `confidenceThreshold` -- an honest "I don't know" rather than ever
 * guessing the closest-but-still-wrong entry.
 */
export function matchKnowledge(
  visitorMessage: string,
  knowledgeSources: KnowledgeSourceCandidate[],
  confidenceThreshold: number = DEFAULT_CONFIDENCE_THRESHOLD,
): KnowledgeMatch | null {
  const queryTokens = tokenize(visitorMessage);
  if (queryTokens.length === 0 || knowledgeSources.length === 0) {
    return null;
  }

  let best: KnowledgeMatch | null = null;
  let bestScore = 0;

  for (const source of knowledgeSources) {
    const questionTokens = new Set(tokenize(source.question));
    const answerTokens = new Set(tokenize(source.answer));
    const tagTokens = new Set((source.tags ?? []).flatMap((tag) => tokenize(tag)));

    let weightedHits = 0;
    for (const token of queryTokens) {
      if (questionTokens.has(token)) weightedHits += 3;
      else if (tagTokens.has(token)) weightedHits += 2;
      else if (answerTokens.has(token)) weightedHits += 1;
    }

    const maxPossibleWeight = queryTokens.length * 3;
    const score = maxPossibleWeight > 0 ? weightedHits / maxPossibleWeight : 0;

    if (score > bestScore) {
      bestScore = score;
      best = {
        sourceId: source.id,
        answer: source.answer,
        confidence: Math.round(score * 1000) / 1000,
      };
    }
  }

  if (!best || bestScore < confidenceThreshold) {
    return null;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Explicit "I want to talk to someone / enquire" intent detection
// ---------------------------------------------------------------------------

// Ordered is irrelevant here (unlike marketingQa.ts's INTENTS) -- any single
// match is enough to treat the message as enquiry intent.
const ENQUIRY_INTENT_PATTERNS: RegExp[] = [
  /\bcontact (me|us)\b/i,
  /\btalk to (someone|a human|sales|an agent)\b/i,
  /\bspeak (to|with) (someone|a human|sales|an agent)\b/i,
  /\bget in touch\b/i,
  /\bsign (me|us) up\b/i,
  /\bbook a (call|demo|meeting)\b/i,
  /\bschedule a (call|demo|meeting)\b/i,
  /\bi(?:'m| am) interested\b/i,
  /\bhow much (does|would|will) (it|this) cost\b/i,
  /\bpricing\b/i,
  /\bget a quote\b/i,
  /\bcontact (sales|the team)\b/i,
];

/** Real regex-based detection of "this visitor wants to enquire now". */
export function detectsEnquiryIntent(message: string): boolean {
  const normalized = (message ?? "").trim();
  if (normalized.length === 0) return false;
  return ENQUIRY_INTENT_PATTERNS.some((pattern) => pattern.test(normalized));
}

// ---------------------------------------------------------------------------
// Consent yes/no parsing
// ---------------------------------------------------------------------------

const YES_PATTERNS = [/^\s*(yes|y|yeah|yep|sure|ok(ay)?|agree|i agree|fine|go ahead)\b/i];
const NO_PATTERNS = [/^\s*(no|n|nope|nah|not now|don'?t|decline|no thanks)\b/i];

/**
 * Deterministic yes/no parse for the consent prompt. Returns `null` when
 * the reply is ambiguous (neither clearly yes nor clearly no) -- the
 * caller must honestly re-ask rather than guessing consent either way.
 */
export function parseYesNo(message: string): boolean | null {
  const normalized = (message ?? "").trim();
  if (normalized.length === 0) return null;
  if (YES_PATTERNS.some((p) => p.test(normalized))) return true;
  if (NO_PATTERNS.some((p) => p.test(normalized))) return false;
  return null;
}

// ---------------------------------------------------------------------------
// Contact (name/email) extraction from a free-text visitor reply
// ---------------------------------------------------------------------------

const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/;

export interface ExtractedContact {
  name: string | null;
  email: string | null;
}

/**
 * Deterministic, non-AI parse of a visitor's free-text reply to "what's
 * the best name and email to reach you at?" -- pulls out an email via
 * regex and treats whatever text comes before it (or the whole message, if
 * no email is found) as the name. Never fabricates a name/email that
 * wasn't literally present in the message.
 */
export function extractContact(message: string): ExtractedContact {
  const normalized = (message ?? "").trim();
  const emailMatch = normalized.match(EMAIL_RE);
  const email = emailMatch ? emailMatch[0] : null;

  let namePart = email ? normalized.slice(0, emailMatch!.index).trim() : normalized;
  // Strip common connector words/punctuation so "I'm Jane, jane@x.com" ->
  // "Jane" rather than "I'm Jane,".
  namePart = namePart
    .replace(/^(i'?m|i am|my name is|this is|it'?s)\s+/i, "")
    .replace(/[,;:-]+$/, "")
    .trim();

  return {
    name: namePart.length > 0 ? namePart : null,
    email,
  };
}

// ---------------------------------------------------------------------------
// "Import from website" -- FAQ-like snippet extraction (pre-review only)
// ---------------------------------------------------------------------------

export interface ExtractedFaqSnippet {
  question: string;
  answer: string;
}

const MAX_EXTRACTED_SNIPPETS = 20;

/**
 * Deliberately simple, deterministic heuristic over a crawled page's plain
 * text (already HTML-stripped by src/lib/htmlText.ts's stripHtml): splits
 * into sentences, treats any sentence ending in "?" as a candidate
 * question, and pairs it with the sentence immediately following it as the
 * candidate answer. NOT an LLM summarizer -- it only ever returns text that
 * appears verbatim on the page. These are always inserted as
 * status='pending_review' (see routes/chatbotAdmin.ts's import endpoint)
 * and a human must approve each one before it can ever be used as a live
 * bot answer.
 */
export function extractFaqSnippets(pageText: string): ExtractedFaqSnippet[] {
  const sentences = (pageText ?? "")
    .split(/(?<=[.?!])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const snippets: ExtractedFaqSnippet[] = [];
  for (let i = 0; i < sentences.length - 1 && snippets.length < MAX_EXTRACTED_SNIPPETS; i++) {
    const question = sentences[i];
    const answer = sentences[i + 1];
    if (!question.endsWith("?")) continue;
    if (question.length < 8 || question.length > 300) continue;
    if (answer.endsWith("?")) continue; // next sentence is itself a question -- not a real answer pair
    if (answer.length < 8 || answer.length > 600) continue;
    snippets.push({ question, answer });
  }
  return snippets;
}
