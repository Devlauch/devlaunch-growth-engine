/**
 * Landing Page Builder — real, deterministic, template-based section
 * generation for feature 2 of "DevLaunch Growth Engine": AI Landing Page &
 * Lead Magnet Builder.
 *
 * IMPORTANT — exactly like apps/api/src/lib/contentGeneration.ts (Content
 * Strategy Agent) and apps/worker/src/agents/messageDrafting.ts, this is
 * NOT a call to an external LLM API. This environment has no LLM API key
 * wired up, and fabricating a "real AI-generated" claim would violate this
 * codebase's no-fake-data convention. A landing page's content is never raw
 * freeform HTML assembled from a model; it is always one of a small, fixed
 * set of real section templates (hero / benefits / social_proof / form /
 * cta), filled with:
 *
 *   (a) the project's own project_profiles row (company_name/industry/
 *       value_proposition — the project's real brand-voice anchor), and
 *   (b) the optional icp_profiles row's real segment/pain_points data, and
 *   (c) copy the user typed in directly (headline, subheadline, benefits,
 *       a real testimonial they supply, CTA text/url, qualifying
 *       questions).
 *
 * No block is ever invented without a real input behind it: a
 * social_proof block is only emitted when the caller supplies an actual
 * testimonial quote, and a benefits block falls back to real ICP pain
 * points (rephrased as "no more <pain point>" benefit statements) only
 * when the user hasn't typed their own benefit list. Swapping in a real
 * LLM call behind these same function signatures is a natural future
 * upgrade, not something to fake now.
 */

export interface ProjectProfileInput {
  company_name: string | null;
  industry: string | null;
  value_proposition: string | null;
}

export interface IcpProfileInput {
  name: string;
  segment: string | null;
  pain_points: string[] | null;
}

export interface QualifyingQuestion {
  id: string;
  label: string;
  type: "text" | "select";
  options?: string[];
  required?: boolean;
}

export interface LandingPageCopyInput {
  audienceLabel?: string | null;
  headline?: string | null;
  subheadline?: string | null;
  bodyCopy?: string | null;
  benefits?: string[] | null;
  testimonialQuote?: string | null;
  testimonialAuthor?: string | null;
  ctaText?: string | null;
  ctaUrl?: string | null;
  qualifyingQuestions?: QualifyingQuestion[] | null;
}

export type LandingPageBlockType = "hero" | "benefits" | "social_proof" | "form" | "cta";

export interface HeroBlock {
  type: "hero";
  headline: string;
  subheadline: string;
  body: string | null;
}

export interface BenefitsBlock {
  type: "benefits";
  title: string;
  items: string[];
}

export interface SocialProofBlock {
  type: "social_proof";
  quote: string;
  author: string;
}

export interface FormBlock {
  type: "form";
  title: string;
  questions: QualifyingQuestion[];
}

export interface CtaBlock {
  type: "cta";
  text: string;
  url: string | null;
}

export type LandingPageBlock = HeroBlock | BenefitsBlock | SocialProofBlock | FormBlock | CtaBlock;

function companyLabel(profile: ProjectProfileInput): string {
  return profile.company_name?.trim() || "this company";
}

function defaultHeadline(profile: ProjectProfileInput, audienceLabel?: string | null): string {
  const company = companyLabel(profile);
  if (audienceLabel?.trim()) {
    return `${company} for ${audienceLabel.trim()}`;
  }
  return profile.value_proposition?.trim() || `${company} helps you get real results`;
}

function defaultSubheadline(profile: ProjectProfileInput, icp?: IcpProfileInput | null): string {
  if (profile.value_proposition?.trim()) return profile.value_proposition.trim();
  if (icp?.segment) return `Built for ${icp.segment.replace(/_/g, " ")}`;
  return "See what we can do for your team.";
}

/** Builds the hero block — always present. */
function buildHeroBlock(
  profile: ProjectProfileInput,
  icp: IcpProfileInput | null | undefined,
  copy: LandingPageCopyInput,
): HeroBlock {
  return {
    type: "hero",
    headline: copy.headline?.trim() || defaultHeadline(profile, copy.audienceLabel),
    subheadline: copy.subheadline?.trim() || defaultSubheadline(profile, icp),
    body: copy.bodyCopy?.trim() || null,
  };
}

/**
 * Builds the benefits block. Prefers the user's own benefit copy; falls
 * back to real ICP pain points reframed as benefit statements ("No more
 * <pain point>"). Returns null (block omitted) when neither is available —
 * never invents generic filler benefits.
 */
function buildBenefitsBlock(icp: IcpProfileInput | null | undefined, copy: LandingPageCopyInput): BenefitsBlock | null {
  const userBenefits = (copy.benefits ?? []).map((b) => b.trim()).filter(Boolean);
  if (userBenefits.length > 0) {
    return { type: "benefits", title: "Why it works", items: userBenefits };
  }

  const painPoints = (icp?.pain_points ?? []).map((p) => p.trim()).filter(Boolean);
  if (painPoints.length > 0) {
    return {
      type: "benefits",
      title: "Why it works",
      items: painPoints.slice(0, 5).map((p) => `No more ${p}`),
    };
  }

  return null;
}

/** Only emitted when the caller supplies a real testimonial — never fabricated. */
function buildSocialProofBlock(copy: LandingPageCopyInput): SocialProofBlock | null {
  const quote = copy.testimonialQuote?.trim();
  if (!quote) return null;
  return {
    type: "social_proof",
    quote,
    author: copy.testimonialAuthor?.trim() || "A real customer",
  };
}

/** The enquiry form block — always present so every page can capture a lead. */
function buildFormBlock(copy: LandingPageCopyInput): FormBlock {
  return {
    type: "form",
    title: "Tell us about your needs",
    questions: copy.qualifyingQuestions ?? [],
  };
}

function buildCtaBlock(profile: ProjectProfileInput, copy: LandingPageCopyInput): CtaBlock {
  return {
    type: "cta",
    text: copy.ctaText?.trim() || `Talk to ${companyLabel(profile)}`,
    url: copy.ctaUrl?.trim() || null,
  };
}

/**
 * Builds the full, ordered set of deterministic template blocks for a
 * landing page: hero, benefits (if real data exists), social_proof (if a
 * real testimonial was supplied), form, cta — in that order, matching the
 * brief's named section set exactly.
 */
export function buildLandingPageBlocks(
  profile: ProjectProfileInput,
  icp: IcpProfileInput | null | undefined,
  copy: LandingPageCopyInput,
): LandingPageBlock[] {
  const blocks: LandingPageBlock[] = [buildHeroBlock(profile, icp, copy)];

  const benefits = buildBenefitsBlock(icp, copy);
  if (benefits) blocks.push(benefits);

  const socialProof = buildSocialProofBlock(copy);
  if (socialProof) blocks.push(socialProof);

  blocks.push(buildFormBlock(copy));
  blocks.push(buildCtaBlock(profile, copy));

  return blocks;
}

export type Variant = "a" | "b";

/**
 * Assigns a visitor to variant 'a' or 'b' for a published A/B test. Plain
 * 50/50 random assignment per page view (this codebase has no visitor
 * cookie/session infra to make assignment sticky across views) — the
 * variant actually served is always echoed back to the client and must be
 * passed back on the subsequent submit/track calls so events attribute to
 * the real variant shown, never guessed after the fact.
 */
export function pickVariant(): Variant {
  return Math.random() < 0.5 ? "a" : "b";
}

/**
 * Resolves which blocks to actually render for a request: a variant row
 * with a non-empty `blocks` override replaces the page's base blocks
 * entirely; otherwise (no variant, or a control variant with no override)
 * the landing page's own base blocks are used.
 */
export function resolveRenderedBlocks(
  baseBlocks: LandingPageBlock[],
  variantBlocks: LandingPageBlock[] | null | undefined,
): LandingPageBlock[] {
  if (variantBlocks && variantBlocks.length > 0) return variantBlocks;
  return baseBlocks;
}
