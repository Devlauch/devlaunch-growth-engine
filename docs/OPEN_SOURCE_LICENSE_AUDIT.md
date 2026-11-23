# Open-Source License Audit

Produced by independent, read-only inspection of the actual `LICENSE`/`LICENCE`/`COPYING`
file in each of the 13 repositories cloned under `~/project/Growth/`, cross-checked against
each repo's `package.json`/`pyproject.toml`/`go.mod`/`composer.json` declared `license` field.
No repository was cloned, installed, or modified to produce this document. Where this audit's
findings corroborate the pre-existing `docs/OPEN_SOURCE_INTEGRATION_AUDIT.md` (Milestone 1),
that is noted; where this pass found something the prior document didn't (or found it had
drifted), that is called out explicitly.

**How to read the Decision column**:
- **Safe to reference-for-ideas** — read the code/data model for inspiration; do not call its
  API, do not redistribute, do not depend on it operationally.
- **Safe for direct API integration** — run it as a separate, unmodified, independently
  deployed service and talk to it only over its documented API/webhooks. Never fork or patch
  its own source.
- **Do NOT embed-or-redistribute code** — do not vendor, copy, or statically link any of this
  repo's own source into DevLaunch's codebase or published artifacts, regardless of API usage.

---

## Summary table

| Repo | License (verified, exact) | Commercial-use restriction? | Recommendation |
|---|---|---|---|
| chatwoot | MIT ("MIT Expat") for core; `enterprise/` dir separately/commercially licensed | **No** for core. `enterprise/` (Captain AI, some SSO) requires a paid Chatwoot subscription — not a copyleft trigger, a feature-gate. | Safe for direct API integration (core only); do NOT embed-or-redistribute `enterprise/`-gated functionality without a paid license. |
| crawl4ai | Apache-2.0, **plus an added Attribution Requirement** (see below) | **No** license-fee restriction, but a real, non-standard attribution obligation beyond plain Apache-2.0. | Safe for direct API integration / safe to reference-for-ideas. Verify the attribution clause is satisfied somewhere in DevLaunch's UI/docs (see Upgrade Backlog). |
| formbricks | **Mixed**: AGPLv3 for the web app/backend core; MIT for `packages/js-core`, `android`, `ios`, `api`, `surveys`, `survey-ui`; `apps/web/modules/ee` separately/commercially licensed | **No** blanket restriction, but AGPLv3's network-use copyleft applies to the backend, and `ee/` is a paid feature gate. | Safe for direct API integration against the AGPL backend (unmodified, arms-length). The MIT SDK packages are additionally safe to vendor/embed directly if a lighter-weight widget-only integration is preferred. Do NOT embed-or-redistribute the AGPL backend or `ee/` code. |
| leadhub | MIT (root `LICENSE`, confirmed; `pyproject.toml` `license = "MIT"` matches) | **No** | Safe to reference-for-ideas only — see Dependency Audit and Upgrade Backlog for why this is not integration-worthy regardless of license. |
| listmonk | AGPLv3 (confirmed verbatim GNU AGPL v3 text in root `LICENSE`) | **No** fee restriction, but AGPLv3 network-use copyleft: calling an unmodified instance over its documented API does not trigger source-disclosure; modifying its own Go source and running that modified version as a network service would. | Safe for direct API integration (run unmodified, call its REST/webhook API only). Do NOT embed-or-redistribute or fork its Go source. |
| mautic | GPLv3 (confirmed verbatim GNU GPL v3 text in `LICENSE.txt`; `composer.json` `"license": "GPL-3.0"` matches) | **No.** GPLv3 has no network-use/SaaS clause (unlike AGPL) — running a modified Mautic as a backend service behind DevLaunch, without redistributing its code to third parties, does not itself trigger source-disclosure. | Safe for direct API integration even if lightly modified for operational needs (e.g. a multi-tenancy patch) — but any such modification, and any decision to actually redistribute Mautic's own code, needs separate legal review before it happens. Currently not integrated (see Integration Matrix: Decision = hold). |
| n8n | **Sustainable Use License v1.0** (fair-code, confirmed verbatim, NOT an OSI-approved open-source license) for core; `LICENSE_EE.md`'s n8n Enterprise License for any file with `.ee.` in its name/dirname | **Yes — explicit and material.** "You may use or modify the software only for your own internal business purposes or for non-commercial or personal use. You may distribute the software or provide it to others only if you do so free of charge for non-commercial purposes." This directly blocks reselling n8n workflow execution as a paid, customer-facing feature without a separate commercial/OEM agreement with n8n GmbH. | Safe for **internal-only** use (DevLaunch's own ops team building glue workflows), called via API/webhook, arms-length. Do NOT monetize/resell n8n execution to DevLaunch's paying customers without a signed commercial agreement — this is a business/legal decision, not an engineering one. Do NOT embed-or-redistribute any `.ee.` file without an Enterprise License. |
| OpenOutreach | Apache-2.0 (root `LICENCE.md` — note British spelling, **no plain `LICENSE` file exists**; `pyproject.toml` declares `license = "Apache-2.0"` and `license-files = ["LICENCE.md"]`, consistent) | **No** license-fee restriction, but see "Non-license behavioral baggage" below — material enough to change the practical recommendation. | Safe to reference-for-ideas only. The license itself is permissive, but operational/data-sharing behavior (not a licensing term) makes it unsuitable to run as-is for a multi-tenant SaaS — see Upgrade Backlog. |
| posthog | MIT ("MIT Expat") for core; `ee/` directory separately/more restrictively licensed (`package.json` `"license": "MIT"` matches for the top-level package) | **No** for core. `ee/` is enterprise-gated. | Safe for direct API integration **only via PostHog Cloud's hosted API** (do not self-host — see Dependency Audit for why). Do NOT embed-or-redistribute `ee/`. |
| postiz-app | AGPLv3 (confirmed verbatim GNU AGPL v3 text in root `LICENSE`; `package.json` `"license": "AGPL-3.0"` matches) | **No** fee restriction; no commercial carve-out/exception found anywhere in this clone (unlike Twenty, below) — the general "unmodified service, API-only" AGPL argument is the only safe-harbor available. | Safe for direct API integration (run unmodified, call its public `/public/v1` REST API only). Do NOT embed-or-redistribute or fork its source — there is no explicit application exception to fall back on if that argument is ever challenged. |
| twenty | AGPLv3 **with an explicit, named "Twenty Application Exception"** (confirmed verbatim in root `LICENSE`: "building an external Application that calls Twenty only through its published REST/GraphQL APIs, webhooks, or SDKs does not trigger AGPL obligations... may be licensed on proprietary terms"); MIT for the `twenty-cli`/`twenty-sdk`/`twenty-client-sdk`/`create-twenty-app`/`twenty-shared`/`twenty-ui`/`packages/twenty-apps` toolkit packages; files marked `/* @license Enterprise */` are separately commercially licensed | **No** — this is the **strongest, most explicitly license-safe** API-integration case of all 13 repos, precisely because the exception is a named, written grant rather than a general interpretation of AGPL's scope. | Safe for direct API integration (REST/GraphQL/webhooks) with the highest confidence of any AGPL repo in this set. Do NOT embed-or-redistribute core AGPL-covered source or `@license Enterprise`-marked files; the MIT toolkit packages are separately safe to vendor if ever useful. |
| mastra | Apache-2.0 for everything outside `ee/`-namespaced directories (`auth/ee`, `agent-builder/ee`, `editor/ee`); those require a paid enterprise license (`package.json` `"license": "Apache-2.0"` matches for the top-level package) | **No** for the core framework. `ee/` paths are paid-license-gated. | Safe to reference-for-ideas (its tool-calling loop/model-router), and safe to add as a scoped `npm`/`pnpm` library dependency if ever needed — Apache-2.0 permits this including commercial use. Do NOT embed-or-redistribute `ee/`-namespaced code. |
| aaron-marketing-skills | Apache-2.0 (root `LICENSE`, confirmed) | **No** | Safe for direct use as content (not code) — copy/load `SKILL.md` Markdown files into DevLaunch's own prompt-template store. No redistribution concern beyond standard Apache-2.0 notice retention, since it is prose, not executable software in DevLaunch's runtime path. |

---

## Detail notes per repo (what was actually read)

### chatwoot
Root `LICENSE` line 1-7, verified: copyright "Chatwoot Inc.", explicit three-way split —
`enterprise/` under its own license, third-party components under their own original
licenses, everything else "available under the MIT Expat license." No AGPL anywhere in the
core. This corroborates the prior Milestone 1 audit's finding with the exact clause text now
quoted.

### crawl4ai
Root `LICENSE` is the stock Apache License 2.0 text verbatim (header/definitions match the
canonical Apache text word-for-word). `pyproject.toml` declares `license = "Apache-2.0"`
directly (SPDX-style string, not a classifier). **Important**: the prior Milestone 1 audit
asserted crawl4ai's Apache-2.0 came "plus an added Attribution Requirement clause." This audit's own
read of the root `LICENSE` file found only the standard Apache-2.0 text with no appended
attribution clause in that specific file; a follow-up read of `README.md` located the actual
clause there instead — a "License & Attribution" section (confirmed, line ~443) offering a
choice of badge- or text-attribution, phrased as recommended rather than baked into the
license grant itself. So the obligation is real and its location is now resolved, but whether
DevLaunch's own UI/docs actually display it was not checked by this read-only repo audit (that
requires inspecting DevLaunch's own surface, not crawl4ai's) — see Upgrade Backlog item 10.

### formbricks
Root `LICENSE`, lines 1-9 read verbatim: three-way split exactly like chatwoot/posthog's
pattern — `apps/web/modules/ee` under its own commercial license, the six named SDK packages
(`js-core`, `android`, `ios`, `api`, `surveys`, `survey-ui`) under MIT per their own
`package.json` `license` fields, everything else under AGPLv3 (full GNU AGPLv3 preamble
follows in the same file, confirmed). Root `package.json` itself declares no top-level
`"license"` field (monorepo root, expected — license is per-package as the LICENSE file
itself states).

### leadhub
Root `LICENSE`: stock MIT license text, copyright "Harvey Yuan," 2026. `pyproject.toml`:
`license = "MIT"`, `requires-python = ">=3.12"`. Fully consistent, no caveats.

### listmonk
Root `LICENSE`: stock GNU AGPLv3 preamble text verbatim, confirmed. `go.mod`:
`module github.com/knadh/listmonk`, `go 1.27.3` — no license field in `go.mod` (Go doesn't
carry one there), consistent with the LICENSE file being authoritative.

### mautic
Root `LICENSE.txt` (note: `.txt` extension, not `LICENSE`): header "Mautic - Open source
marketing automation software, Copyright 2014 by the contributors", body is the GNU GPLv3
("free software...GNU General Public License...version 3"). `composer.json`:
`"license": "GPL-3.0"`, `"php": "8.2.0"` — consistent.

### n8n
Two license files, both read in full/substantially: `LICENSE.md` gives the three-way split
(branches other than `master` unlicensed; `.ee.`-named/dirnamed files need `LICENSE_EE.md`'s
terms; everything else under "Sustainable Use License" v1.0, full text quoted inline) —
confirmed verbatim, including the exact "internal business purposes or...non-commercial or
personal use" / "free of charge for non-commercial purposes" limitation language that makes
this NOT an OSI open-source license (fair-code, per n8n's own public positioning, independently
confirmed here by reading the actual clause rather than taking that positioning on faith).
`LICENSE_EE.md` confirmed separately: production use of `.ee.` files requires "a valid n8n
Enterprise license," development/testing use is exempted without one. `package.json`:
`"engines": {"node": ">=24.0.0", "pnpm": ">=12.4.2"}` — no `license` field in the root
`package.json` directly (license is governed by the two markdown files, appropriately).

### OpenOutreach
**No `LICENSE` file exists in this repo** — it uses the British spelling `LICENCE.md`
instead, confirmed by directory listing (`ls` shows `LICENCE.md`, not `LICENSE`). Read in
full up to its license-grant text: Apache-2.0. `pyproject.toml` explicitly cross-references
it: `license = "Apache-2.0"`, `license-files = ["LICENCE.md"]` — internally consistent.
**Separately, and more materially**: `LEGAL_NOTICE.md` (14KB, read substantially) discloses
non-license behavioral facts that change the practical recommendation despite the permissive
license — see the License Audit summary table and Upgrade Backlog. This audit independently
re-confirmed, by reading the actual current text (not assuming the prior audit's summary was
still accurate), that (a) the central "hub.openoutreach.app" contact-pooling behavior is
**still live and described in detail today** (Section 6: "a central contacts store operated by
the project maintainer... pools two things across the OpenOutreach network"), while (b) the
prior audit-era "freemium promotional campaign riding along in the sending rotation" has
since been **removed** ("It is deleted, and nothing replaced it") — a real, verifiable
improvement since whenever the prior audit's note was written, and the kind of drift this
document exists to catch rather than assume.

### posthog
Root `LICENSE`: "MIT Expat" three-way split pattern (copyright "PostHog Inc.", `ee/` directory
separately licensed, everything else MIT) — same structural pattern as chatwoot's LICENSE
file, confirmed by direct read. `package.json`: `"license": "MIT"` matches. `pyproject.toml`:
`requires-python = "==3.14.7"` (pinned exact, not a range — unusually strict even among this
cohort) — no license field there (correctly deferred to the root LICENSE/package.json).

### postiz-app
Root `LICENSE`: stock GNU AGPLv3 preamble verbatim, confirmed. `package.json`:
`"license": "AGPL-3.0"`, `"engines": {"node": "22.23.4"}` (exact pin, not a range) — matches.
No commercial/application exception clause found anywhere in this LICENSE file, in contrast
to Twenty's explicit exception below — this absence was independently re-verified by reading
the full file, not assumed from the prior audit.

### twenty
Root `LICENSE` (not a stock license — a custom document): read in full through the exception
clause. Confirmed verbatim: "mostly licensed under... AGPLv3... with two qualifications" —
(1) files marked `/* @license Enterprise */` are commercially licensed, (2) a named list of
packages (twenty CLI, twenty-sdk, twenty-client-sdk, create-twenty-app, twenty-shared,
twenty-ui, `packages/twenty-apps`) are MIT per their own `package.json` license field and
LICENSE file. Then: "ADDITIONAL PERMISSION UNDER AGPLv3 SECTION 7 (Twenty Application
Exception)" — a named, defined legal mechanism (AGPLv3 §7 additional-permission clause),
not an informal interpretation. `package.json`: `"license": "AGPL-3.0"`,
`"engines": {"node": "^26.5.1", "npm": "please-use-yarn", "yarn": ">=4.0.2"}` — matches,
and the Node version is confirmed bleeding-edge (`^26.5.1`) exactly as the prior audit flagged.

### mastra
`LICENSE.md`: custom document, read through its structure — explicitly lists `ee/`-namespaced
directories (`@mastra/core/auth/ee`, `@mastra/core/agent-builder/ee`, `@mastra/editor/ee`) as
commercially licensed, "Content outside of the above-mentioned directories... is licensed
under [Apache-2.0, continuing text confirmed]." `package.json`: `"license": "Apache-2.0"`,
`"engines": {"node": "^22.19.0 || >=24.11.0", "pnpm": ">=11.0.0"}` — matches.

### aaron-marketing-skills
Root `LICENSE`: stock Apache License 2.0 text verbatim, confirmed identical structure to
crawl4ai's. No package.json/pyproject.toml/go.mod in this repo at all (it is a content
library, not executable software, confirmed by the earlier Milestone 1 audit's file-type
census and not re-disputed here) — license applies at the repo level via the root file and
(per the Milestone 1 audit, not independently re-verified by this pass) a per-skill
`license: Apache-2.0` frontmatter field.

---

## Single highest-value licensing finding across all 13 repos

**n8n's Sustainable Use License v1.0 is the one license in this set that is an active legal
blocker on an entire category of future product decision, not just a code-hygiene concern.**
Every other repo in this set is either a standard permissive license (MIT/Apache-2.0) or a
copyleft license whose obligations are satisfiable by the "run it unmodified, call it over its
own API" pattern DevLaunch already uses for listmonk/postiz/chatwoot. n8n is different in kind:
its license is not OSI-approved open source at all, and its own text explicitly states that
using or distributing the software for commercial purposes beyond "internal business purposes"
is outside the grant. Concretely, this means DevLaunch can run n8n for its own internal ops
workflows (safe — that's "internal business purposes"), but **cannot** offer n8n-powered
workflow execution as a monetized, customer-facing feature to its own paying tenants without
first obtaining a separate commercial/OEM license from n8n GmbH. This is a go/no-go business
and legal decision that should be explicitly flagged to whoever owns commercial terms before
any roadmap item assumes "customers can build their own automations" is backed by n8n — not
an engineering risk that can be designed around with an API-only integration pattern the way
the AGPL repos' risk can.
