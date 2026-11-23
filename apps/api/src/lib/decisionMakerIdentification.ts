import type { DecisionMakerCandidate } from "./decisionMakerProvider.js";

/**
 * decisionMakerIdentification.ts: Workstream G1 — extends (never replaces)
 * the existing decision-maker waterfall in decisionMakerProvider.ts /
 * providerWaterfall.ts. Nothing here calls a provider or touches the
 * network; it is a pure, deterministic ranking step applied AFTER real
 * candidates have already been returned by findDecisionMakers() (Hunter /
 * Clearbit / Apollo / the honest NotConfigured stub).
 *
 * Deliberately NOT ML / NOT LLM-based: this is simple, auditable
 * keyword/string matching between a contact's existing `title` field (a
 * real value a provider actually returned, per DecisionMakerCandidate's own
 * contract — "never fabricated") and a tenant-supplied list of target
 * roles (e.g. ["VP Sales", "Head of Growth", "CMO"]). Every score this
 * module produces is fully explained by `matchedKeywords` — nothing is a
 * black box.
 */

/** A contact ranked by relevance against a target-role list. Carries the
 * original candidate through unchanged (rankDecisionMakersByRelevance never
 * mutates/invents a name/title/email — it only adds a score on top of
 * whatever the provider waterfall already returned). */
export interface RankedContact {
  contact: DecisionMakerCandidate;
  /** 0 when the title didn't match any target role at all (still included
   * in the output — ranking, not filtering, is this function's job;
   * callers decide whether to drop zero-score contacts). */
  score: number;
  /** Which target-role keywords this contact's title actually matched,
   * for transparency ("why was this contact ranked here"). Empty when
   * score is 0. */
  matchedKeywords: string[];
  /** The single target role (from the input list) this contact's title
   * matched best, or null when nothing matched. */
  bestMatchedRole: string | null;
}

const STOP_WORDS = new Set(["of", "the", "and", "for", "at", "a", "an", "in", "to"]);

/** Splits a role/title string into lowercase, de-duplicated keyword tokens,
 * dropping punctuation and common stop words so "Head of Growth" tokenizes
 * to ["head", "growth"] rather than also matching every "of"/"the" in any
 * unrelated title. */
function tokenize(value: string): string[] {
  const tokens = value
    .toLowerCase()
    .replace(/[^a-z0-9\s&/-]/g, " ")
    .split(/[\s/&-]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && !STOP_WORDS.has(t));
  return Array.from(new Set(tokens));
}

/**
 * Scores one contact's title against one target role string. Scoring is
 * simple and explainable, highest-confidence match first:
 *   - exact match (case-insensitive, trimmed) of title === targetRole: 100
 *   - title contains the full targetRole phrase (e.g. title "Senior VP
 *     Sales, EMEA" contains "VP Sales" only if the whole phrase is a
 *     substring — handled by the exact-phrase check below): 80
 *   - every keyword token of targetRole appears somewhere in the title's
 *     tokens (e.g. target "Head of Growth" tokens [head, growth] both
 *     present in title "Growth Lead" only if both tokens present — here
 *     "head" would be missing, so this branch needs ALL tokens): 60
 *   - at least one keyword token overlaps (e.g. target "VP Sales" and
 *     title "Sales Director" share "sales"): 30 per matched token, capped
 *     at 59 so a partial overlap never outranks a full-token match.
 *   - no overlap at all: 0.
 */
function scoreTitleAgainstRole(title: string, targetRole: string): { score: number; matched: boolean } {
  const normalizedTitle = title.trim().toLowerCase();
  const normalizedRole = targetRole.trim().toLowerCase();
  if (normalizedTitle.length === 0 || normalizedRole.length === 0) return { score: 0, matched: false };

  if (normalizedTitle === normalizedRole) return { score: 100, matched: true };
  if (normalizedTitle.includes(normalizedRole)) return { score: 80, matched: true };

  const roleTokens = tokenize(targetRole);
  const titleTokens = new Set(tokenize(title));
  if (roleTokens.length === 0) return { score: 0, matched: false };

  const overlap = roleTokens.filter((t) => titleTokens.has(t));
  if (overlap.length === roleTokens.length) return { score: 60, matched: true };
  if (overlap.length > 0) return { score: Math.min(30 * overlap.length, 59), matched: true };

  return { score: 0, matched: false };
}

/**
 * Ranks existing contact records (already returned by the real provider
 * waterfall — see decisionMakerProvider.ts's findDecisionMakers) by how
 * well their `title` matches a tenant-supplied list of target roles.
 *
 * Deterministic and pure: no network call, no randomness, no fabrication —
 * a contact with `title: null` (a provider that found the person but not
 * their title) always scores 0 and is never guessed at. Contacts are
 * returned in descending score order (ties keep their original relative
 * order — stable sort).
 */
export function rankDecisionMakersByRelevance(
  contacts: readonly DecisionMakerCandidate[],
  targetRoles: readonly string[],
): RankedContact[] {
  const ranked: RankedContact[] = contacts.map((contact) => {
    if (!contact.title || targetRoles.length === 0) {
      return { contact, score: 0, matchedKeywords: [], bestMatchedRole: null };
    }

    let bestScore = 0;
    let bestRole: string | null = null;
    const matchedKeywords = new Set<string>();

    for (const role of targetRoles) {
      const { score, matched } = scoreTitleAgainstRole(contact.title, role);
      if (matched) {
        for (const token of tokenize(role)) {
          if (new Set(tokenize(contact.title)).has(token)) matchedKeywords.add(token);
        }
      }
      if (score > bestScore) {
        bestScore = score;
        bestRole = role;
      }
    }

    return {
      contact,
      score: bestScore,
      matchedKeywords: Array.from(matchedKeywords),
      bestMatchedRole: bestRole,
    };
  });

  // Stable sort descending by score (Array.prototype.sort is specified as
  // stable since ES2019 — Node's engine here guarantees this).
  return ranked
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => b.entry.score - a.entry.score || a.index - b.index)
    .map(({ entry }) => entry);
}
