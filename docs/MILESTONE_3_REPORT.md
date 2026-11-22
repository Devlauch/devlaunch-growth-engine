# Milestone 3 Report — Real-World Growth Activation

**Status:** Phase 1 (Real-world smoke testing) complete and verified.
Phases 2-5 not started, per the explicit instruction to complete and
verify each phase before advancing.

This report is the authoritative Milestone 3 summary. Full technical
detail lives in `docs/INTEGRATION_STATUS.md` (sections 11-14+) and
`docs/SECURITY_REVIEW.md`'s "RLS bypass" and "Credential storage audit"
entries — this document is the executive rollup the deliverables list
asked for.

## What Phase 1 set out to verify

1. Deploy and test the existing Listmonk, Chatwoot and Postiz integrations for real.
2. Use dedicated test tenants/accounts.
3. Verify real authentication, API calls, webhooks, credential storage.
4. Test retries, idempotency, tenant isolation, service failure recovery.
5. Verify approval gates before email sending and social publishing.
6. Fix the documented SES/Postmark signature-verification gap.
7. Review the Chatwoot identity limitation and implement a secure solution.
8. Update integration status with real evidence.

## How it was executed

Three parallel agents, one per integration, each with real Docker access
(confirmed working in this environment — images pull, containers run) and
explicit instructions to never fabricate a result: show real command
output or say exactly what blocked a step. A fourth cross-cutting pass
(idempotency/approval-gates/tenant-isolation across all three, plus a
credential-storage audit) was delegated by the Postiz agent to its own
sub-agent. The orchestrator did the final reconciliation, the Postiz
redeploy retry, and the critical RLS fix below.

## Results, per integration

### Listmonk — ✅ fully verified end-to-end
Real deploy (found and fixed a real healthcheck bug — v5.0.2 requires auth
on `/api/health`), real connect/sync/webhook/retry/tenant-isolation/
failure-recovery verification against a genuinely running container, and
the documented SES signature-verification gap is now **closed**: real AWS
SNS cert-chain signature verification implemented and tested with a real
generated RSA keypair (9 new tests). Postmark re-confirmed (via its
current live docs) to have no HMAC scheme at all — Basic Auth remains the
correct mitigation, no code change needed there. Full detail:
`docs/INTEGRATION_STATUS.md` §11.

### Chatwoot — ✅ fully verified end-to-end
Real deploy (found and fixed 3 real deployment bugs: the official image has
no `/bin/bash` or `curl`, and Chatwoot v4.x requires `pgvector`, not plain
Postgres). Real connect/widget/AgentBot-webhook/lead-sync/retry/
tenant-isolation/failure-recovery verification, including a byte-exact
cross-check of a real HMAC computed two independent ways (Node and Ruby
inside the live container) to prove interop, not just a documented spec.
The documented identity-verification gap is now **closed**: real
Chatwoot "Identity Validation" HMAC scheme implemented additively (the
anonymous-visitor path is untouched), 16 new tests. Full detail:
`docs/INTEGRATION_STATUS.md` §12.

### Postiz — see below (orchestrator-completed retry)

### Cross-cutting (idempotency, approval gates, tenant isolation, credential audit)
- **Idempotency**: real Postgres unique-constraint proof for all 3
  providers' `(integration_id, external_event_id)` pairs — no gap found;
  every webhook route already correctly uses `ON CONFLICT ... DO NOTHING`.
- **Approval gates**: a real cross-cutting regression test now exists
  (`apps/api/test/integrationApprovalGates.test.ts`) so a future change
  that accidentally removes the gate on any of the three send/publish
  paths gets caught automatically, not just by that integration's own unit
  tests.
- **Credential storage**: full repo audit found no plaintext-secret
  logging, no secret committed to a migration or doc. Real local `.env*`
  files with generated test secrets exist but are correctly gitignored.
- **Tenant isolation**: this is where the critical finding below surfaced.

## Critical finding: RLS was not actually enforced at the database level — now fixed

The single most important result of Phase 1. Full writeup in
`docs/SECURITY_REVIEW.md`'s "RLS bypass" entry. Summary: the application's
Postgres connection (`devlaunch`) has always been a real superuser with
`rolbypassrls=true` — Postgres unconditionally bypasses Row-Level Security
for superusers, so every "FORCE ROW LEVEL SECURITY" migration's safety
claim was never actually enforced for the app's own connection. Tenant
isolation worked only because every route handler manually scopes by
`tenant_id` — there was no database-level backstop. Independently
confirmed four separate times (three agents, one direct orchestrator
check).

**Fixed this round**: a dedicated non-superuser `devlaunch_app` role
(migration 321), `docker-compose.yml`'s `api`/`worker` services now
connect as it instead of the bootstrap superuser, and a new startup check
(`assertDatabaseRoleRespectsRls()`) in both apps makes this regression
impossible to reintroduce silently — verified against the real running
container (before: `devlaunch` superuser bypasses RLS; after:
`devlaunch_app` is correctly isolated per-tenant, proved with a real
two-tenant query).

**A second, independent real bug** was found and fixed while restarting
the worker for this change: the sequence-scheduler cron's cross-app
dynamic import of `apps/api/dist` silently failed in every real container
deployment (it only ever worked in local dev where both apps' build
output happens to share a filesystem) — `apps/worker/Dockerfile` now
builds and copies `apps/api`'s compiled output too. Confirmed fixed.

## Postiz — ✅ fully verified end-to-end (orchestrator-completed retry)

The dispatched agent's deployment attempts stalled on Docker-daemon
contention from the other two concurrent agents and never produced a
running container (fully documented, no fabricated claims). Once
Listmonk/Chatwoot finished and freed the daemon, the orchestrator retried
with a properly-tracked background process and completed every item: real
deploy (found and fixed a real bug — the Temporal image's
`DYNAMIC_CONFIG_FILE_PATH` pointed at a file that doesn't exist in
`temporalio/auto-setup:1.28.1`), real account registration + API key
generation + connect (which surfaced a second, more significant bug — see
below), a real approval-gated publish test (403 without approval, genuine
Postiz-side 400 after approval since no real social OAuth account is
connected — the honest, anticipated outcome), and real failure/recovery
(honest error status while stopped, genuine recovery after restart). Full
detail: `docs/INTEGRATION_STATUS.md` §13.

**A second critical bug was found via this real connect test**: a route-
shadowing bug in `apps/api/src/app.ts` meant the generic `/integrations`
registry router's own `/:provider/connect` and `/:provider/health-check`
routes silently intercepted every request meant for the dedicated
Listmonk/Chatwoot/Postiz routers' own, more-correct implementations —
meaning **all three integrations' real connect/health-check verification
earlier in this report was unknowingly exercising the wrong code path**.
Fixed by reordering the router mounts (dedicated routers now registered
before the generic one). Re-verified after the fix: Postiz's real
pre-connect `GET /public/v1/me` check now genuinely executes. This was
only discoverable through real external calls — no mocked test could
catch a mount-order bug in `app.ts` itself.

**Checked whether this also affected Listmonk/Chatwoot's earlier
verification**: it did not. `grep` of both routers confirms neither
`listmonkIntegrationRouter` nor `chatwootIntegrationRouter` ever defined
their own `/connect`/`/health-check` routes — both agents deliberately
deferred those two to the generic `integrations.ts` route by design
(documented in each agent's own section above), so their connect/
health-check calls always correctly went through the intended code path.
Only Postiz's router defined its own fuller `/connect`/`/health-check`
with real pre-connect verification logic, which is exactly what the
shadowing silently defeated. Sections 11 and 12's results stand as
reported.

## Test/build state at the end of Phase 1

`npm run build` clean across `@devlaunch/agent-sdk`, `@devlaunch/api`,
`@devlaunch/worker`. `npm run test --workspace=@devlaunch/api`: 804
passed, 4 skipped (the skipped ones are the RLS-bypass-dependent tenant-
isolation tests, loudly skipped with the reason in their name, not
silently green), 0 failed. `npm run test --workspace=@devlaunch/worker`:
101/101. All real container deployments (Listmonk, Chatwoot) were torn
down after verification with their named volumes preserved; Postiz's
final state depends on the in-progress retry above.

## What still needs real credentials (not a code gap)

Production use of all three integrations needs real, live accounts:
Listmonk's own admin bootstrap, a real Chatwoot account/inbox + a real
`CHATWOOT_WEBHOOK_SECRET`, and for Postiz specifically, real
per-social-network OAuth app registrations (the Milestone 1 audit's own
flagged days-to-weeks-per-network cost) on top of a running Postiz
Organization. None of this was simulated — every item above was tested
against a genuinely running container with real HTTP calls and real
database queries, not mocks.

## Unresolved dependencies / remaining blockers

- SES/Postmark: SES is now fixed; Postmark has no available signature
  scheme at all (confirmed from live docs) — Basic Auth is the ceiling,
  not a gap to close further.
- Postiz real-world connect/publish/approval-gate verification — pending
  the deployment retry's outcome (see above).
- The pre-existing `crawl4ai` Apache-2.0 attribution-notice action item
  from the Milestone 1 audit is still open (unrelated to this milestone,
  carried forward again).
- Full in-browser (real browser, not headless/API-simulated) widget
  handshake for Chatwoot was not independently verified — no browser
  available in this environment; substituted with equally-real
  account-API-driven verification instead.

## Recommended path into Phase 2 (Intelligent lead acquisition)

Phase 1 is complete and verified. Before starting Phase 2: audit the
existing discovery/scoring/enrichment pipeline (`apps/api/src/routes/
discovery.ts`, `lib/companyEnrichment.ts`, `lib/icpMatching.ts`,
`lib/decisionMakerProvider.ts`, `lib/providerWaterfall.ts` — all built in
prior milestones) against Phase 2's exact requirement list before writing
any new code, per the master prompt's own "inspect before implementing"
rule. Most of Phase 2's list (ICP generation, company discovery,
decision-maker identification as an honest stub, enrichment, verification,
scoring with explanations, buying-intent evidence, dedup, lead assignment,
CRM sync) already has a real implementation from Milestones 1-2 — Phase 2
is likely a completion/provider-architecture pass, not a from-scratch
build. Confirming that precisely is the right first step once this report
is reviewed.

---

## Milestone 3, Phase 2 — Intelligent Lead Acquisition (✅ complete, verified)

Three agents, audit-first (most of Phase 2's requirement list already
existed from Milestones 1-2 — this was a completion/wiring pass, not a
rebuild):

- **ICP + discovery provider architecture + prospecting campaigns**
  (Agent 1): generalized the existing generic `providerWaterfall.ts`
  (previously only used by decision-maker lookup) into company/target
  discovery itself via a new `POST /discovery-sources/run`. Closed the
  real "no campaign tracking" gap: `prospecting_campaigns` (migrations
  323-324) — name/goal/ICP target/status lifecycle, multi-source waterfall
  ordering, and a live (never cached/fabricated) results summary.
- **Decision-maker + enrichment + verification providers** (Agent 2):
  confirmed decision-maker lookup was already correctly pluggable. Closed
  two real gaps: `companyEnrichment.ts` had no provider interface at all
  (now waterfall-based, with `source_confidence` propagation — migration
  322); email/phone verification had no provider-swap seam and zero direct
  unit tests (both closed, same `NotConfigured*` convention).
- **Scoring explanations + buying-intent provenance + dedup + CRM sync**
  (Agent 3): confirmed scoring evidence and buying-signal provenance were
  already fully real and surfaced. Fixed a real dedup bug (unnormalized
  contact-name comparison). Closed the single highest-leverage gap: a new
  `POST .../leads/:leadId/promote-to-crm` endpoint — the first real bridge
  from the discovery/scoring pipeline into the Milestone 2 CRM (companies/
  contacts/lead_assignments), with real qualification gating and
  round-robin auto-assign, now wired into `LeadDetailPage.tsx`.

**Orchestrator reconciliation**: wired `prospectingCampaignsRouter`/
`leadPromotionRouter` into `app.ts`, built the missing
`ProspectingCampaignsPage.tsx` dashboard page (flagged but not built by
Agent 1, out of its stated scope), added the "Promote to CRM" action to
`LeadDetailPage.tsx`, and added both to `App.tsx`/`Layout.tsx`'s nav.

**Verified**: `@devlaunch/api` and `@devlaunch/worker` build clean,
dashboard `tsc --noEmit` clean. Full API suite: 927/932 passing, 4
pre-existing honest RLS-dependent skips, 1 unrelated failure in another
concurrent session's own in-progress feature (`classifyObjection.test.ts`
— not in any of this phase's 3 agents' scope, left to that session). Zero
regressions from this phase's own work.
