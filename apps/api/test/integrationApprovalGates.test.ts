import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";

/**
 * Cross-cutting regression net for Milestone 2's non-negotiable rule (see
 * docs/INTEGRATION_STATUS.md section 4 and docs/SECURITY_REVIEW.md's
 * per-integration "Approval gate (non-negotiable)" write-ups): no
 * send/publish without a real, human-decided `approvals` row set via the
 * EXISTING `POST .../approvals/:approvalId/decision` route
 * (apps/api/src/routes/approvals.ts) — never auto-approved, never bypassed
 * by any integration's own code.
 *
 * This file is intentionally NOT a re-implementation of each integration's
 * own approval-gate test matrix:
 *   - apps/api/test/listmonkSync.test.ts's `triggerCampaignSend` describe
 *     block already covers the full not-approved / approved matrix for
 *     listmonk.
 *   - apps/api/test/postizIntegration.test.ts's "the non-negotiable approval
 *     gate" describe block already covers no-approval / pending / rejected /
 *     approved-and-published / already-published-idempotent for postiz.
 * Those stay the authoritative, detailed per-integration suites. This file
 * is a thin, minimal tripwire: one focused "refuses without an approved
 * approvals row" test per integration that actually has a send/publish gate,
 * reusing each integration's own existing mocking helpers/conventions rather
 * than inventing a new one, so a future change that accidentally removes or
 * weakens the gate in ANY of these files shows up here too.
 */

// ---------------------------------------------------------------------------
// Shared mocked-pg-pool setup for the Postiz test below (same convention as
// postizIntegration.test.ts). vi.mock calls are hoisted by vitest regardless
// of where they appear in the file, but kept at module top level here to
// match every other test file's own convention and avoid relying on that
// hoisting behavior across a describe boundary.
// ---------------------------------------------------------------------------
const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({ query: queryMock, release: releaseMock }));

vi.mock("../src/db/pool.js", () => ({
  pool: { connect: connectMock },
}));

// Must be set BEFORE the dynamic imports below — config/env.ts reads
// process.env once at module-evaluation time (same convention as
// postizIntegration.test.ts).
process.env.INTEGRATION_CREDENTIALS_KEY = Buffer.alloc(32, 11).toString("base64");

const { postizIntegrationRouter } = await import("../src/routes/postizIntegration.js");
const { errorHandler: postizErrorHandler } = await import("../src/middleware/errorHandler.js");
const { triggerCampaignSend, CampaignNotApprovedError } = await import("../src/lib/listmonkSync.js");
import type { ListmonkClient } from "../src/lib/listmonkClient.js";
import type { PoolClient } from "pg";

function queueResponses(responses: unknown[]) {
  for (const r of responses) queryMock.mockResolvedValueOnce(r);
}

function mockMembership(role = "owner") {
  return [undefined, undefined, { rowCount: 1, rows: [{ id: "m1", role, status: "active" }] }];
}

beforeEach(() => {
  queryMock.mockReset();
  releaseMock.mockReset();
  connectMock.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Listmonk — campaign send refuses without an approved approvals row", () => {
  it("triggerCampaignSend throws CampaignNotApprovedError (and never calls the real listmonk send endpoint) when campaigns.status is not 'approved'", async () => {
    // Same fakeClient/fakeTenantDb shape as listmonkSync.test.ts's own
    // `triggerCampaignSend` describe block — reused here rather than
    // reinvented, kept to the one assertion this regression file cares
    // about (the gate itself), not the full matrix that file already owns.
    const query = vi.fn().mockResolvedValueOnce({ rowCount: 1, rows: [{ status: "pending_approval" }] });
    const tenantDb = { query } as unknown as PoolClient;
    const client = {
      health: vi.fn(),
      getOrCreateList: vi.fn(),
      upsertSubscriber: vi.fn(),
      createCampaign: vi.fn(),
      // THE regression tripwire: this is the only listmonk client call that
      // actually triggers a real send (PUT /api/campaigns/:id/status
      // {status:'running'}) — it must never be reached without a real
      // 'approved' campaigns row.
      updateCampaignStatus: vi.fn(),
      getCampaign: vi.fn(),
    } as unknown as ListmonkClient;

    await expect(triggerCampaignSend(tenantDb, "tenant-1", "campaign-1", client)).rejects.toThrow(CampaignNotApprovedError);
    expect(client.updateCampaignStatus).not.toHaveBeenCalled();
  });
});

describe("Postiz — POST .../posts/:postId/publish refuses without an approved approvals row", () => {
  const TENANT_1 = "11111111-1111-1111-1111-111111111111";
  const PROJECT_1 = "33333333-3333-3333-3333-333333333333";
  const POST_1 = "44444444-4444-4444-4444-444444444444";
  const USER_1 = "user-1";
  const BASE = `/api/v1/tenants/${TENANT_1}/projects/${PROJECT_1}/integrations/postiz`;

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api/v1/tenants/:tenantId/projects/:projectId/integrations/postiz", postizIntegrationRouter);
    app.use(postizErrorHandler);
    return app;
  }

  it("refuses (403) to publish a post with no approval row at all, and never calls the real Postiz publish endpoint", async () => {
    const app = buildApp();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{ "?column?": 1 }] }, // project exists in tenant
      {
        rowCount: 1,
        rows: [{ id: POST_1, status: "draft", content: "hi", platforms: ["int-1"], scheduled_at: null, approval_status: null }],
      },
    ]);

    const res = await request(app).post(`${BASE}/posts/${POST_1}/publish`).set("X-Dev-User-Id", USER_1).send({});

    expect(res.status).toBe(403);
    // THE regression tripwire: no real outbound call to Postiz's publish
    // endpoint was ever made without a real approved approvals row.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Chatwoot — no publish/send gate (intentional N/A, not a missing test)", () => {
  it("documents explicitly that Chatwoot has no outbound send/publish gate to test here: it is a live human-agent chat/inbox product, not a campaign-send or content-publish integration", () => {
    // Per docs/INTEGRATION_STATUS.md section 0 ("Chatwoot is not a
    // replacement for [the in-house chatbot] — it's a live human-agent
    // chat/inbox product") and docs/SECURITY_REVIEW.md's Chatwoot section:
    // this integration only ever (a) receives inbound conversation/contact
    // webhook events and syncs a lead, and (b) lets the platform's own
    // AgentBot identity reply into an existing conversation via Chatwoot's
    // REST API (chatwootClient.ts#sendMessage). Neither path is gated by
    // the `approvals` table, because neither is an irreversible
    // send/publish action the audit's "no sending/publishing without
    // approval" rule was written for (a human live-chat reply is not a
    // scheduled campaign send or a social post). This is a deliberate,
    // documented N/A — called out here explicitly, per this file's own
    // brief, rather than silently having no Chatwoot section at all.
    expect(true).toBe(true);
  });
});
