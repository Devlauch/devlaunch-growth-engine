import { describe, it, expect, vi } from "vitest";
import { applyPlanChange } from "../src/lib/billingPlanSync.js";

function fakeClient(rows: Record<string, unknown>[] = [{ id: "t1", slug: "acme", name: "Acme", plan: "starter" }]) {
  const query = vi.fn(async () => ({ rowCount: rows.length, rows }));
  return { query };
}

describe("applyPlanChange", () => {
  it("writes the IDENTICAL 'user' actor SQL/params shape the original inline planUsage.ts logic used", async () => {
    const client = fakeClient();
    await applyPlanChange(client as never, "t1", "growth", { type: "user", userId: "u1" });

    const updateCall = client.query.mock.calls[0]!;
    expect(updateCall[0]).toContain("UPDATE tenants");
    expect(updateCall[1]).toEqual(["t1", "growth"]);

    const auditCall = client.query.mock.calls[1]!;
    expect(auditCall[0]).toContain("'user'");
    expect(auditCall[0]).toContain("tenant.plan_changed");
    expect(auditCall[1]).toEqual(["t1", "u1", JSON.stringify({ newPlan: "growth" })]);
  });

  it("writes a 'system' actor audit row (actor_user_id NULL) for a webhook-driven plan change", async () => {
    const client = fakeClient();
    await applyPlanChange(client as never, "t1", "growth", { type: "system", note: "stripe_webhook:checkout.session.completed" });

    const auditCall = client.query.mock.calls[1]!;
    expect(auditCall[0]).toContain("'system'");
    expect(auditCall[0]).not.toContain("actor_user_id");
    expect(JSON.parse(auditCall[1][1] as string)).toEqual({
      newPlan: "growth",
      source: "stripe_webhook:checkout.session.completed",
    });
  });

  it("throws notFound when the tenant row doesn't exist", async () => {
    const client = fakeClient([]);
    await expect(applyPlanChange(client as never, "missing", "growth", { type: "system", note: "x" })).rejects.toThrow(
      "Tenant not found",
    );
  });
});
