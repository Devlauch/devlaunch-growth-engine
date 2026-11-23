# Growth Engine Integration Map

How the platform's existing pieces connect today, versus how they need to
connect to form one coherent customer-acquisition engine. Built from the
findings in `docs/BROADER_WORKSTREAM_AUDIT.md` — every "connected" claim below
traces to a real, cited code path; every "gap" is a confirmed absence (grep'd,
not assumed).

Legend: `━━▶` real, wired, executes today. `╌╌▶` gap — the data exists on
both ends but nothing moves it across automatically. `✕` the downstream
side doesn't exist yet at all.

## 1. Inbound acquisition path

```
Website visitor
   │
   ├─ Landing page (headless JSON, no in-repo renderer) ──╌╌▶  (external site must render it — ✕ in-repo)
   │        │
   │        └─ form submit ━━▶ ingestLead()
   │
   ├─ Lead-capture widget (embeddable, cross-origin) ━━▶ ingestLead()
   │
   └─ AI Chatbot widget ━━▶ consent → qualify → capture ━━▶ ingestLead()

ingestLead() [single shared path, apps/api/src/lib/leadIngestion.ts]
   ├─ INSERT leads                              ━━▶ real
   ├─ INSERT audit_events                        ━━▶ real
   ├─ recordUsageEvent(lead_captured)            ━━▶ real
   ├─ notifyTenantOwnersAndAdmins()               ━━▶ real (in-app only)
   ├─ syncLeadToChatwootContact()                 ━━▶ real, best-effort, never blocks
   └─ scoreLead() / lead_scores                   ╌╌▶ GAP — never called from here
```

**Finding**: the inbound path is architecturally sound — one shared ingestion
function, real side effects, no duplicate insert logic across the three
channels. The one missing link is scoring: a freshly captured lead has no
score until someone manually hits `/recompute`.

## 2. Outbound acquisition path

```
Website analysis (Growth Analyzer)
   │
   └─ accept-icp ━━▶ icp_profiles [existing table, not a second one]

icp_profiles
   │
   └─ matchLeadToAllIcps() ━━▶ icp_match_scores   [real, runs for every new lead via leadGeneration.ts]

ICP configuration
   │
   └─ discovery_sources ━━▶ connector.discover()
        ├─ public_directory (Overpass/OSM)   ━━▶ real, working, free, rate-limited
        ├─ csv_upload                         ╌╌▶ SDK class exists, route rejects it (400)
        ├─ website_crawl (Crawl4AI-backed)    ✕  explicitly rejected, "not yet approved"
        └─ licensed_api (paid B2B directory)  ✕  not configured, no env var reserved yet

discovered_organizations / discovered_contacts
   ├─ enrichLead() ━━▶ company_enrichment        [real logic, but ZERO direct test coverage]
   ├─ verifyEmail() ━━▶ contact verification      ━━▶ real, free (DNS-based), no provider needed
   └─ findDecisionMakers() ╌╌▶ decision_maker_cache  [honest "not_configured" — no Apollo/ZoomInfo/Clearbit key]

"Promote to lead" ━━▶ leads (source='agent') ━━▶ feeds the SAME downstream
                                                    pipeline as inbound... except
                                                    it does NOT call recordUsageEvent/
                                                    notifyTenantOwnersAndAdmins/Chatwoot
                                                    sync (those live inside ingestLead(),
                                                    which this path bypasses — confirmed
                                                    by audit, a real asymmetry)
```

**Finding**: the discovery→enrichment→verification chain is real for the free
tier (Overpass + DNS verification) and honestly stubbed for anything requiring
a paid data provider. The "promote to lead" path creates a real `leads` row
but **skips the shared side-effects** (usage tracking, owner notification,
Chatwoot sync) that the inbound path gets automatically — a genuine
inconsistency between the two lead-creation paths worth fixing.

## 3. Scoring → CRM (the weakest link in the whole platform)

```
leads
   │
   └─ POST /lead-scores/:leadId/recompute [MANUAL TRIGGER ONLY]
         │
         └─ lead_scores (total_score, rubric breakdown)
               │
               ├─ priorityQueue (read-only sort by score)   ━━▶ real, display-only
               │
               ╌╌▶ GAP: nothing reads lead_scores when creating a deal
               ╌╌▶ GAP: nothing reads lead_scores when auto-assigning a lead
               ╌╌▶ GAP: no cron/job recomputes scores on any schedule —
                         confirmed by grep: zero references to scoreLead/
                         leadScoring anywhere in apps/worker/src's registered
                         loops (only 3 exist: agent-run worker, report
                         loop, sequence cron)

deals (POST /deals)
   │   — reads only leadId/stage/ownerUserId, never lead_scores —
   │
   └─ lead_assignments (POST /deals/assignments)  [MANUAL API CALL ONLY]
         — confirmed by grep: exactly 2 files in the whole codebase touch
           this table (its own route, and one read-only display join) —
           nothing ever auto-assigns a lead to a rep
```

**Finding**: scoring and CRM are two working islands that never talk to each
other. A lead can be scored 95/100 and sit unassigned and deal-less forever
unless a human manually creates the deal and manually assigns it. This is the
single most consequential gap for "helps a client acquire customers faster,"
since it means no automation exists between "we know this is a great lead"
and "a rep is working it."

## 4. Qualification → follow-up → meeting → deal → revenue

```
deals (stage: new → contacted → qualified → proposal → won/lost)
   │
   ├─ POST /deals/check-stalled [MANUAL TRIGGER ONLY — confirmed, no cron]
   │     └─ follow_up_tasks (trigger_reason='stage_stalled') ━━▶ crm_tasks row
   │
   └─ meetings (PATCH outcome) ━━▶ createMeetingOutcomeFollowUpIfNeeded()
         [THIS ONE IS GENUINELY AUTOMATIC — fires inline, no scheduler needed]
         └─ follow_up_tasks (trigger_reason='meeting_outcome') ━━▶ crm_tasks row

deals.stage = 'won'
   │
   └─ customers VIEW (leads JOIN deals WHERE stage='won') ━━▶ real, always-fresh
         │
         └─ growthRevenueAnalytics.ts / campaignAttribution.ts
               ├─ CAC, ROI, funnel metrics           ━━▶ real SQL, never fabricated,
               │                                          honestly "not_available"
               │                                          when spend data is missing
               └─ campaign_attribution (view)         ━━▶ real, tenant-scoped at every
                                                            join, API live
                                                          ╌╌▶ GAP: no dashboard page
                                                               exists for this at all
```

**Finding**: the deal→customer→revenue chain is real and honest end-to-end.
The only automation gap in this chain is stalled-deal detection (manual-only);
meeting-outcome follow-ups are the one piece of "automatic" framing in the
whole CRM layer that's actually true.

## 5. SEO/content → visitors → lead capture

```
SEO site audit / Core Web Vitals / Growth Analyzer content-gap analysis
   │                              (all real, deterministic, no fabrication)
   │
   ╌╌▶ GAP: none of these write anything that content strategy / landing
        pages consume automatically — a human reads the audit/analysis output
        and manually decides what content/landing page to build next.

content_calendars / content_drafts  ━━▶ real CRUD, deterministic generation
   │
   ╌╌▶ GAP: no connection from a published content draft to an actual
        published page/post anywhere (no CMS/blog publishing target exists
        in this codebase)

landing_pages (published)
   │
   └─ public render (headless JSON only — no in-repo HTML renderer) ✕
         │
         └─ form submit ━━▶ ingestLead()  [same shared path as section 1]
```

**Finding**: SEO/content tooling produces real, honest analysis and real,
working content-generation CRUD — but there is no automated hand-off from
"here's what to write" to "it's published," and no in-repo way for an actual
website visitor to ever see a landing page (headless-by-design, needs an
external renderer). This is architecturally fine for a platform meant to feed
*other* systems, but it means "SEO/content → visitors" is currently a fully
human-mediated step, not a pipeline.

## Summary table — what's genuinely wired vs. what's two islands

| Connection (from the spec) | Status |
|---|---|
| Website analysis → ICP generation | ━━▶ real |
| ICP → company discovery | ━━▶ real (free tier); ✕/╌╌▶ paid tiers |
| Company discovery → contact enrichment | ━━▶ real (logic untested directly) |
| Contact enrichment → email verification | ━━▶ real, free, no provider needed |
| Prospect scoring → CRM | ╌╌▶ **biggest gap** — scoring never feeds deal creation or assignment |
| SEO/content → website visitors | ╌╌▶ human-mediated, no auto-publish pipeline |
| Website visitors → lead capture | ━━▶ real, single shared path, all 3 channels |
| Chatbot → CRM | ━━▶ real (shares the same ingestion path) |
| Lead qualification → approved follow-ups | ━━▶ real for meeting outcomes; ╌╌▶ manual-only for stalled deals |
| Follow-ups → meetings | ━━▶ real (crm_tasks/follow_up_tasks model) |
| Meetings → deals | ━━▶ real (deal_id FK on meetings) |
| Won deals → customers and confirmed revenue | ━━▶ real, honest, never fabricated |

**The platform's inbound funnel (capture → notify → sync) and its revenue
measurement (deals → customers → attribution) are both solid and honest.
The middle of the funnel — scoring driving CRM action — is where the real
work remains.**
