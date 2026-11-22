// Static, hand-authored onboarding-wizard defaults (roadmap item 20).
//
// These are NOT a tenant-editable catalog and are NOT stored in any table —
// they're code-defined starting points that a tenant customizes (edits,
// deletes, adds to) immediately after applying one via
// POST /onboarding/apply. If these ever need to become tenant-editable,
// that's a later migration + table, not a change to this file's shape.

export type IndustryKey = "education" | "saas" | "agency" | "local_services";

export interface IndustryTemplateIcpProfile {
  name: string;
  segment: string;
  description: string;
  painPoints: string[];
  channels: string[];
}

export interface IndustryTemplateScoringCriterion {
  key: string;
  label: string;
  weight: number;
  description: string;
}

export type SequenceStepType = "email" | "call_task" | "linkedin_task" | "follow_up_email" | "final_note";

export interface IndustryTemplateSequenceStep {
  dayOffset: number;
  stepType: SequenceStepType;
  taskInstructions?: string;
}

export interface IndustryTemplate {
  label: string;
  defaultValueProposition: string;
  icpProfiles: IndustryTemplateIcpProfile[];
  scoringCriteria: IndustryTemplateScoringCriterion[];
  sequenceTemplate: {
    name: string;
    steps: IndustryTemplateSequenceStep[];
  };
}

export const INDUSTRY_TEMPLATES: Record<IndustryKey, IndustryTemplate> = {
  // Inspired by (not copied from) the DevPilot Academy dev seed
  // (packages/db/migrations/014_seed_dev_tenant.sql) so a tenant that
  // applies this template sees content consistent with that example data.
  education: {
    label: "Education / Online Academy",
    defaultValueProposition:
      "Hands-on, project-based courses that take learners from fundamentals to job-ready skills, with mentor feedback and a portfolio they can show employers.",
    icpProfiles: [
      {
        name: "Career Switchers",
        segment: "career_switchers",
        description: "Working adults (25-40) looking to move into tech/DevOps roles from an unrelated field.",
        painPoints: [
          "no clear learning path from where they are today",
          "no portfolio to show employers",
          "limited time to study around a full-time job",
        ],
        channels: ["linkedin", "google_search", "referral"],
      },
      {
        name: "Recent Graduates",
        segment: "recent_grads",
        description: "Recent computer science or bootcamp graduates who need practical, production-style experience.",
        painPoints: [
          "degree or bootcamp certificate alone isn't landing interviews",
          "no real-world project experience to point to",
          "competitive, crowded entry-level job market",
        ],
        channels: ["instagram", "youtube", "campus_partnerships"],
      },
      {
        name: "Upskilling Professionals",
        segment: "upskillers",
        description: "Current junior developers or sysadmins upskilling into DevOps/cloud roles for a promotion or raise.",
        painPoints: [
          "employer won't sponsor formal training",
          "unsure which certifications or skills actually matter",
          "needs a flexible evening/weekend pace",
        ],
        channels: ["linkedin", "email_newsletter", "webinars"],
      },
    ],
    scoringCriteria: [
      {
        key: "clear_career_goal",
        label: "Clear, stated career goal (e.g. target job title)",
        weight: 30,
        description: "Lead has articulated a specific role or outcome they're working toward, not just general interest.",
      },
      {
        key: "time_availability",
        label: "Has 10+ hours/week available to study",
        weight: 20,
        description: "Enough weekly time commitment to realistically finish a cohort-paced program.",
      },
      {
        key: "tuition_affordability",
        label: "Can afford tuition without needing financing",
        weight: 25,
        description: "Stated budget or income signal suggests tuition is not a blocking concern.",
      },
      {
        key: "prior_technical_exposure",
        label: "Some prior technical exposure (coursework, self-taught, or current junior role)",
        weight: 25,
        description: "Not starting from zero — has touched code, a terminal, or a related tool before.",
      },
    ],
    sequenceTemplate: {
      name: "Education enrollment nurture",
      steps: [
        { dayOffset: 0, stepType: "email" },
        { dayOffset: 3, stepType: "follow_up_email" },
        {
          dayOffset: 7,
          stepType: "call_task",
          taskInstructions: "Call to answer questions about program fit, schedule, and financing options; offer a seat in the next cohort.",
        },
        {
          dayOffset: 14,
          stepType: "final_note",
          taskInstructions: "If no response, leave a short note referencing the next cohort start date and mark the lead cold for now.",
        },
      ],
    },
  },

  saas: {
    label: "B2B SaaS",
    defaultValueProposition:
      "A platform that helps revenue teams eliminate fragmented, manual reporting without adding headcount, with a measurable ROI case inside the first 90 days.",
    icpProfiles: [
      {
        name: "Series A-B RevOps Leaders",
        segment: "revops_leaders",
        description:
          "VP/Director of RevOps or Sales Ops at 50-300 person B2B SaaS companies evaluating tools to fix pipeline visibility.",
        painPoints: [
          "pipeline data fragmented across CRM, spreadsheets, and BI tools",
          "no single source of truth for pipeline health",
          "a full day a week lost to manual reporting",
        ],
        channels: ["linkedin", "g2_comparison_pages", "outbound_email"],
      },
      {
        name: "IT/Security Evaluators",
        segment: "it_security",
        description: "IT or security leads who must approve any new SaaS vendor before a deal can close.",
        painPoints: [
          "backlog of pending vendor security reviews",
          "SOC 2 and data-residency requirements to verify",
          "risk from shadow IT / unsanctioned tool adoption",
        ],
        channels: ["security_review_portals", "direct_email", "webinars"],
      },
      {
        name: "Economic Buyer (CRO/CFO)",
        segment: "economic_buyer",
        description: "CRO or CFO who owns the budget and needs a clear ROI case before signing.",
        painPoints: [
          "missed quarterly revenue targets",
          "unclear attribution of spend to actual pipeline",
          "board pressure to cut tool sprawl, not add to it",
        ],
        channels: ["referral", "analyst_reports", "executive_roundtables"],
      },
    ],
    scoringCriteria: [
      {
        key: "company_size_fit",
        label: "Employee count in the 50-300 ICP band",
        weight: 25,
        description: "Company size matches the segment this product is built and priced for.",
      },
      {
        key: "tech_stack_fit",
        label: "Uses a CRM we integrate with (Salesforce or HubSpot)",
        weight: 20,
        description: "Integration path exists without a custom build.",
      },
      {
        key: "buying_trigger",
        label: "Recent funding round, new RevOps hire, or stated pipeline-visibility pain",
        weight: 30,
        description: "A concrete, timed trigger event rather than passive interest.",
      },
      {
        key: "budget_authority",
        label: "Contact has budget authority or direct access to it",
        weight: 25,
        description: "Conversation can move toward a commercial decision without re-starting with a new stakeholder.",
      },
    ],
    sequenceTemplate: {
      name: "SaaS outbound sequence",
      steps: [
        { dayOffset: 0, stepType: "email" },
        {
          dayOffset: 3,
          stepType: "linkedin_task",
          taskInstructions: "Send a connection request referencing their recent funding/hiring trigger; no pitch in the note.",
        },
        {
          dayOffset: 7,
          stepType: "call_task",
          taskInstructions: "Call to confirm the pipeline-visibility pain is real and identify who else needs to be in the room.",
        },
        { dayOffset: 10, stepType: "follow_up_email" },
        {
          dayOffset: 14,
          stepType: "final_note",
          taskInstructions: "If no response, send a final breakup email and mark the lead for quarterly re-engagement.",
        },
      ],
    },
  },

  agency: {
    label: "Marketing / Growth Agency",
    defaultValueProposition:
      "A fractional growth team that plugs into your existing marketing function and ships paid, SEO, and lifecycle campaigns without the overhead of full-time hires.",
    icpProfiles: [
      {
        name: "Founder-Led SMBs",
        segment: "founder_led_smb",
        description:
          "Founder/CEO of a 5-30 person company who currently handles marketing personally or via a generalist employee.",
        painPoints: [
          "no time to run campaigns personally anymore",
          "a previous marketing hire didn't work out",
          "inconsistent lead flow month to month",
        ],
        channels: ["referral", "linkedin", "local_networking_events"],
      },
      {
        name: "In-House Marketer Needing Overflow",
        segment: "marketing_lead_overflow",
        description: "A solo marketing manager at a 30-150 person company who needs execution support beyond strategy.",
        painPoints: [
          "stretched too thin across every channel at once",
          "no in-house design or dev capacity to ship campaigns",
          "leadership wants more output without more headcount",
        ],
        channels: ["linkedin", "industry_slack_communities", "conference_sponsorships"],
      },
      {
        name: "PE-Backed Portfolio Companies",
        segment: "pe_portfolio",
        description: "Operating partners or marketing leads at PE-backed companies under pressure to hit growth targets fast.",
        painPoints: [
          "a 90-day value-creation plan with a marketing mandate attached",
          "no existing playbook to scale from",
          "regular growth reporting requirements to the PE firm",
        ],
        channels: ["pe_firm_referral", "warm_intro", "direct_email"],
      },
    ],
    scoringCriteria: [
      {
        key: "monthly_marketing_budget",
        label: "Monthly budget of at least $5k available for paid/agency spend",
        weight: 30,
        description: "Enough budget for a retainer engagement to be viable for both sides.",
      },
      {
        key: "decision_maker_access",
        label: "Direct access to the budget-holder (founder or CMO)",
        weight: 25,
        description: "Avoids stalling in a non-decision-making intermediary.",
      },
      {
        key: "current_marketing_gap",
        label: "Clear, stated gap (no team, no results, or no time)",
        weight: 25,
        description: "A specific, acknowledged problem rather than vague openness to 'exploring options'.",
      },
      {
        key: "contract_readiness",
        label: "Open to a 3-6 month retainer, not a one-off project",
        weight: 20,
        description: "Matches the agency's actual engagement model.",
      },
    ],
    sequenceTemplate: {
      name: "Agency new-business sequence",
      steps: [
        { dayOffset: 0, stepType: "email" },
        { dayOffset: 3, stepType: "follow_up_email" },
        {
          dayOffset: 5,
          stepType: "linkedin_task",
          taskInstructions: "Comment on or react to a recent post, then send a short connection note referencing their current marketing setup.",
        },
        {
          dayOffset: 9,
          stepType: "call_task",
          taskInstructions: "Call to scope the current marketing gap and whether budget exists for a retainer.",
        },
        {
          dayOffset: 14,
          stepType: "final_note",
          taskInstructions: "If no response, send a final check-in and move to a quarterly nurture list.",
        },
      ],
    },
  },

  local_services: {
    label: "Local Services (home & field services)",
    defaultValueProposition:
      "Done-for-you local lead generation and booking so your crews stay full every week, without you having to touch ad accounts or chase down quote follow-ups yourself.",
    icpProfiles: [
      {
        name: "Owner-Operators (1-5 Crews)",
        segment: "owner_operator",
        description:
          "Owner of a home services business (HVAC, plumbing, roofing, landscaping) running 1-5 crews who still handles sales and marketing personally.",
        painPoints: [
          "feast-or-famine lead flow month to month",
          "no time to follow up on quotes same-day",
          "losing jobs to competitors who call back faster",
        ],
        channels: ["google_local_services_ads", "facebook_local", "referral"],
      },
      {
        name: "Office Manager / Dispatcher",
        segment: "office_manager",
        description: "The person who actually answers the phone and books jobs — often the real gatekeeper for any new tool.",
        painPoints: [
          "juggling scheduling, invoicing, and lead intake by hand",
          "missed calls during busy job hours",
          "no CRM, just a paper book or spreadsheet",
        ],
        channels: ["phone", "text_sms", "local_facebook_groups"],
      },
      {
        name: "Multi-Location Franchise Owners",
        segment: "franchise_owner",
        description: "Owner of 2+ territory franchise locations (e.g. a regional home services brand) needing consistent lead volume per territory.",
        painPoints: [
          "lead quality varies wildly by territory",
          "franchisor's co-op marketing fund doesn't cover local demand",
          "hard to compare ROI across locations",
        ],
        channels: ["franchisor_co_op_marketing", "local_seo", "nextdoor"],
      },
    ],
    scoringCriteria: [
      {
        key: "service_area_match",
        label: "Located within an active service area/territory",
        weight: 25,
        description: "The lead is physically reachable by an existing crew without excessive drive time.",
      },
      {
        key: "job_value_fit",
        label: "Average job value above the minimum ticket threshold",
        weight: 25,
        description: "Job size is worth dispatching a crew for, not a below-minimum callout.",
      },
      {
        key: "response_urgency",
        label: "Lead indicates an urgent or same-week need",
        weight: 30,
        description: "Local-services demand is time-sensitive; urgency is the strongest buying signal.",
      },
      {
        key: "contact_reachability",
        label: "Valid phone number and responds within one business day",
        weight: 20,
        description: "A lead that can't be reached quickly rarely converts in this segment.",
      },
    ],
    sequenceTemplate: {
      name: "Local services quote follow-up",
      steps: [
        { dayOffset: 0, stepType: "email" },
        {
          dayOffset: 1,
          stepType: "call_task",
          taskInstructions: "Call same-next-day to confirm the job details and offer the earliest available appointment slot.",
        },
        { dayOffset: 3, stepType: "follow_up_email" },
        {
          dayOffset: 7,
          stepType: "final_note",
          taskInstructions: "If no response, leave a final note and mark the quote as cold; local-services leads go stale fast past a week.",
        },
      ],
    },
  },
};
