# Feature Status — single source of truth

**Last updated:** 2026-11-22
**Updated by:** Claude (orchestrating 8 parallel build agents this round, covering nearly the entire remaining roadmap)

This file is the one place to check "is X built yet" across the whole
20-item growth-platform roadmap. Multiple AI sessions/agents work on this
repo in parallel without seeing each other's conversations — this file (not
chat history) is their shared memory of what's actually done.

**Rule for whoever picks up work next (human or agent): before starting,
read this file. After landing a feature, update this file in the same
change** — move the item from ⬜/🟡 to ✅, add the evidence line(s), and bump
"Last updated".

Status legend: ✅ built & tested · 🟡 partially built / stubbed honestly ·
⬜ not started

Other docs in this folder: `PHASE1_REPORT.md`/`IMPLEMENTATION_PLAN.md` are
historical (pre-date most of what's below). `DISCOVERY.md` and
`CRAWL4AI_VERIFICATION.md` are topic deep-dives. `API_DEVIATIONS.md`/
`DECISIONS.md`/`SECURITY.md` are rationale records.

---

## A. Find more leads

### 1. Real source connectors — ✅ mostly done
Plug-in `SourceConnector` interface (`packages/agent-sdk/src/connectors/`),
per-source rate limiter, terms note, per-tenant on/off switch.
`public_directory` (Overpass/OpenStreetMap, 15 real categories) is live
end-to-end. `csv_upload` connector is built and unit-tested but **not yet
reachable from the API** (`discovery-sources` only accepts
`connectorType: "public_directory"`, 400s on `csv_upload`) — the next small
step to finish this item. Licensed-provider API is an honest
`NotConfiguredError` stub (needs a real paid key). `website_crawl` as a
discovery *source* (distinct from crawling a known org's own site, item 2)
is not built.

### 2. Website research with Crawl4AI — ✅ verified live
Real robots.txt parser, per-domain rate limiting, page classification,
email/phone extraction — all unit-tested. **This round: verified against a
real running `unclecode/crawl4ai` container.** Found and fixed a real
networking trap (the image only binds to loopback unless
`CRAWL4AI_API_TOKEN` is set — the old port mapping was a silent no-op).
Confirmed the real `/health` and `/crawl` response shapes match what the
code expects; pinned the image tag to `0.9.6` (was `:latest`). See
`docs/CRAWL4AI_VERIFICATION.md` for the full session write-up. Evidence:
`apps/worker/src/agents/websiteCrawler.ts`, `docker-compose.yml`.

### 3. Contact discovery — ✅ done
### 4. Email and phone verification — ✅ done
### 5. Deduplication — ✅ done (detection + skip; no merge UI yet)

### 6. Inbound lead capture upgrades — ✅ done
Real UTM/referrer capture (`leads.utm_*`/`referrer_url`), a tenant-configured
qualifying question, and a post-submit thank-you/booking-link flow — all
flowing through the widget (`packages/embed-widget/embed.js`) and the shared
`leadIngestion.ts` path. New `WidgetSettingsPage.tsx` dashboard page.
Deliberately **not built**: per-audience landing pages, a lead magnet
(out of scope this round — not concrete enough to build without more
product input).

---

## B. Qualify the right leads

### 7. Configurable scoring — ✅ done
Rubric, deterministic scoring (hard zero-for-missing-evidence), why/next
notes, feedback capture, **and now a real `/recompute` evidence pipeline**
(matches a lead to its `discovered_organizations`/`discovered_contacts` by
domain/name, checks custom_fields + org metadata per criterion). Plus a real
`ScoringPage.tsx` dashboard UI. Still ⬜: using feedback to auto-tune rubric
weights (spec says do this after 30-50 outcomes — see item 17's
`rubric-review-readiness` endpoint, which tracks that count honestly).

### 8. Priority queue — ✅ done
API + a real `PriorityQueuePage.tsx` dashboard UI (sorted list + "today's
top leads" panel).

---

## C. Create more message opportunities — ✅ mostly done

### 9. Personalized message drafting — ✅ done
Deterministic, evidence-grounded template composition (explicitly NOT an
LLM call — no LLM API key wired up in this environment; documented as a
future upgrade seam behind the same function signature). 4 channel variants
per lead (email/whatsapp/call_script/linkedin_note), unsourced claims
flagged for human review. Evidence: `apps/api/src/routes/messaging.ts`,
`apps/worker/src/agents/messageDrafting.ts`. Verified live end-to-end.

### 10. Multi-step sequences — ✅ done
Editable sequences with day-offset steps, enrollment + auto-stop machinery
(`sequence_enrollments.status`), and a real `advanceDueEnrollments()` that
gates every step through item 18's `checkSendEligibility`. No scheduler
wired to call it automatically yet (`POST /sequences/advance` is manually
triggerable) — needs a cron job to be fully "automatic."

### 11. More channels, each behind approval — 🟡 partial
"Calls and manual LinkedIn messages as tasks in the CRM" is real
(`crm_tasks` table + creation from sequences/replies). Real email/WhatsApp
sending integrations are intentionally out of scope (no real sender
connected anywhere in this codebase, by design). Social posts via Postiz:
not built (still just listed `not_connected` in `integrations.ts`).

### 12. Approval screen — ✅ done
Reuses the existing `approvals` table/state machine exactly like Campaigns
does (not a parallel system). Batch-approve respects
`tenants.message_approval_daily_limit`, never partially approves. No real
send on approval — consistent with the rest of this codebase.

### 13. Reply handling — ✅ done
Real deterministic keyword classifier (interested/not_now/wrong_person/
unsubscribe/unclassified — unsubscribe checked first, for compliance
reasons). Creates a CRM task + draft-response skeleton on `interested`,
suppresses + stops sequences on `unsubscribe`. No live inbox integration
(manual/webhook ingestion endpoint — a human or a future integration posts
to it). Verified live end-to-end.

---

## D. Make sure messages are delivered

### 14. Sending setup per tenant — ✅ done
**Real DNS verification** (SPF/DKIM/DMARC via live `dns.promises.resolveTxt`
— verified live against `example.com` during this round's QA pass, got back
real records). Warm-up ramp math and bounce/complaint-rate pause logic are
real and tested. `SendingSetupPage.tsx` dashboard UI. No real sends exist
yet to actually warm up or monitor — this is readiness infrastructure, built
honestly ahead of a real send integration.

---

## E. Pipeline and learning

### 15. CRM and pipeline — ⬜ not started (unchanged)
`integrations.ts` lists Twenty etc. honestly as `not_connected` — correctly
deferred, needs a real third-party account.

### 16. Funnel analytics — ✅ extended
New `GET /analytics/funnel`: discovered/qualified/contacted/replied stages
are real counts; demo is a documented proxy
(`sequence_enrollments.status='stopped_meeting_booked'`); won is honestly
`{count: 0, note: "no 'won' lead status exists in the schema yet"}` — not
fabricated. Breakdowns by source/channel real; by segment honestly empty
(no FK link from leads to ICP segment yet).

### 17. Learning loop — ✅ done (reporting only, as expected)
`GET /learning-loop/variant-performance` (real reply-rate-by-channel
comparison, honest "not enough data yet" below a 5-lead sample threshold)
and `GET /learning-loop/rubric-review-readiness` (tracks the 30-outcome
threshold from item 7's feedback). Nothing to compare yet in practice since
real send volume doesn't exist — this is correctly built ahead of data, not
faked with sample data.

---

## F. Compliance — ✅ done (item 18)
`suppression_list` + `consent_records` + `country_send_settings`, enforced
both at the DB level (unique indexes) and via
`checkSendEligibility(tenantDb, tenantId, {...})` — the standing contract
every send-adjacent feature (sequences, messaging) already calls before
acting. Public unsubscribe endpoint with HMAC-signed tokens. **Built before
any real send channel exists**, as the spec required.

## G. Make it work for any company

### 20. Onboarding wizard — ✅ done
4 real, distinct industry templates (education/saas/agency/local_services)
with real ICPs, scoring criteria, and sequence templates. `POST .../apply`
is idempotency-safe (won't duplicate on a second call), gracefully degrades
if dependent tables are missing. `OnboardingWizardPage.tsx`. Verified live
end-to-end.

---

## What's left (small, concrete punch list)

1. Wire `csv_upload` into the `discovery-sources` connector-type allowlist
   (item 1) — the connector itself already works, just not reachable yet.
2. A scheduler/cron to call `POST /sequences/advance` automatically (item 10
   — currently manual-trigger only).
3. Postiz social-post integration (item 11's last piece).
4. CRM sync to a real provider (item 15) — blocked on a real account.
5. Use `lead_score_feedback` to actually adjust rubric weights once
   `rubric-review-readiness` reports ≥30 outcomes (item 7/17).
6. Landing pages per audience + a lead magnet (item 6's deferred pieces).
7. A merge-duplicates UI for discovery (item 5's deferred piece).

## Known cross-cutting bug fixed (prior round)
`apps/api/src/middleware/tenant.ts` now commits each tenant-scoped
transaction inside `res.json()` itself, before any bytes are written —
fixing a real race where a client's next sequential request could read
stale/missing data. See git history for `tenant.ts` if this ever needs
re-investigating.

## Migration numbering note
This round, 3 parallel agents independently landed migrations in the
052-056 range (an unavoidable race — they all checked the disk before any
of them had committed). Reconciled by renumbering the two non-dependent
ones (leads/projects column additions) to 064-065, since the
message_drafts chain had a real downstream FK dependent (`lead_replies`
at 058). Current highest migration: **065**. If you're about to add a new
migration, always `ls packages/db/migrations | sort -V | tail -5` first
and check back before actually applying — several agent sessions may be
landing files concurrently.
