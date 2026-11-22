/**
 * Real, rule-based A/B experiment suggestion generation (Phase 2 item 5,
 * "Conversion Optimization Agent", "A/B experiment suggestions").
 *
 * Every suggestion here is driven by an actual landing page finding or an
 * actual funnel drop-off passed in — never generic filler disconnected
 * from the input data. A clean audit with low drop-off across the board
 * returns an empty array: there is nothing real to suggest, so nothing is
 * invented.
 */

import type { LandingPageFinding } from "./landingPageAudit.js";
import type { FunnelDropoffResult } from "./funnelDropoff.js";

export interface ExperimentSuggestion {
  name: string;
  hypothesis: string;
  variantADescription: string;
  variantBDescription: string;
}

// A drop-off at or above this percent between two consecutive funnel
// stages is considered notable enough to suggest an experiment for —
// below this, funnel attrition is treated as normal/expected rather than
// a specific problem worth A/B testing.
const NOTABLE_DROPOFF_PERCENT = 50;

function suggestionsFromLandingPageFindings(findings: LandingPageFinding[]): ExperimentSuggestion[] {
  const suggestions: ExperimentSuggestion[] = [];

  for (const finding of findings) {
    if (finding.issue === "no_cta_detected" || finding.issue === "no_conversion_path") {
      suggestions.push({
        name: "Add a clear call-to-action",
        hypothesis: `The audited landing page has no detectable CTA (${finding.detail}). Adding a prominent, specific CTA should increase the share of visitors who take a next step.`,
        variantADescription: "Current page, unchanged (no explicit CTA button).",
        variantBDescription: "Same page with a prominent above-the-fold CTA button (e.g. 'Get started' or 'Book a demo').",
      });
    }

    if (finding.issue === "thin_content") {
      suggestions.push({
        name: "Expand landing page content",
        hypothesis: `The audited page is thin on content (${finding.detail}). Visitors may be leaving without enough information to convert; adding substantive copy (benefits, proof points, FAQ) should improve conversion.`,
        variantADescription: "Current page, unchanged (thin content).",
        variantBDescription: "Same page with expanded body copy covering benefits, proof points, and an FAQ section.",
      });
    }

    if (finding.issue === "no_headings") {
      suggestions.push({
        name: "Add page structure with headings",
        hypothesis: `The audited page has no heading elements (${finding.detail}). Visitors scanning the page have no structural cues; adding headings should improve scannability and time-on-page, supporting conversion.`,
        variantADescription: "Current page, unchanged (no headings).",
        variantBDescription: "Same page with a clear heading hierarchy (H1 value proposition, H2 sections).",
      });
    }
  }

  return suggestions;
}

function suggestionsFromFunnelDropoff(dropoff: FunnelDropoffResult): ExperimentSuggestion[] {
  const suggestions: ExperimentSuggestion[] = [];

  for (const stageDropoff of dropoff.dropoffs) {
    if (stageDropoff.dropoffPercent >= NOTABLE_DROPOFF_PERCENT) {
      suggestions.push({
        name: `Reduce ${stageDropoff.fromStage}-to-${stageDropoff.toStage} drop-off`,
        hypothesis: `${stageDropoff.dropoffPercent.toFixed(1)}% of leads are lost between '${stageDropoff.fromStage}' and '${stageDropoff.toStage}', at or above the ${NOTABLE_DROPOFF_PERCENT}% notable-drop-off threshold. Targeting this specific transition (e.g. the outreach/follow-up approach used right after '${stageDropoff.fromStage}') should recover some of that loss.`,
        variantADescription: `Current approach to moving leads from '${stageDropoff.fromStage}' to '${stageDropoff.toStage}', unchanged.`,
        variantBDescription: `Revised approach specifically targeting the '${stageDropoff.fromStage}' to '${stageDropoff.toStage}' transition (e.g. faster follow-up, a different message/channel, or an added touchpoint).`,
      });
    }
  }

  return suggestions;
}

/**
 * Generates real, input-driven experiment suggestions from the most recent
 * landing page audit's findings and the current funnel drop-off. Returns
 * an empty array (not an error) when there is nothing notable in either
 * input — a clean audit and low drop-off never produce invented filler.
 */
export function generateExperimentSuggestions(
  landingPageFindings: LandingPageFinding[],
  funnelDropoff: FunnelDropoffResult,
): ExperimentSuggestion[] {
  return [
    ...suggestionsFromLandingPageFindings(landingPageFindings),
    ...suggestionsFromFunnelDropoff(funnelDropoff),
  ];
}
