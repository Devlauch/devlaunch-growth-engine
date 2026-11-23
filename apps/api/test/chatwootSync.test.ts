import { describe, it, expect, vi, beforeEach } from "vitest";

const createContactMock = vi.fn();
const getChatwootClientForTenantMock = vi.fn();

vi.mock("../src/lib/chatwootClient.js", () => ({
  getChatwootClientForTenant: getChatwootClientForTenantMock,
}));

const { syncLeadToChatwootContact } = await import("../src/lib/chatwootSync.js");

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const PROJECT_1 = "33333333-3333-3333-3333-333333333333";
const fakeTenantDb = {} as unknown as import("pg").PoolClient;

beforeEach(() => {
  createContactMock.mockReset();
  getChatwootClientForTenantMock.mockReset();
});

describe("syncLeadToChatwootContact", () => {
  it("no-ops (never throws) when chatwoot is not configured for this tenant/project", async () => {
    getChatwootClientForTenantMock.mockResolvedValueOnce({ status: "not_configured", detail: "nope" });

    await expect(
      syncLeadToChatwootContact(fakeTenantDb, TENANT_A, PROJECT_1, { id: "lead-1", name: "Ada" }),
    ).resolves.toBeUndefined();
  });

  it("calls createContact with the lead's name/email when chatwoot is configured", async () => {
    getChatwootClientForTenantMock.mockResolvedValueOnce({ createContact: createContactMock });
    createContactMock.mockResolvedValueOnce({ id: 7, name: "Ada", email: "ada@example.com" });

    await syncLeadToChatwootContact(fakeTenantDb, TENANT_A, PROJECT_1, {
      id: "lead-1",
      name: "Ada",
      email: "ada@example.com",
      company: "Acme",
    });

    expect(createContactMock).toHaveBeenCalledTimes(1);
    const [input] = createContactMock.mock.calls[0];
    expect(input).toMatchObject({ name: "Ada", email: "ada@example.com" });
    expect(input.customAttributes).toMatchObject({ devlaunch_lead_id: "lead-1", company: "Acme" });
  });

  it("swallows (logs, never throws) a failed createContact call", async () => {
    getChatwootClientForTenantMock.mockResolvedValueOnce({ createContact: createContactMock });
    createContactMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    await expect(
      syncLeadToChatwootContact(fakeTenantDb, TENANT_A, PROJECT_1, { id: "lead-1", name: "Ada" }),
    ).resolves.toBeUndefined();
  });

  it("skips the call entirely when the lead has neither name nor email", async () => {
    getChatwootClientForTenantMock.mockResolvedValueOnce({ createContact: createContactMock });

    await syncLeadToChatwootContact(fakeTenantDb, TENANT_A, PROJECT_1, { id: "lead-1" });

    expect(createContactMock).not.toHaveBeenCalled();
  });
});
