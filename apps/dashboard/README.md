# @devlaunch/dashboard

Phase 1 dashboard UI for DevLaunch Growth Engine. Vite + React + TypeScript,
talking to `apps/api`.

## Screens

- **Organizations / projects** (`/`, `/tenants/:tenantId`) — create a tenant
  and a project. Each project auto-gets a `public_api_key` on creation.
- **Project hub** (`/tenants/:tenantId/projects/:projectId`) — a
  getting-started checklist (create project → get embed snippet → first
  lead → run market-research), the agents list with a "Run market-research"
  button, and the lead-capture widget settings (public key, a
  live-editable embed snippet, and the leads table).
- **Execution detail** (`/tenants/:tenantId/executions/:executionId`) —
  polls `GET /api/v1/tenants/:tenantId/agent-executions/:executionId` every
  2s until the run reaches a terminal status, then renders the structured
  result (or the error / needs-approval state).

Every list/table renders an explicit "no data yet" empty state instead of
fabricating rows — this is a hard Phase 1 rule.

## Auth

Uses the real JWT auth routes (`/auth/register`, `/auth/login`,
`/auth/refresh`, `/auth/me`) — not the `X-Dev-User-Id` dev bypass — since a
dev header doesn't correspond to a real `users` row and can't satisfy the
`memberships.user_id` foreign key. Tokens are kept in `localStorage`; a
401 triggers one silent refresh attempt before falling back to the login
screen.

## Backend addition that shipped with this UI

`GET /api/v1/tenants/:tenantId/projects/:projectId/leads` (new,
`apps/api/src/routes/leads.ts`) — a small read-only list endpoint the leads
table needs; it didn't exist in the scaffolded route set.

## Running locally

```bash
cp .env.example .env   # set VITE_API_BASE_URL if the API isn't on :4000
npm install
npm run dev             # http://localhost:3000
```

## Building

```bash
npm run build            # type-checks, then builds to dist/
npm start                # serves dist/ with serve.js (same as the Docker image)
```

## Known Phase 1 limitations this UI inherits from the API

- No UI for editing a project's `allowed_origins` (CORS allowlist) — the
  widget snippet will 403 until an admin adds the embedding site's origin
  directly (no PATCH endpoint for this exists yet).
- No public-key rotation UI (no rotation endpoint exists yet).
- Approvals queue (`/approvals`) isn't surfaced in this UI yet; the
  execution detail screen just tells the user to check it when a run
  needs approval.
