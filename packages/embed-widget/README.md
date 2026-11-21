# @devlaunch/embed-widget

A tiny, dependency-free, no-build-step `<script>` + `<form>` embed that lets
**any external website** submit leads straight into a DevLaunch project,
via `POST /api/v1/public/projects/:projectPublicKey/leads` in `apps/api`.

## Copy-paste example

```html
<form data-devlaunch-lead-form
      data-api-base="https://api.yourdevlaunch.example"
      data-project-key="pk_your_projects_public_key_here"
      data-success-message="Thanks! We'll be in touch within one business day.">
  <label>Name <input type="text" name="name" required></label>
  <label>Work email <input type="email" name="email" required></label>
  <label>Company <input type="text" name="company"></label>
  <label>What are you looking for? <textarea name="message"></textarea></label>
  <!-- Any other named field is captured as a "custom field" automatically -->
  <label>Team size <input type="text" name="team_size"></label>

  <button type="submit">Request a demo</button>
</form>

<script src="https://api.yourdevlaunch.example/embed/embed.js" defer></script>
```

That's it — no bundler, no npm install, no framework required. The script:

1. Finds every `form[data-devlaunch-lead-form]` on the page.
2. On submit, reads `name` / `email` / `company` / `message`, plus any
   other named field as a custom field.
3. `POST`s them as JSON to
   `{data-api-base}/api/v1/public/projects/{data-project-key}/leads`.
4. Shows an inline success/error message and resets the form — no page
   reload, no redirect.

## Getting a `data-project-key`

Every project has its own `public_api_key` (see
`packages/db/migrations/016_add_project_public_key.sql`), visible to a
tenant member via `GET /api/v1/tenants/:tenantId/projects/:projectId`. It
is a random opaque token, safe to publish in page source — it is **not**
your DevLaunch login, a tenant id, or any database credential, and it only
ever allows creating leads for that one project.

## Before the form will work: allow this site's origin

The API also checks the browser's `Origin` header against the project's
`allowed_origins` allowlist. Ask whoever manages the DevLaunch project to
add your site's exact origin (e.g. `https://www.your-site.com`, including
the right scheme/subdomain, no trailing slash) to that project's
`allowed_origins`, and to make sure the project's `public_widget_enabled`
flag is on. Until then, submissions are rejected with `403 forbidden`.

## What this does **not** do

This widget only ever creates one `leads` row (tagged
`source: "public_widget"`, with a matching `audit_events` row). It never:

- sends an email, text, or any outbound message to the lead,
- calls any third-party service,
- auto-approves or auto-triggers an agent.

A captured lead is reviewed and qualified through the normal DevLaunch
agent + approval flow (`GET/POST /api/v1/tenants/:tenantId/approvals`)
before anything is ever sent — "no automatic outreach" applies to this
endpoint exactly like every other lead source.

## Hosting `embed.js`

`embed.js` is a static, framework-free file — serve it from anywhere (a
CDN, a static bucket, or directly from the API under e.g. `/embed/embed.js`).
It has no build step: what's in this folder is what you ship.
