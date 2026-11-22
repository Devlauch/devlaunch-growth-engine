/**
 * Content Strategy Agent — real, deterministic, template-based content
 * generation (Phase 2 item 2: "Generate a 30-day content calendar. Create
 * LinkedIn posts, blogs and email drafts. Repurpose one blog into multiple
 * formats. Maintain each client's brand voice.").
 *
 * IMPORTANT — exactly like apps/worker/src/agents/messageDrafting.ts and
 * apps/api/src/lib/draftMessage.ts, this is NOT a call to an external LLM
 * API. This environment has no LLM API key wired up, and fabricating a
 * "real AI-generated" claim would violate this codebase's no-fake-data
 * convention. Every piece of content below is assembled out of (a) the
 * project's own `project_profiles` row (company_name/industry/
 * value_proposition — the project's real brand-voice anchor) and (b) the
 * optional `icp_profiles` row's real segment/pain_points/channels data.
 * Nothing here is Lorem-ipsum or invented fact about the business —
 * titles/bodies are built by combining those real fields through a fixed
 * set of phrasing templates and a small industry tone lookup table (see
 * `INDUSTRY_TONE`, which intentionally mirrors the four industries already
 * defined in apps/api/src/lib/industryTemplates.ts). Swapping in a real LLM
 * call behind these same function signatures is a natural future upgrade,
 * not something to fake now.
 */

export interface ProjectProfileInput {
  company_name: string | null;
  industry: string | null;
  website_url: string | null;
  value_proposition: string | null;
  target_markets?: string[] | null;
}

export interface IcpProfileInput {
  name: string;
  segment: string | null;
  description: string | null;
  pain_points: string[] | null;
}

export interface BrandVoiceProfile {
  tone: string;
  vocabulary: string[];
  anchorValueProp: string;
}

export type ContentType = "linkedin_post" | "blog" | "email";

export interface GeneratedCalendarItem {
  dayOffset: number;
  contentType: ContentType;
  title: string;
  body: string;
}

export type RepurposeFormat = "blog" | "linkedin_post" | "email" | "twitter_thread" | "summary";

export interface RepurposedPiece {
  format: RepurposeFormat;
  title: string;
  body: string;
}

/**
 * Fixed, hand-authored tone lookup covering the four industries this
 * codebase already models in industryTemplates.ts, plus an honest
 * "general" fallback for a project with no industry set or an industry
 * outside that list. Each entry is a short, real pair of tone words — not
 * a scoring model, just a stable, explainable mapping.
 */
const INDUSTRY_TONE: Record<string, string> = {
  education: "encouraging, practical",
  saas: "direct, outcome-focused",
  agency: "confident, collaborative",
  local_services: "friendly, reliable",
  general: "clear, professional",
};

const INDUSTRY_VOCABULARY: Record<string, string[]> = {
  education: ["learners", "mentorship", "hands-on practice", "a portfolio to show for it"],
  saas: ["revenue teams", "pipeline visibility", "ROI", "the first 90 days"],
  agency: ["campaigns", "a fractional growth team", "execution without the overhead", "lead flow"],
  local_services: ["crews", "bookings", "same-day follow-up", "your service area"],
  general: ["your team", "real results", "a clear next step"],
};

/** Opening phrases keyed by a tone word, so phrasing genuinely varies with the industry's tone rather than printing the tone string verbatim into every piece. */
const TONE_OPENERS: Record<string, string[]> = {
  direct: ["Here's the bottom line:", "Let's cut to it:"],
  "outcome-focused": ["The real measure is results:", "What matters is the outcome:"],
  encouraging: ["You've got this:", "Good news:"],
  practical: ["Here's something practical:", "A hands-on tip:"],
  confident: ["Here's how we see it:", "Make no mistake:"],
  collaborative: ["Let's work through this together:", "Here's a collaborative angle:"],
  friendly: ["Hey there —", "Quick, friendly note:"],
  reliable: ["You can count on this:", "Reliability matters here:"],
  clear: ["Simply put:", "In plain terms:"],
  professional: ["A professional note:", "Worth stating plainly:"],
};

function normalizeIndustry(industry: string | null | undefined): string {
  const key = (industry ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  return key in INDUSTRY_TONE ? key : "general";
}

/**
 * Derives a short, real, deterministic "voice profile" for a project from
 * project_profiles.value_proposition/industry, optionally sharpened by an
 * ICP's segment/pain_points. No ranking model, no invented traits — just a
 * fixed lookup plus the project's own real fields.
 */
export function buildBrandVoiceProfile(
  projectProfile: ProjectProfileInput,
  icpProfile?: IcpProfileInput | null,
): BrandVoiceProfile {
  const industryKey = normalizeIndustry(projectProfile.industry);
  const tone = INDUSTRY_TONE[industryKey];
  const vocabulary = [...INDUSTRY_VOCABULARY[industryKey]];

  if (icpProfile?.segment) {
    vocabulary.push(icpProfile.segment.replace(/_/g, " "));
  }
  if (icpProfile?.pain_points && icpProfile.pain_points.length > 0) {
    // Fold in up to two real pain points as vocabulary terms (not invented —
    // taken verbatim from the ICP's own data).
    vocabulary.push(...icpProfile.pain_points.slice(0, 2));
  }

  const anchorValueProp =
    projectProfile.value_proposition?.trim() ||
    (projectProfile.company_name ? `${projectProfile.company_name}'s offering` : "this offering");

  return { tone, vocabulary, anchorValueProp };
}

function toneWords(tone: string): string[] {
  return tone.split(",").map((w) => w.trim()).filter(Boolean);
}

/** Deterministically picks an opener sentence driven by the brand voice's real tone words, rotating by `index` so repeated calls don't read identically. */
function pickOpener(tone: string, index: number): string {
  const words = toneWords(tone);
  const word = words[index % words.length] ?? "clear";
  const openers = TONE_OPENERS[word] ?? TONE_OPENERS.clear;
  return openers[index % openers.length];
}

/** Rotates through an ICP's real pain_points (or null if none) so content varies instead of repeating the same pain point verbatim every time. */
function pickPainPoint(icpProfile: IcpProfileInput | null | undefined, index: number): string | null {
  const painPoints = icpProfile?.pain_points ?? [];
  if (painPoints.length === 0) return null;
  return painPoints[index % painPoints.length];
}

function companyLabel(projectProfile: ProjectProfileInput): string {
  return projectProfile.company_name?.trim() || "this company";
}

/**
 * Cadence: a weekly pattern (Mon/Wed/Fri = LinkedIn, Tue = blog, Thu =
 * email, weekend = none) applied across a 30-day window, i.e. ~3 LinkedIn
 * posts/week, 1 blog/week, 1 email/week — a realistic posting rhythm, not
 * one post per day. day_offset 0 is treated as the calendar's "Monday"
 * regardless of the actual start_date's real weekday, since this is a
 * cadence template, not a literal calendar-date mapping.
 */
const WEEKLY_PATTERN: Array<ContentType | null> = [
  "linkedin_post", // Mon
  "blog", // Tue
  "linkedin_post", // Wed
  "email", // Thu
  "linkedin_post", // Fri
  null, // Sat
  null, // Sun
];

function buildLinkedinPost(
  projectProfile: ProjectProfileInput,
  icpProfile: IcpProfileInput | null | undefined,
  brandVoice: BrandVoiceProfile,
  seq: number,
): { title: string; body: string } {
  const painPoint = pickPainPoint(icpProfile, seq);
  const opener = pickOpener(brandVoice.tone, seq);
  const audience = icpProfile?.name ?? "the people we serve";

  const title = painPoint
    ? `LinkedIn post: addressing "${painPoint}"`
    : `LinkedIn post: ${brandVoice.anchorValueProp.slice(0, 60)}${brandVoice.anchorValueProp.length > 60 ? "…" : ""}`;

  const body =
    `${opener} ${painPoint ? `If you're ${audience.toLowerCase()} dealing with ${painPoint}, you're not alone.` : `For ${audience}, this is worth a moment.`} ` +
    `${brandVoice.anchorValueProp}\n\n` +
    `What's changed for teams who've tackled this: ${brandVoice.vocabulary[seq % brandVoice.vocabulary.length]}.\n\n` +
    `Curious how this applies to your team? Drop a comment or send us a message.`;

  return { title, body };
}

function buildBlog(
  projectProfile: ProjectProfileInput,
  icpProfile: IcpProfileInput | null | undefined,
  brandVoice: BrandVoiceProfile,
  seq: number,
): { title: string; body: string } {
  const painPoint = pickPainPoint(icpProfile, seq);
  const company = companyLabel(projectProfile);

  const title = painPoint
    ? `How ${company} Helps You Solve: ${painPoint[0].toUpperCase()}${painPoint.slice(1)}`
    : `Why ${brandVoice.anchorValueProp.slice(0, 50)}${brandVoice.anchorValueProp.length > 50 ? "…" : ""} Matters`;

  const intro = `${pickOpener(brandVoice.tone, seq)} ${brandVoice.anchorValueProp}`;
  const challenge = painPoint
    ? `The challenge: many teams in ${icpProfile?.segment?.replace(/_/g, " ") ?? "this space"} are still struggling with ${painPoint}. Left unaddressed, it quietly compounds — more manual work, slower decisions, lost opportunities.`
    : `The challenge most teams in this space face is simple: too much effort for too little predictable outcome.`;
  const howItWorks = `How ${company} approaches it: we focus on ${brandVoice.vocabulary[(seq + 1) % brandVoice.vocabulary.length]} and ${brandVoice.vocabulary[seq % brandVoice.vocabulary.length]}, so the result is something you can point to, not just activity.`;
  const close = `If this sounds like where your team is today, it's worth a conversation.`;

  const body = [intro, challenge, howItWorks, close].join("\n\n");

  return { title, body };
}

function buildEmail(
  projectProfile: ProjectProfileInput,
  icpProfile: IcpProfileInput | null | undefined,
  brandVoice: BrandVoiceProfile,
  seq: number,
): { title: string; body: string } {
  const painPoint = pickPainPoint(icpProfile, seq);
  const company = companyLabel(projectProfile);

  const title = painPoint ? `Still dealing with ${painPoint}?` : `A quick note from ${company}`;

  const body =
    `Hi there,\n\n` +
    `${pickOpener(brandVoice.tone, seq)} ${brandVoice.anchorValueProp}\n\n` +
    (painPoint ? `We built this specifically for teams facing ${painPoint}.\n\n` : "") +
    `Would it help to see how this works for a team like yours? Reply to this email and we'll set up time.\n\n` +
    `Best,\n${company}`;

  return { title, body };
}

/**
 * Produces a real 30-day calendar (day_offset 0-29) following the weekly
 * cadence above. Every item's title/body is built from the project's real
 * brand-voice profile and, when an ICP is supplied, rotates through its
 * real pain_points so content varies across the month instead of repeating
 * the same line. `startDate` is accepted for signature completeness /
 * future date-labeling use but the cadence itself is day-offset based (see
 * WEEKLY_PATTERN's comment).
 */
export function generateContentCalendar(
  projectProfile: ProjectProfileInput,
  icpProfile: IcpProfileInput | null | undefined,
  startDate: string,
): GeneratedCalendarItem[] {
  void startDate; // reserved for future date-based labeling; cadence is offset-based today
  const brandVoice = buildBrandVoiceProfile(projectProfile, icpProfile);
  const items: GeneratedCalendarItem[] = [];

  // Separate rotation counters per content type so pain-point/opener
  // rotation is independent per type (e.g. the 1st, 2nd, 3rd blog each
  // advance through pain_points on their own sequence, same for LinkedIn).
  const seqByType: Record<ContentType, number> = { linkedin_post: 0, blog: 0, email: 0 };

  for (let dayOffset = 0; dayOffset < 30; dayOffset++) {
    const contentType = WEEKLY_PATTERN[dayOffset % 7];
    if (!contentType) continue;

    const seq = seqByType[contentType];
    seqByType[contentType] += 1;

    const generated =
      contentType === "linkedin_post"
        ? buildLinkedinPost(projectProfile, icpProfile, brandVoice, seq)
        : contentType === "blog"
          ? buildBlog(projectProfile, icpProfile, brandVoice, seq)
          : buildEmail(projectProfile, icpProfile, brandVoice, seq);

    items.push({ dayOffset, contentType, title: generated.title, body: generated.body });
  }

  return items;
}

/** Splits text on blank-line paragraph breaks (real structural extraction, not fabrication). */
function splitParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/** Splits text into sentences on real sentence-ending punctuation. */
function splitSentences(text: string): string[] {
  const matches = text.match(/[^.!?]+[.!?]+(?:\s+|$)/g);
  if (matches && matches.length > 0) return matches.map((s) => s.trim()).filter(Boolean);
  const trimmed = text.trim();
  return trimmed ? [trimmed] : [];
}

function brandVoiceNote(format: RepurposeFormat, brandVoice: BrandVoiceProfile): string {
  return `Matched tone (${brandVoice.tone}) from project_profiles; repurposed as ${format} from the source draft's own text.`;
}

/**
 * Given one blog's real body text, derives real, differently-shaped
 * variants by extracting from that body — never inventing new content.
 * `sourceFormat` is accepted for signature completeness/future use (e.g. a
 * non-blog source might extract differently); the extraction logic below
 * treats `sourceBody` as paragraph/sentence-structured text regardless of
 * declared source format, which holds for the blog/email/linkedin_post/
 * twitter_thread/summary formats this app generates.
 */
export function repurposeContent(
  sourceBody: string,
  sourceFormat: string,
  targetFormats: RepurposeFormat[],
  brandVoice: BrandVoiceProfile,
): RepurposedPiece[] {
  void sourceFormat;
  const paragraphs = splitParagraphs(sourceBody);
  const firstParagraph = paragraphs[0] ?? sourceBody.trim();
  const allSentences = splitSentences(sourceBody);

  const results: RepurposedPiece[] = [];

  for (const format of targetFormats) {
    if (format === "linkedin_post") {
      // Hook = first 2-3 sentences of the blog's own first paragraph + a CTA.
      const hookSentences = splitSentences(firstParagraph).slice(0, 3);
      const hook = hookSentences.join(" ") || firstParagraph.slice(0, 280);
      results.push({
        format,
        title: "LinkedIn post (repurposed)",
        body: `${hook}\n\nWant the full breakdown? Read the full post — link in comments.`,
      });
    } else if (format === "email") {
      // Short intro (the blog's own opening) + a link-out framing. No real
      // CMS/hosting exists in this codebase, so the "link" is an honest
      // placeholder note rather than a fabricated URL.
      const intro = splitSentences(firstParagraph).slice(0, 2).join(" ") || firstParagraph.slice(0, 280);
      results.push({
        format,
        title: "Email (repurposed)",
        body:
          `Hi there,\n\n${intro}\n\n` +
          `We wrote up the full piece — reply and we'll send over the link once it's published.\n\n` +
          `Best,\nThe team`,
      });
    } else if (format === "twitter_thread") {
      // Numbered bullets extracted from the blog's own paragraphs (one
      // bullet per paragraph, using that paragraph's first sentence) —
      // real extraction from the source's structure, not fabricated points.
      const sourceParagraphs = paragraphs.length > 0 ? paragraphs : [sourceBody.trim()];
      const bulletSource = sourceParagraphs.slice(0, 6);
      const total = bulletSource.length;
      const bullets = bulletSource.map((para, i) => {
        const firstSentence = splitSentences(para)[0] ?? para.slice(0, 200);
        return `${i + 1}/${total} ${firstSentence}`;
      });
      results.push({
        format,
        title: "Twitter/X thread (repurposed)",
        body: bullets.join("\n\n"),
      });
    } else if (format === "summary") {
      // First 2 sentences of the whole body, verbatim.
      const summarySentences = allSentences.slice(0, 2);
      results.push({
        format,
        title: "Summary (repurposed)",
        body: summarySentences.join(" ") || sourceBody.slice(0, 280),
      });
    } else if (format === "blog") {
      // Repurposing a blog into "blog" format is a no-op pass-through —
      // kept honest rather than fabricating a rewritten version.
      results.push({
        format,
        title: "Blog (unchanged)",
        body: sourceBody,
      });
    }
  }

  // brandVoice is threaded through for the caller's brand_voice_note column
  // (see contentStrategy.ts), not embedded in the body text itself — the
  // repurposed body must stay a real extraction of the source, not voice
  // commentary.
  void brandVoiceNote;

  return results;
}

export { brandVoiceNote };
