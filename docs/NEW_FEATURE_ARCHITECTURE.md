# New Feature Architecture — Open-Source-Inspired Upgrade Round

## Layering principle (unchanged, reinforced this round)

```
DevLaunch Dashboard
       |
DevLaunch API (routes/*.ts)
       |
Native business logic (lib/*.ts)
       |
Integration adapters (existing provider clients, existing approvals engine,
                       existing credential encryption)
       |
Independent external services (Postiz, Chatwoot, Anthropic, Crawl4AI, ...)
```

Every workstream in this round is a new slice of "native business logic" that
either (a) queries existing tables read-only, (b) calls an existing adapter
function, or (c) adds a small, RLS-isolated new table of its own when no
existing storage fit. None introduced a second competing subsystem for
something that already existed (no second CRM, no second email sender, no
second approval engine, no second analytics-ingestion pipeline, no second
agent framework).

## New shared infrastructure added this round

- **AI agent platform** (`apps/api/src/lib/agentPlatform/`): a single native
  runtime (`core/agentRunner.ts`) all 14 specialized agents share. It is the
  *only* LLM-calling entry point added this round; every agent is a thin
  `AgentDefinition` (systemPrompt + zod input/output schema + tools) rather
  than its own bespoke integration. All 14 report `status: "not_configured"`
  honestly in this environment.
- **Native workflow engine** (`apps/api/src/lib/workflowEngine.ts` +
  `apps/worker/src/cron/workflowTriggerCron.ts`): a DAG-walking executor whose
  action nodes call existing send/task/notify functions. Not derived from any
  cloned repo's code (n8n's license forbids it; Mautic's GPLv3 would require
  this app to go GPLv3 too).
- **Growth experiment engine** (`apps/api/src/lib/experimentEngine.ts`):
  variant assignment + significance testing + approval-gated winner
  application. The only path by which this round's code can mutate a live
  landing page — and it cannot do so without a real row in the existing
  `approvals` table reaching `status = 'approved'`.
- **Website intelligence snapshots**: a new evidence-store table
  (`website_intelligence_snapshots`) feeding structured extraction, change
  detection, and content-gap analysis — all downstream of the existing
  Crawl4AI client and SSRF guard, never a new fetch path.
- **Survey engine**: a new `surveys`/`survey_responses` pair, deliberately
  separate from the lead-capture tables (`leads`), but funneled through the
  existing `ingestLead()` whenever a response carries contact info.

## Rules every workstream was built under

1. **No new file may edit** `app.ts`, `App.tsx`, `Layout.tsx`,
   `routes/integrations.ts`, or any pre-existing migration file. All shared
   wiring was collected as exact snippets and applied once, sequentially, by
   the orchestrating session after every workstream finished — eliminating
   any race on those five files.
2. **No duplicate source of truth.** Every workstream was required to grep
   for an existing equivalent before adding a table or a write path, and to
   explain in its report either "reused X" or "built new because X doesn't
   exist, here's why that's safe."
3. **No fabricated success.** Anything gated on a real external
   credential (LLM, SerpApi, Clearbit, ad platforms, WhatsApp, payment
   providers — none configured in this environment) must report an honest
   `not_configured`/`BLOCKED` status, never a fake result.
4. **Tenant isolation is non-negotiable.** New tables use the same
   `FORCE ROW LEVEL SECURITY` + `current_setting('app.current_tenant_id',
   true)::uuid` pattern as every existing table; new tools/queries scope by
   `tenant_id`/`project_id` in the SQL itself, not just via RLS as the only
   line of defense.
5. **External-action gating reuses the existing approval engine.** Social
   publishing and experiment-winner application both route through the real
   `approvals` table (extended additively), never a second approval
   mechanism.

## Migration ranges used this round (collision-checked against the then-current max of 562)

| Range | Workstream |
|---|---|
| 563–565 | H — social content calendar (+ approvals CHECK widen) |
| 600 | A1 — agent_runs |
| 610–615 | B — workflow automation |
| 630–633 | D — surveys |
| 640–641 | E — website intelligence snapshots |
| 642–647 | C2 — growth experiments (+ approvals CHECK widen) |

C1, F, G1, G2 needed no new migrations — all read-aggregating over existing tables, each with a documented justification for why no cache/index table was required.

## Dashboard additions

Seven new standalone pages were routed (AI Agent Center, Workflow Automation,
Advanced Analytics, Growth Experiments, Feedback & Surveys, Competitor
Monitoring, Social Content Calendar). Three features were deliberately built
as sibling *components* rather than new pages
(`UnifiedCustomerProfilePanel.tsx`, `CompanyIntelligencePanel.tsx`,
`SalesEngagementPanel.tsx`) because they extend existing detail pages
(`LeadDetailPage.tsx`, `CompaniesPage.tsx`, `SalesPipelinePage.tsx`) that were
mid-edit by a concurrent session during this round — each has a documented
2-line drop-in point for whoever finishes that page next.
