/**
 * Milestone 2 (P1): a simple, real, DETERMINISTIC bot classifier — no ML,
 * no third-party service. Checks a session's User-Agent string against a
 * known-bot-pattern list (common search/SEO crawlers + common headless-
 * browser signatures) and nothing else.
 *
 * Honesty note (do not overclaim): this is necessarily incomplete. A
 * sophisticated bot that spoofs a normal browser's User-Agent cannot be
 * detected by this check (or by any deterministic UA-string check) — real
 * bot detection at that level needs behavioral signals (mouse movement,
 * timing, JS-challenge/fingerprinting services) that this codebase
 * deliberately does not build, the same "don't fabricate a stronger
 * guarantee than what's real" convention as every other heuristic in this
 * repo (see e.g. apps/api/src/lib/buyingSignals.ts). Bot sessions are still
 * stored (is_bot = true on site_sessions), never dropped — see
 * apps/api/src/lib/siteAnalytics.ts, which excludes them from the
 * real-traffic aggregates it reports.
 */

// Deliberately conservative/short: well-known crawler and automation UA
// substrings, matched case-insensitively. Each entry is a real, named bot
// family, not a generic "contains the word bot" heuristic (which produces
// too many false positives on normal browser UAs that happen to contain
// unrelated substrings).
const BOT_UA_PATTERNS: RegExp[] = [
  /googlebot/i,
  /bingbot/i,
  /slurp/i, // Yahoo
  /duckduckbot/i,
  /baiduspider/i,
  /yandexbot/i,
  /sogou/i,
  /exabot/i,
  /facebookexternalhit/i,
  /twitterbot/i,
  /linkedinbot/i,
  /whatsapp/i,
  /telegrambot/i,
  /slackbot/i,
  /discordbot/i,
  /ahrefsbot/i,
  /semrushbot/i,
  /mj12bot/i, // Majestic
  /dotbot/i, // Moz
  /screaming\s*frog/i,
  /rogerbot/i, // Moz
  /uptimerobot/i,
  /pingdom/i,
  /gtmetrix/i,
  /applebot/i,
  /petalbot/i,
  /bytespider/i,
  /headlesschrome/i,
  /phantomjs/i,
  /puppeteer/i,
  /playwright/i,
  /selenium/i,
  /python-requests/i,
  /curl\//i,
  /wget\//i,
  /^go-http-client/i,
  /scrapy/i,
  /\bbot\b/i,
  /\bcrawler\b/i,
  /\bspider\b/i,
];

/**
 * Returns true when `userAgent` matches a known-bot pattern. A missing/empty
 * User-Agent is NOT automatically flagged as a bot (many legitimate privacy
 * tools strip it) — absence of evidence isn't evidence of bot-ness here.
 */
export function isLikelyBot(userAgent: string | null | undefined): boolean {
  if (!userAgent) return false;
  return BOT_UA_PATTERNS.some((pattern) => pattern.test(userAgent));
}
