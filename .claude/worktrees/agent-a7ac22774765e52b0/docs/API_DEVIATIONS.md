# API deviations from the written spec

This file tracks every place where the implemented API shape intentionally
diverges from the original product spec's route list (spec section 12, "API
requirements"), and the reasoning behind each deviation. It exists so a
reviewer comparing the spec to the code can tell "this is a documented,
reasoned decision" apart from "this is drift nobody noticed."

## Agent runs / executions: tenant-scoped routes instead of top-level ones

**Spec says:**

```
POST /api/v1/agents/:agentInstanceId/runs
GET  /api/v1/executions/:executionId
```

**Implemented as:**

```
POST /api/v1/tenants/:tenantId/projects/:projectId/agent-runs   (body: { agentInstanceId, input, idempotencyKey? })
GET  /api/v1/tenants/:tenantId/agent-executions/:executionId
```

**Why this was changed on purpose, not by accident:**

Every other route in this API — projects, memberships, approvals, audit
events, ICP profiles, agent instances — is mounted under
`/api/v1/tenants/:tenantId/...`, and `requireTenantMembership`
(`apps/api/src/middleware/tenant.ts`) is the single place in the app that
decides whether the authenticated caller may act as that tenant. It does
this by taking `:tenantId` straight from the URL, opening a transaction,
setting `app.current_tenant_id` for Postgres row-level security, and then
verifying an active `memberships` row exists for `(tenantId, userId)` before
anything else runs. Every downstream query then runs inside that
RLS-scoped transaction.

The spec's literal routes — `POST /api/v1/agents/:agentInstanceId/runs` and
`GET /api/v1/executions/:executionId` — have no tenant id in the path at
all. Implementing them exactly as written would mean one of:

1. Deriving the tenant from the `agentInstanceId` / `executionId` row
   itself, inside the handler, *before* any membership check has run — i.e.
   trusting a client-supplied resource id to tell us which tenant's RLS
   context to set up, with the membership check happening only after the
   fact. This inverts the trust model every other route in this API
   relies on and would need its own bespoke isolation logic instead of
   reusing `requireTenantMembership`.
2. Making `agentInstanceId`/`executionId` globally unique across all
   tenants and trusting that uniqueness alone to prevent cross-tenant
   access — fragile, and still doesn't tell us *which* tenant to run the
   membership check against without a lookup first.

Putting `:tenantId` in the path, as every other route already does, avoids
both problems: the membership check can run first, uniformly, exactly like
it does for projects, approvals, memberships, etc., and there is never any
ambiguity about which tenant's data a request can touch. This is why
`agent-runs` is nested under `/tenants/:tenantId/projects/:projectId/` (it
also needs the project, since an agent instance belongs to one) and
`agent-executions/:executionId` is nested under `/tenants/:tenantId/`
(the execution's own `tenant_id` column is still re-checked in the `WHERE`
clause, matching the pattern used everywhere else).

**Status:** implemented and shipped as the tenant-scoped shape above. No
alias at the exact spec-literal path was added, because a non-tenant-scoped
`POST /api/v1/agents/:agentInstanceId/runs` cannot be made safe without
either re-deriving tenant context from a client-supplied id before
verifying membership (see above) or duplicating the isolation logic — both
of which were judged higher-risk than simply documenting the deviation
here. If a convenience alias is added later (e.g. a `GET
/api/v1/executions/:executionId` that looks up the execution's `tenant_id`
internally), it must still call `requireAuth` and independently verify the
caller's membership in that execution's tenant before returning anything —
never trust the execution row's `tenant_id` by itself as proof of access.
