# Open-Source Upgrade Backlog

A prioritized list of what was deliberately **not** attempted in this round, with a one-line
reason each, so a future session doesn't re-spend time re-investigating something this audit
already looked at and set aside. Items are grouped by why they were set aside, not by repo
alphabetically, since the reason is the thing worth remembering.

## Rejected — restrictive licensing is the blocking factor

1. **n8n as a monetized, customer-facing automation feature** — blocked by the Sustainable Use
   License v1.0's explicit "internal business purposes or non-commercial/personal use only"
   limitation (verified verbatim in `n8n/LICENSE.md`, see `OPEN_SOURCE_LICENSE_AUDIT.md`'s
   headline finding). Not a technical problem; do not re-investigate the integration mechanics
   without first getting a legal/commercial decision on whether DevLaunch will pursue a
   commercial/OEM agreement with n8n GmbH. If that agreement is ever signed, the technical
   integration path (independent service, webhook/API-key-triggered, per the Integration
   Architecture doc) is already designed and does not need redesigning.

## Rejected — redundant with existing, more mature DevLaunch functionality

2. **leadhub** — functionally duplicates DevLaunch's own discovery/scoring pipeline
   (`leadGeneration.ts`, `icpMatching.ts`, `scoreLead.ts`), which is already more mature (richer
   enrichment, multi-tenant rubric scoring, real dedup). Do not re-adopt even if its MIT license
   makes it tempting — the capability gap it would close does not exist.
3. **OpenOutreach as a dependency** (distinct from its underlying *ideas*, see item 9 below) —
   same reasoning as leadhub: its discovery/qualification/send pipeline is less mature than
   DevLaunch's own, and it is architecturally wrong-shaped (single-operator Django CLI, SQLite,
   no multi-tenancy, no internal auth) for a multi-tenant SaaS regardless of maturity.
4. **mastra as DevLaunch's orchestration layer** — `agent_executions` already does what Mastra's
   orchestrator would replace, is already RLS-integrated, and already has the
   `awaiting_approval` human-gate semantics Mastra would need its own adapter to replicate. No
   concrete capability gap was found in either this audit or the prior Milestone 1 audit.
   Revisit only the narrow idea of a scoped `@mastra/core` library dependency (its tool-calling
   loop or multi-provider model-router) if hand-rolled LLM-provider client code becomes a real
   maintenance pain point — not before.
5. **twenty as a deployed external CRM service** — DevLaunch already built a lighter native CRM
   (companies/contacts/notes/deals/meetings/activity-timeline, Milestone 2) using Twenty's data
   model purely as a reference schema. Re-litigating "should we deploy Twenty itself" requires a
   concrete, named requirement that the native CRM demonstrably cannot meet (e.g. a hard SSO/RBAC
   requirement, or native inbox/calendar sync) — don't revisit this without that requirement in
   hand.

## Deferred — real capability, but disproportionate operational cost today

6. **posthog self-hosted** — the OSS stack requires Postgres+Redis+ClickHouse+Kafka/Zookeeper+
   SeaweedFS at minimum, and this audit's own direct read of `docker-compose.base.yml` found
   the real footprint is heavier still (also Temporal, Elasticsearch, OpenSearch, Jaeger, a
   local DynamoDB, Caddy, Valkey, and ~10 of PostHog's own first-party microservices) — roughly
   doubling DevLaunch's entire operational surface for one feature. Use PostHog Cloud's hosted
   capture API instead (near-zero new infra, pay-per-event), or build a lightweight internal
   analytics layer on the existing `usage_events` table. Do not revisit self-hosting unless event
   volume and feature need (session replay, heavy feature flags/experiments at scale) genuinely
   justify the ClickHouse/Kafka burden — and even then, re-confirm the service list from
   `docker-compose.base.yml` directly rather than trusting any prior audit's count, since this
   audit found the prior Milestone 1 estimate ("7+ services") was itself an undercount.
7. **mautic** — heaviest footprint of any candidate repo (MariaDB-only — cannot share
   DevLaunch's Postgres under any circumstance; no production-ready Docker Compose shipped
   in-repo; no native multi-tenancy, meaning one instance per tenant would be needed for real
   isolation). Redundant with listmonk for DevLaunch's actual stated gap ("no email/campaign
   infrastructure"). Only worth reconsidering if the roadmap grows to need branching
   marketing-automation workflows, native forms, or lead-scoring-beyond-campaigns that listmonk
   genuinely cannot cover — and even then, it should be added *alongside* listmonk's
   transactional/campaign role, not as a replacement, to avoid running two overlapping
   list/campaign systems.

## Deferred — real idea worth keeping, but blocked on a prerequisite that doesn't exist yet

8. **Zero LLM credentials exist anywhere in DevLaunch's codebase today** (independently
   re-confirmed by this audit, not merely inherited from the prior one — no
   `OPENAI_API_KEY`/`ANTHROPIC_API_KEY`/generic `LLM_API_KEY` field exists even as a
   null-defaulted placeholder in `env.ts`). This blocks several otherwise-reasonable ideas from
   being worth building right now:
   - **aaron-marketing-skills' prompt-template content** — the content itself is free
     (Apache-2.0, zero runtime dependency) to copy into a prompt-template store at any time, but
     has no agent to consume it until an LLM credential exists. If Workstream A's
     agent-platform work this round builds the store/ingestion mechanism without wiring a real
     LLM call behind it, that is a reasonable and correctly-sequenced partial step — don't treat
     "no LLM yet" as a reason to skip building the store.
   - **OpenOutreach's "LLM writes a qualification reason per lead" concept** — genuinely a good
     idea, not present anywhere in DevLaunch's own pipeline today, but reimplementing it
     natively only makes sense once an LLM credential exists to actually call. Do not wrap
     OpenOutreach itself to get this (see item 3) — build it from scratch against DevLaunch's
     own ICP/scoring pipeline when the prerequisite lands.

## Noted but intentionally out of scope for this document

9. **OpenOutreach's non-license behavioral baggage** (immutable "Sent with OpenOutreach" email
   footer, default newsletter opt-in outside protected jurisdictions, and a still-live
   maintainer-operated central contact-pooling store at `hub.openoutreach.app` — this audit
   independently re-confirmed the pooling behavior is current, not historical, by reading
   `LEGAL_NOTICE.md` section 6 directly) is not a licensing concern and does not belong in
   `OPEN_SOURCE_LICENSE_AUDIT.md`, but is recorded here so a future session doesn't need to
   re-read that file to rediscover why OpenOutreach is rejected as a dependency even though its
   Apache-2.0 license is clean.
10. **crawl4ai's attribution-clause location — resolved by this audit.** The prior Milestone 1
    audit asserted crawl4ai's Apache-2.0 license carries an added attribution-requirement clause.
    This audit's own direct read of the root `LICENSE` file found only the stock Apache-2.0 text
    with no such clause — but a follow-up read of `crawl4ai/README.md` found it: a
    "## 📄 License & Attribution" section (confirmed, line ~443) stating "attribution is
    recommended via the badges below" and a "### Attribution Requirements" subsection offering a
    badge-attribution or text-attribution option. So the obligation is real, lives in the README
    (not the LICENSE file), and is phrased as "recommended"/a choice of methods rather than an
    unconditional requirement baked into the license grant itself. **Remaining action, not yet
    done by this audit**: verify whether DevLaunch's own UI/docs/credits page actually displays
    one of the two attribution methods crawl4ai's README offers — that check was out of scope for
    a read-only repo audit (it requires inspecting DevLaunch's own public-facing surface) and
    should be picked up by whichever session owns `apps/dashboard`'s public pages or a
    credits/NOTICE page for the platform.
