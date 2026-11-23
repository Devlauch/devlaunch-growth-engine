// Client-side-only convenience: which tenant to land a user on when they
// have more than one membership (owned + invited elsewhere). Never the
// source of truth for access — every tenant-scoped API call is still
// re-checked server-side against real memberships rows regardless of what
// this says. Falls back gracefully (App.tsx's RootRoute picks the owned
// membership, else the first one) if storage is unavailable or stale.
const LAST_ACTIVE_TENANT_KEY = "devlaunch_last_active_tenant_id";

export function getLastActiveTenantId(): string | null {
  try {
    return localStorage.getItem(LAST_ACTIVE_TENANT_KEY);
  } catch {
    return null;
  }
}

export function setLastActiveTenantId(tenantId: string): void {
  try {
    localStorage.setItem(LAST_ACTIVE_TENANT_KEY, tenantId);
  } catch {
    // ignore — private mode / blocked storage, just won't be remembered
  }
}
