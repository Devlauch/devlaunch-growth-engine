import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({ query: queryMock, release: releaseMock }));

vi.mock("../src/db/pool.js", () => ({
  pool: { connect: connectMock },
}));

// This file sends many requests from the same (supertest-simulated) IP
// using the same project public key, which would otherwise trip the
// per-IP/per-key rate limiters this router shares with publicLeads.ts --
// those are exercised on their own in publicLeads.test.ts, so raise the
// limit here before config/env.js (and therefore the router, which reads
// it at module load) is ever imported.
process.env.PUBLIC_LEADS_RATE_LIMIT_PER_IP_PER_MIN = "1000";
process.env.PUBLIC_LEADS_RATE_LIMIT_PER_KEY_PER_MIN = "1000";

const { publicChatbotRouter } = await import("../src/routes/publicChatbot.js");
const { errorHandler } = await import("../src/middleware/errorHandler.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/public", publicChatbotRouter);
  app.use(errorHandler);
  return app;
}

const ALLOWED_ORIGIN = "https://customer-site.example";
const TENANT_1 = "tenant-1";
const PROJECT_1 = "project-1";
const CONVERSATION_1 = "55555555-5555-5555-5555-555555555555";

const projectRow = { id: PROJECT_1, tenant_id: TENANT_1, allowed_origins: [ALLOWED_ORIGIN] };

const enabledConfigRow = {
  tenant_id: TENANT_1,
  project_id: PROJECT_1,
  enabled: true,
  welcome_message: "Hi! Ask me anything.",
  fallback_message: "I don't have an answer for that -- want to leave your details?",
  consent_notice: "Do you consent to us storing your details? (yes/no)",
  qualifying_questions: ["What's your company size?"],
  exchanges_before_qualifying: 2,
  confidence_threshold: 0.2,
};

beforeEach(() => {
  queryMock.mockReset();
  releaseMock.mockReset();
  connectMock.mockClear();
});

function baseConversationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CONVERSATION_1,
    tenant_id: TENANT_1,
    project_id: PROJECT_1,
    status: "active",
    consent_given: false,
    consent_record_id: null,
    lead_id: null,
    qualifying_question_index: 0,
    qualifying_answers: [],
    visitor_exchange_count: 0,
    ...overrides,
  };
}

describe("POST /api/v1/public/projects/:projectPublicKey/chatbot/sessions", () => {
  it("rejects an unknown project public key with 404", async () => {
    queryMock
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce(undefined) // set_config lookup key
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // project lookup: none
      .mockResolvedValueOnce(undefined); // ROLLBACK

    const app = buildApp();
    const res = await request(app)
      .post("/api/v1/public/projects/pk_unknown/chatbot/sessions")
      .set("Origin", ALLOWED_ORIGIN);

    expect(res.status).toBe(404);
  });

  it("rejects a non-allowlisted origin even with a valid key", async () => {
    queryMock
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce(undefined) // set_config lookup key
      .mockResolvedValueOnce({ rowCount: 1, rows: [projectRow] }) // project lookup
      .mockResolvedValueOnce(undefined); // ROLLBACK

    const app = buildApp();
    const res = await request(app)
      .post("/api/v1/public/projects/pk_valid/chatbot/sessions")
      .set("Origin", "https://evil-site.example");

    expect(res.status).toBe(403);
  });

  it("rejects when the chatbot hasn't been enabled for this project", async () => {
    queryMock
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce(undefined) // set_config lookup key
      .mockResolvedValueOnce({ rowCount: 1, rows: [projectRow] }) // project lookup
      .mockResolvedValueOnce(undefined) // set_config tenant
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // config lookup: none
      .mockResolvedValueOnce(undefined); // ROLLBACK

    const app = buildApp();
    const res = await request(app)
      .post("/api/v1/public/projects/pk_valid/chatbot/sessions")
      .set("Origin", ALLOWED_ORIGIN);

    expect(res.status).toBe(404);
  });

  it("starts a conversation and returns the configured welcome message", async () => {
    queryMock
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce(undefined) // set_config lookup key
      .mockResolvedValueOnce({ rowCount: 1, rows: [projectRow] }) // project lookup
      .mockResolvedValueOnce(undefined) // set_config tenant
      .mockResolvedValueOnce({ rowCount: 1, rows: [enabledConfigRow] }) // config lookup
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: CONVERSATION_1, status: "active", started_at: "2026-01-01" }] }) // insert conversation
      .mockResolvedValueOnce(undefined) // insert bot message (welcome)
      .mockResolvedValueOnce(undefined); // COMMIT

    const app = buildApp();
    const res = await request(app)
      .post("/api/v1/public/projects/pk_valid/chatbot/sessions")
      .set("Origin", ALLOWED_ORIGIN);

    expect(res.status).toBe(201);
    expect(res.body.conversationId).toBe(CONVERSATION_1);
    expect(res.body.message).toBe(enabledConfigRow.welcome_message);
  });
});

describe("POST .../chatbot/sessions/:conversationId/messages -- conversation flow", () => {
  function mockCommonPrefix(conversationRow: Record<string, unknown>) {
    queryMock
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce(undefined) // set_config lookup key
      .mockResolvedValueOnce({ rowCount: 1, rows: [projectRow] }) // project lookup
      .mockResolvedValueOnce(undefined) // set_config tenant
      .mockResolvedValueOnce({ rowCount: 1, rows: [enabledConfigRow] }) // config lookup
      .mockResolvedValueOnce({ rowCount: 1, rows: [conversationRow] }) // conversation lookup
      .mockResolvedValueOnce(undefined); // insert visitor message
  }

  it("answers from an approved knowledge entry when it scores above threshold", async () => {
    mockCommonPrefix(baseConversationRow());
    queryMock
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [
          {
            id: "kb-1",
            question: "What are your support hours?",
            answer: "Mon-Fri, 9am-6pm.",
            tags: ["support", "hours"],
          },
        ],
      }) // knowledge lookup
      .mockResolvedValueOnce(undefined) // insert bot message
      .mockResolvedValueOnce(undefined) // update conversation
      .mockResolvedValueOnce(undefined); // COMMIT

    const app = buildApp();
    const res = await request(app)
      .post(`/api/v1/public/projects/pk_valid/chatbot/sessions/${CONVERSATION_1}/messages`)
      .set("Origin", ALLOWED_ORIGIN)
      .send({ message: "What are your support hours?" });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe("Mon-Fri, 9am-6pm.");
    expect(res.body.matchedKnowledgeSourceId).toBe("kb-1");
    expect(res.body.confidence).toBeGreaterThan(0);
  });

  it("gives the honest fallback message when no knowledge entry matches", async () => {
    mockCommonPrefix(baseConversationRow());
    queryMock
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // knowledge lookup: nothing relevant
      .mockResolvedValueOnce(undefined) // insert bot message
      .mockResolvedValueOnce(undefined) // update conversation
      .mockResolvedValueOnce(undefined); // COMMIT

    const app = buildApp();
    const res = await request(app)
      .post(`/api/v1/public/projects/pk_valid/chatbot/sessions/${CONVERSATION_1}/messages`)
      .set("Origin", ALLOWED_ORIGIN)
      .send({ message: "What's the airspeed velocity of an unladen swallow?" });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe(enabledConfigRow.fallback_message);
    expect(res.body.matchedKnowledgeSourceId).toBeNull();
  });

  it("moves to awaiting_consent once the configured exchange threshold is reached", async () => {
    mockCommonPrefix(baseConversationRow({ visitor_exchange_count: 1 })); // +1 this turn = 2 = threshold
    queryMock
      .mockResolvedValueOnce(undefined) // insert bot message (consent notice)
      .mockResolvedValueOnce(undefined) // update conversation
      .mockResolvedValueOnce(undefined); // COMMIT

    const app = buildApp();
    const res = await request(app)
      .post(`/api/v1/public/projects/pk_valid/chatbot/sessions/${CONVERSATION_1}/messages`)
      .set("Origin", ALLOWED_ORIGIN)
      .send({ message: "just looking around" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("awaiting_consent");
    expect(res.body.message).toBe(enabledConfigRow.consent_notice);
  });

  it("moves straight to awaiting_consent on explicit enquiry intent, even on the first exchange", async () => {
    mockCommonPrefix(baseConversationRow());
    queryMock
      .mockResolvedValueOnce(undefined) // insert bot message
      .mockResolvedValueOnce(undefined) // update conversation
      .mockResolvedValueOnce(undefined); // COMMIT

    const app = buildApp();
    const res = await request(app)
      .post(`/api/v1/public/projects/pk_valid/chatbot/sessions/${CONVERSATION_1}/messages`)
      .set("Origin", ALLOWED_ORIGIN)
      .send({ message: "I'd like to talk to someone about pricing" });

    expect(res.body.status).toBe("awaiting_consent");
  });

  it("accepting consent moves to qualifying and asks the configured question", async () => {
    mockCommonPrefix(baseConversationRow({ status: "awaiting_consent" }));
    queryMock
      .mockResolvedValueOnce(undefined) // insert bot message
      .mockResolvedValueOnce(undefined) // update conversation
      .mockResolvedValueOnce(undefined); // COMMIT

    const app = buildApp();
    const res = await request(app)
      .post(`/api/v1/public/projects/pk_valid/chatbot/sessions/${CONVERSATION_1}/messages`)
      .set("Origin", ALLOWED_ORIGIN)
      .send({ message: "yes" });

    expect(res.body.status).toBe("qualifying");
    expect(res.body.message).toBe("What's your company size?");
  });

  it("declining consent ends the conversation without ever capturing contact info", async () => {
    mockCommonPrefix(baseConversationRow({ status: "awaiting_consent" }));
    queryMock
      .mockResolvedValueOnce(undefined) // insert bot message
      .mockResolvedValueOnce(undefined) // update conversation
      .mockResolvedValueOnce(undefined); // COMMIT

    const app = buildApp();
    const res = await request(app)
      .post(`/api/v1/public/projects/pk_valid/chatbot/sessions/${CONVERSATION_1}/messages`)
      .set("Origin", ALLOWED_ORIGIN)
      .send({ message: "no thanks" });

    expect(res.body.status).toBe("ended");
    expect(queryMock).not.toHaveBeenCalledWith(expect.stringContaining("INSERT INTO consent_records"), expect.anything());
    expect(queryMock).not.toHaveBeenCalledWith(expect.stringContaining("INSERT INTO leads"), expect.anything());
  });

  it("re-asks consent on an ambiguous reply instead of guessing", async () => {
    mockCommonPrefix(baseConversationRow({ status: "awaiting_consent" }));
    queryMock
      .mockResolvedValueOnce(undefined) // insert bot message
      .mockResolvedValueOnce(undefined) // update conversation
      .mockResolvedValueOnce(undefined); // COMMIT

    const app = buildApp();
    const res = await request(app)
      .post(`/api/v1/public/projects/pk_valid/chatbot/sessions/${CONVERSATION_1}/messages`)
      .set("Origin", ALLOWED_ORIGIN)
      .send({ message: "maybe later" });

    expect(res.body.status).toBe("awaiting_consent");
    expect(res.body.message).toContain(enabledConfigRow.consent_notice);
  });

  it("finishing the configured qualifying questions moves to awaiting_contact", async () => {
    mockCommonPrefix(baseConversationRow({ status: "qualifying", qualifying_question_index: 0 }));
    queryMock
      .mockResolvedValueOnce(undefined) // insert bot message
      .mockResolvedValueOnce(undefined) // update conversation
      .mockResolvedValueOnce(undefined); // COMMIT

    const app = buildApp();
    const res = await request(app)
      .post(`/api/v1/public/projects/pk_valid/chatbot/sessions/${CONVERSATION_1}/messages`)
      .set("Origin", ALLOWED_ORIGIN)
      .send({ message: "about 50 employees" });

    expect(res.body.status).toBe("awaiting_contact");
  });

  it("capturing contact info writes a consent record AND a lead through the existing ingestion path", async () => {
    mockCommonPrefix(
      baseConversationRow({ status: "awaiting_contact", qualifying_answers: ["about 50 employees"] }),
    );
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: "consent-1" }] }) // insert consent_records
      .mockResolvedValueOnce({ rows: [{ id: "lead-1", created_at: "2026-01-01T00:00:00.000Z" }] }) // insert leads
      .mockResolvedValueOnce(undefined) // insert audit_events
      .mockResolvedValueOnce(undefined) // insert usage_events
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // notifyTenantOwnersAndAdmins: none
      .mockResolvedValueOnce(undefined) // insert bot message
      .mockResolvedValueOnce(undefined) // update conversation
      .mockResolvedValueOnce(undefined); // COMMIT

    const app = buildApp();
    const res = await request(app)
      .post(`/api/v1/public/projects/pk_valid/chatbot/sessions/${CONVERSATION_1}/messages`)
      .set("Origin", ALLOWED_ORIGIN)
      .send({ message: "I'm Jane Doe, jane.doe@example.com" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("captured");

    const consentCall = queryMock.mock.calls.find(([sql]) => typeof sql === "string" && sql.includes("INSERT INTO consent_records"));
    expect(consentCall).toBeDefined();
    expect(consentCall![1]).toEqual(expect.arrayContaining([TENANT_1, "jane.doe@example.com"]));

    const leadCall = queryMock.mock.calls.find(([sql]) => typeof sql === "string" && sql.includes("INSERT INTO leads"));
    expect(leadCall).toBeDefined();
    expect(leadCall![1]).toEqual(expect.arrayContaining(["Jane Doe", "jane.doe@example.com", "about 50 employees"]));
  });

  it("asks again when awaiting_contact reply has neither a name nor an email", async () => {
    mockCommonPrefix(baseConversationRow({ status: "awaiting_contact" }));
    queryMock
      .mockResolvedValueOnce(undefined) // insert bot message
      .mockResolvedValueOnce(undefined) // update conversation
      .mockResolvedValueOnce(undefined); // COMMIT

    const app = buildApp();
    const res = await request(app)
      .post(`/api/v1/public/projects/pk_valid/chatbot/sessions/${CONVERSATION_1}/messages`)
      .set("Origin", ALLOWED_ORIGIN)
      .send({ message: "-" }); // strips to an empty name, no email -> neither extracted

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("awaiting_contact");
  });

  it("responds with a closing message on a conversation that already captured a lead", async () => {
    mockCommonPrefix(baseConversationRow({ status: "captured" }));
    queryMock
      .mockResolvedValueOnce(undefined) // insert bot message
      .mockResolvedValueOnce(undefined) // update last_message_at
      .mockResolvedValueOnce(undefined); // COMMIT

    const app = buildApp();
    const res = await request(app)
      .post(`/api/v1/public/projects/pk_valid/chatbot/sessions/${CONVERSATION_1}/messages`)
      .set("Origin", ALLOWED_ORIGIN)
      .send({ message: "hello again" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("captured");
  });
});
