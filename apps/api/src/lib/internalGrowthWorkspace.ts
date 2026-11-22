import { env } from "../config/env.js";

/**
 * DevLaunch's own internal customer-acquisition workspace: a real tenant +
 * project row (migration 421_create_devlaunch_internal_workspace.sql),
 * fully RLS-isolated exactly like any client tenant — nothing here is a
 * bypass of tenant isolation, it is just the one, well-known tenant/project
 * id that routes/publicGrowth.ts (unauthenticated capture) and
 * routes/internalGrowth.ts (authenticated staff dashboard) are hardcoded to
 * operate on.
 *
 * Defaults match the fixed ids the migration seeds, so this works out of
 * the box in any environment that ran migrations; DEVLAUNCH_INTERNAL_
 * TENANT_ID / _PROJECT_ID exist purely so a real deployment can point this
 * at a different tenant/project without a code change (e.g. if ops decides
 * to re-home the workspace later).
 */
export const INTERNAL_TENANT_ID = env.devlaunchInternalTenantId ?? "d3f6a1b0-0000-4000-8000-000000000001";
export const INTERNAL_PROJECT_ID = env.devlaunchInternalProjectId ?? "d3f6a1b0-0000-4000-8000-000000000002";
