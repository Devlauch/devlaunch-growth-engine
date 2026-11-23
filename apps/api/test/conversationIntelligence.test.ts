import { describe, it, expect, vi, beforeEach } from "vitest";

// Lib-level unit tests over a mocked pg client, same convention as
// campaignAttribution.test.ts / leadActivity.test.ts.
const queryMock = vi.fn();

const { summarizeConversationForHandoff, handoffToSales } = await import("../src/lib/conversationIntelligence.js");

const TENANT_1 = "11111111-1111-1111-1111-111111111111";
const LEAD_1 = "55555555-5555-5555-5555-555555555555";
const DEAL_1 = "66666666-6666-6666-6666-666666666666";
const CONVERSATION_1 = "123";
const USER_1 = "user-1";

function fakeTenantDb() {
  return { query: queryMock };
}

function queueResponses(responses: unknown[]) {
  for (const r of responses) queryMock.mockResolvedValueOnce(r);
}

beforeEach(() => {
  queryMock.mockReset();
});

function webhookEventRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "event-1",
    event_type: "message_created",
    payload: {
      event: "message_created",
      content: "I'm interested, let's talk",
      message_type: "incoming",
      conversation: { id: CONVERSATION_1 },
      contact: { id: "contact-1" },
    },
    received_at: "2025-06-01T12:00:00.000Z",
    ...overrides,
  };
}

describe("summarizeConversationForHandoff", () => {
  it("derives sentiment from the EXISTING classifyReply() classifier over real stored inbound message content", async () => {
    queueResponses([
      { rowCount: 1, rows: [webhookEventRow()] }, // integration_webhook_events
      { rowCount: 1, rows: [{ lead_id: LEAD_1 }] }, // chatwoot_contact_leads mapping
    ]);

    const summary = await summarizeConversationForHandoff(fakeTenantDb() as never, TENANT_1, CONVERSATION_1);

    expect(summary.messageCount).toBe(1);
    expect(summary.eventCount).toBe(1);
    expect(summary.lastMessageAt).toBe("2025-06-01T12:00:00.000Z");
    expect(summary.sentiment).toEqual({ classification: "interested", confidence: "high" });
    expect(summary.leadId).toBe(LEAD_1);
  });

  it("never fabricates a sentiment when there is no stored inbound message content", async () => {
    queueResponses([
      {
        rowCount: 1,
        rows: [
          webhookEventRow({
            payload: {
              event: "message_created",
              message_type: "outgoing", // agent reply, not a visitor message
              conversation: { id: CONVERSATION_1 },
            },
          }),
        ],
      },
      { rowCount: 0, rows: [] }, // no contact on this event -> no lead lookup needed, but code still checks
    ]);

    const summary = await summarizeConversationForHandoff(fakeTenantDb() as never, TENANT_1, CONVERSATION_1);
    expect(summary.sentiment).toBeNull();
    expect(summary.leadId).toBeNull();
  });

  it("returns zeroed counts and no fabricated data when nothing has been recorded for this conversation", async () => {
    queueResponses([{ rowCount: 0, rows: [] }]);

    const summary = await summarizeConversationForHandoff(fakeTenantDb() as never, TENANT_1, "no-such-conversation");
    expect(summary.eventCount).toBe(0);
    expect(summary.messageCount).toBe(0);
    expect(summary.lastMessageAt).toBeNull();
    expect(summary.sentiment).toBeNull();
    expect(summary.leadId).toBeNull();
  });
});

describe("handoffToSales", () => {
  it("writes a real audit_events row linking the conversation to a lead — the same mechanism activityTimeline.ts already reads", async () => {
    queueResponses([
      { rowCount: 1, rows: [{ id: LEAD_1 }] }, // leads existence check
      { rowCount: 1, rows: [webhookEventRow()] }, // summarizeConversationForHandoff: events
      { rowCount: 1, rows: [{ lead_id: LEAD_1 }] }, // chatwoot_contact_leads mapping
      { rows: [{ id: "audit-1" }] }, // INSERT audit_events
    ]);

    const result = await handoffToSales(fakeTenantDb() as never, TENANT_1, CONVERSATION_1, { leadId: LEAD_1 }, USER_1);

    expect(result.auditEventId).toBe("audit-1");
    expect(result.entityType).toBe("lead");
    expect(result.entityId).toBe(LEAD_1);

    const insertCall = queryMock.mock.calls.find((c) => typeof c[0] === "string" && c[0].includes("INSERT INTO audit_events"));
    expect(insertCall![0]).toContain("conversation.handed_off_to_sales");
    expect(insertCall![1]).toEqual([
      TENANT_1,
      USER_1,
      "lead",
      LEAD_1,
      JSON.stringify({
        conversationId: CONVERSATION_1,
        messageCount: 1,
        lastMessageAt: "2025-06-01T12:00:00.000Z",
        sentiment: { classification: "interested", confidence: "high" },
      }),
    ]);
  });

  it("supports handing off to a deal instead of a lead", async () => {
    queueResponses([
      { rowCount: 1, rows: [{ id: DEAL_1 }] }, // deals existence check
      { rowCount: 0, rows: [] }, // no conversation events recorded
      { rows: [{ id: "audit-2" }] }, // INSERT audit_events
    ]);

    const result = await handoffToSales(fakeTenantDb() as never, TENANT_1, CONVERSATION_1, { dealId: DEAL_1 }, USER_1);
    expect(result.entityType).toBe("deal");
    expect(result.entityId).toBe(DEAL_1);
  });

  it("refuses when neither leadId nor dealId is given", async () => {
    await expect(handoffToSales(fakeTenantDb() as never, TENANT_1, CONVERSATION_1, {}, USER_1)).rejects.toThrow(
      /requires either a leadId or a dealId/,
    );
  });

  it("refuses when both leadId and dealId are given", async () => {
    await expect(
      handoffToSales(fakeTenantDb() as never, TENANT_1, CONVERSATION_1, { leadId: LEAD_1, dealId: DEAL_1 }, USER_1),
    ).rejects.toThrow(/exactly one/);
  });

  it("refuses when the target lead does not belong to this tenant — never writes a dangling audit trail", async () => {
    queueResponses([{ rowCount: 0, rows: [] }]); // leads existence check: not found

    await expect(
      handoffToSales(fakeTenantDb() as never, TENANT_1, CONVERSATION_1, { leadId: LEAD_1 }, USER_1),
    ).rejects.toThrow(/not found in tenant/);
  });
});
