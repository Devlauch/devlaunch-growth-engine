import { describe, it, expect, vi } from "vitest";
import { getNextBestActionForLead } from "../src/lib/nextBestAction.js";

/**
 * Real, mocked-pg-client unit test for Workstream F's new
 * getNextBestActionForLead (extends the EXISTING nextBestAction.ts rather
 * than duplicating it — see that file's own header comment on
 * recommendNextActions vs. getNextBestActionForLead). Same mocking
 * convention as test/leadActivity.test.ts / test/unifiedCustomerProfile.test.ts:
 * a bare { query } object standing in for the tenant-scoped PoolClient, no
 * real Postgres involved.
 *
 * getNextBestActionForLead's own 2 queries (leads.status, deals.stage for
 * lifecycle) are always first, followed by getUnifiedTimeline's full query
 * sequence (see unifiedCustomerProfile.test.ts's own comment on that exact
 * order: activityTimeline.ts's 7 Promise.all queries, then meetingMeta +
 * replyMeta, then the leads.visitor_id lookup, then — only if a visitor_id
 * was found — site_sessions/site_pageviews/site_events, then
 * chatbot_conversations, then chatwoot_contact_leads).
 */

const TENANT_ID = "11111111-1111-1111-1111-111111111111";
const PROJECT_ID = "33333333-3333-3333-3333-333333333333";
const LEAD_ID = "55555555-5555-5555-5555-555555555555";

function makeTenantDb(responses: unknown[]) {
  const queryMock = vi.fn();
  for (const r of responses) queryMock.mockResolvedValueOnce(r);
  return { query: queryMock };
}

const EMPTY = { rowCount: 0, rows: [] };

/** The 12 getUnifiedTimeline queries, with no site/chatwoot correlation at all (a lead that was never tracked as a website visitor and has no Chatwoot mapping) — the common case most of these scenarios reuse. */
function noCorrelationTimelineQueries(crmQueries: unknown[] = [EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY]) {
  return [
    ...crmQueries, // assignments, deals, meetings, tasks, notes, replies, auditEvents
    EMPTY, // meetingMeta
    EMPTY, // replyMeta
    { rowCount: 1, rows: [{ visitor_id: null }] }, // leads.visitor_id lookup
    EMPTY, // chatbot_conversations
    EMPTY, // chatwoot_contact_leads mapping
  ];
}

describe("getNextBestActionForLead", () => {
  it("returns 'No action' when the lead does not exist in this tenant/project", async () => {
    const tenantDb = makeTenantDb([EMPTY]); // leads lookup -> not found
    const result = await getNextBestActionForLead(tenantDb, TENANT_ID, PROJECT_ID, LEAD_ID);
    expect(result.action).toBe("No action");
    expect(result.reason).toMatch(/not found/);
  });

  it("recommends monitoring for renewal when the lead already has a won deal (lifecycle stage 'customer')", async () => {
    const tenantDb = makeTenantDb([
      { rowCount: 1, rows: [{ status: "approved_for_outreach" }] }, // leads
      { rowCount: 1, rows: [{ stage: "won" }] }, // deals (lifecycle)
      ...noCorrelationTimelineQueries(),
    ]);
    const result = await getNextBestActionForLead(tenantDb, TENANT_ID, PROJECT_ID, LEAD_ID);
    expect(result.action).toMatch(/renewal\/expansion/);
    expect(result.reason).toMatch(/"customer"/);
  });

  it("recommends following up on the open deal when lifecycle stage is 'opportunity' with no high-intent signal", async () => {
    const tenantDb = makeTenantDb([
      { rowCount: 1, rows: [{ status: "new" }] }, // leads
      { rowCount: 1, rows: [{ stage: "contacted" }] }, // deals (lifecycle)
      ...noCorrelationTimelineQueries(),
    ]);
    const result = await getNextBestActionForLead(tenantDb, TENANT_ID, PROJECT_ID, LEAD_ID);
    expect(result.action).toBe("Follow up on the open deal");
    expect(result.reason).toMatch(/"opportunity"/);
  });

  it("recommends proactive outreach when lifecycle stage is 'opportunity' AND the lead has repeated recent pricing-page visits", async () => {
    const tenantDb = makeTenantDb([
      { rowCount: 1, rows: [{ status: "new" }] }, // leads
      { rowCount: 1, rows: [{ stage: "contacted" }] }, // deals (lifecycle)
      // getUnifiedTimeline -> buildCrmEvents
      EMPTY,
      EMPTY,
      EMPTY,
      EMPTY,
      EMPTY,
      EMPTY,
      EMPTY, // assignments..auditEvents
      EMPTY, // meetingMeta
      EMPTY, // replyMeta
      { rowCount: 1, rows: [{ visitor_id: "visitor-abc" }] }, // leads.visitor_id lookup -> correlated
      { rowCount: 0, rows: [] }, // sessions
      {
        rowCount: 3,
        rows: [
          { session_id: "s1", path: "/pricing", url: "https://x/pricing", viewed_at: new Date().toISOString() },
          {
            session_id: "s1",
            path: "/pricing",
            url: "https://x/pricing",
            viewed_at: new Date(Date.now() - 86400000).toISOString(),
          },
          {
            session_id: "s1",
            path: "/pricing",
            url: "https://x/pricing",
            viewed_at: new Date(Date.now() - 2 * 86400000).toISOString(),
          },
        ],
      }, // pageviews: 3 pricing visits within 7 days
      EMPTY, // site_events
      EMPTY, // chatbot_conversations
      EMPTY, // chatwoot_contact_leads mapping
    ]);
    const result = await getNextBestActionForLead(tenantDb, TENANT_ID, PROJECT_ID, LEAD_ID);
    expect(result.action).toMatch(/reviewing pricing/);
    expect(result.reason).toMatch(/pricing-related page 3 time\(s\)/);
  });

  it("recommends scheduling a discovery call when lifecycle stage is 'sql' with no meeting scheduled", async () => {
    const tenantDb = makeTenantDb([
      { rowCount: 1, rows: [{ status: "approved_for_outreach" }] }, // leads
      { rowCount: 0, rows: [] }, // deals (lifecycle) -- none yet
      ...noCorrelationTimelineQueries(),
    ]);
    const result = await getNextBestActionForLead(tenantDb, TENANT_ID, PROJECT_ID, LEAD_ID);
    expect(result.action).toBe("Schedule a discovery call");
    expect(result.reason).toMatch(/"sql"/);
  });

  it("recommends preparing for the meeting when lifecycle stage is 'sql' and a meeting is already scheduled in the future", async () => {
    const futureIso = new Date(Date.now() + 3 * 86400000).toISOString();
    const tenantDb = makeTenantDb([
      { rowCount: 1, rows: [{ status: "approved_for_outreach" }] }, // leads
      { rowCount: 0, rows: [] }, // deals (lifecycle)
      // buildCrmEvents
      EMPTY, // assignments
      EMPTY, // deals (activityTimeline's own)
      {
        rowCount: 1,
        rows: [
          {
            id: "meeting-1",
            type: "demo",
            status: "scheduled",
            scheduled_at: futureIso,
            outcome_notes: null,
            next_step: null,
          },
        ],
      }, // meetings
      EMPTY, // tasks
      EMPTY, // notes
      EMPTY, // replies
      EMPTY, // auditEvents
      { rowCount: 1, rows: [{ id: "meeting-1", status: "scheduled", scheduled_at: futureIso }] }, // meetingMeta
      EMPTY, // replyMeta
      { rowCount: 1, rows: [{ visitor_id: null }] }, // leads.visitor_id lookup
      EMPTY, // chatbot_conversations
      EMPTY, // chatwoot_contact_leads mapping
    ]);
    const result = await getNextBestActionForLead(tenantDb, TENANT_ID, PROJECT_ID, LEAD_ID);
    expect(result.action).toBe("Prepare for the scheduled meeting");
    expect(result.reason).toMatch(/already scheduled/);
  });

  it("recommends promoting to sales outreach when lifecycle stage is 'mql' with a high engagement score", async () => {
    const fresh = new Date().toISOString();
    const tenantDb = makeTenantDb([
      { rowCount: 1, rows: [{ status: "qualified" }] }, // leads
      { rowCount: 0, rows: [] }, // deals (lifecycle)
      // buildCrmEvents -- several fresh CRM events to push the engagement score up
      { rowCount: 1, rows: [{ id: "a1", assigned_user_id: "u2", assigned_by: "u1", assigned_at: fresh }] }, // assignments
      EMPTY, // deals (activityTimeline's own)
      EMPTY, // meetings
      { rowCount: 1, rows: [{ id: "t1", task_type: "call", title: "Call", status: "open", due_at: null, updated_at: fresh }] }, // tasks
      { rowCount: 1, rows: [{ id: "n1", body: "Note", created_at: fresh }] }, // notes
      EMPTY, // replies
      EMPTY, // auditEvents
      EMPTY, // meetingMeta
      EMPTY, // replyMeta
      { rowCount: 1, rows: [{ visitor_id: "visitor-xyz" }] }, // leads.visitor_id lookup -> correlated
      { rowCount: 1, rows: [{ session_id: "s1", started_at: fresh, referrer: null, landing_url: null }] }, // sessions
      EMPTY, // pageviews
      EMPTY, // site_events
      { rowCount: 1, rows: [{ id: "conv-1", status: "ended", visitor_exchange_count: 2, started_at: fresh, last_message_at: fresh }] }, // chatbot_conversations
      EMPTY, // chatwoot_contact_leads mapping
    ]);
    const result = await getNextBestActionForLead(tenantDb, TENANT_ID, PROJECT_ID, LEAD_ID);
    expect(result.action).toBe("Promote to sales outreach (approve for outreach)");
    expect(result.reason).toMatch(/"mql"/);
  });

  it("recommends a low-touch nurture sequence for a brand-new lead with zero timeline activity", async () => {
    const tenantDb = makeTenantDb([
      { rowCount: 1, rows: [{ status: "new" }] }, // leads
      { rowCount: 0, rows: [] }, // deals (lifecycle)
      ...noCorrelationTimelineQueries(),
    ]);
    const result = await getNextBestActionForLead(tenantDb, TENANT_ID, PROJECT_ID, LEAD_ID);
    expect(result.action).toBe("Add to a low-touch nurture sequence");
    expect(result.reason).toMatch(/"lead"/);
  });
});
