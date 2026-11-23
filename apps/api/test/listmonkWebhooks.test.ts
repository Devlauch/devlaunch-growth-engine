import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateKeyPairSync, createSign } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";

const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({ query: queryMock, release: releaseMock }));

vi.mock("../src/db/pool.js", () => ({
  pool: { connect: connectMock },
}));

// Must be set BEFORE the dynamic imports below — see the identical note in
// listmonkIntegration.test.ts.
process.env.INTEGRATION_CREDENTIALS_KEY = Buffer.alloc(32, 3).toString("base64");
// This file's per-IP rate limiter (env.publicLeadsRateLimitPerIpPerMin,
// shared module-scope state for the whole process) defaults to 10/min —
// fine for real traffic, but this suite legitimately sends more than 10
// webhook POSTs from the same supertest client "IP" in well under a
// minute (SES signature verification alone needs several accept/reject
// cases). Raised here so this file tests real signature verification
// behavior, not an incidental collision with the rate limiter (which has
// its own dedicated coverage elsewhere).
process.env.PUBLIC_LEADS_RATE_LIMIT_PER_IP_PER_MIN = "1000";

const { listmonkWebhooksRouter } = await import("../src/routes/listmonkWebhooks.js");
const { errorHandler } = await import("../src/middleware/errorHandler.js");
const { encryptCredential } = await import("../src/lib/credentialEncryption.js");

function buildApp() {
  const app = express();
  // Mirrors app.ts's express.json() verify callback exactly — req.rawBody
  // is what the real signature verification depends on.
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );
  app.use("/api/v1/public", listmonkWebhooksRouter);
  app.use(errorHandler);
  return app;
}

const TENANT_1 = "11111111-1111-1111-1111-111111111111";
const PROJECT_1 = "33333333-3333-3333-3333-333333333333";
const INTEGRATION_1 = "22222222-2222-2222-2222-222222222222";

function queueResponses(responses: unknown[]) {
  for (const r of responses) queryMock.mockResolvedValueOnce(r);
}

function integrationRow() {
  return { rowCount: 1, rows: [{ id: INTEGRATION_1, tenant_id: TENANT_1, project_id: PROJECT_1 }] };
}

/** config/encrypted_credential_ref/status row returned by getIntegrationCredential's own query. */
function credentialRow(secret: string) {
  return {
    rowCount: 1,
    rows: [{ config: { baseUrl: "http://listmonk.local", apiUser: "u" }, encrypted_credential_ref: encryptCredential(secret), status: "connected" }],
  };
}

beforeEach(() => {
  queryMock.mockReset();
  releaseMock.mockReset();
  connectMock.mockClear();
});

const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const sendgridPublicKeyB64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");

function signSendgrid(timestamp: string, rawBody: string): string {
  const signer = createSign("sha256");
  signer.update(Buffer.concat([Buffer.from(timestamp, "utf8"), Buffer.from(rawBody, "utf8")]));
  signer.end();
  return signer.sign(privateKey).toString("base64");
}

describe("POST /webhooks/listmonk/:integrationId/sendgrid", () => {
  it("rejects when no sendgridPublicKey is configured for this integration", async () => {
    queueResponses([
      undefined, // BEGIN
      undefined, // set_config lookup_integration_id
      integrationRow(),
      undefined, // set_config current_tenant_id
      credentialRow("plain-api-key"), // getIntegrationCredential — no webhookVerification
      undefined, // ROLLBACK
    ]);

    const app = buildApp();
    const res = await request(app).post(`/api/v1/public/webhooks/listmonk/${INTEGRATION_1}/sendgrid`).send([{ email: "a@b.com", event: "bounce" }]);

    expect(res.status).toBe(503);
  });

  it("accepts a correctly-signed event and writes a real suppression_list row", async () => {
    const secret = JSON.stringify({ apiKey: "k", webhookVerification: { sendgridPublicKey: sendgridPublicKeyB64 } });
    queueResponses([
      undefined,
      undefined,
      integrationRow(),
      undefined,
      credentialRow(secret),
      { rowCount: 1, rows: [{ id: "event-1" }] }, // insert integration_webhook_events
      { rows: [] }, // insert suppression_list
      { rows: [] }, // update integration_webhook_events -> processed
      undefined, // COMMIT
    ]);

    const payload = [{ email: "bounced@example.com", event: "bounce", sg_event_id: "sg-evt-1" }];
    const rawBody = JSON.stringify(payload);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = signSendgrid(timestamp, rawBody);

    const app = buildApp();
    const res = await request(app)
      .post(`/api/v1/public/webhooks/listmonk/${INTEGRATION_1}/sendgrid`)
      .set("X-Twilio-Email-Event-Webhook-Signature", signature)
      .set("X-Twilio-Email-Event-Webhook-Timestamp", timestamp)
      .set("Content-Type", "application/json")
      .send(rawBody);

    expect(res.status).toBe(200);
    expect(res.body.events[0].suppressed).toBe(1);
    const suppressionInsertCall = queryMock.mock.calls.find((c) => typeof c[0] === "string" && c[0].includes("INSERT INTO suppression_list"));
    expect(suppressionInsertCall).toBeTruthy();
    expect(suppressionInsertCall![1]).toEqual(
      expect.arrayContaining([TENANT_1, "bounced@example.com", "bounced"]),
    );
  });

  it("rejects a tampered signature with 401", async () => {
    const secret = JSON.stringify({ apiKey: "k", webhookVerification: { sendgridPublicKey: sendgridPublicKeyB64 } });
    queueResponses([
      undefined,
      undefined,
      integrationRow(),
      undefined,
      credentialRow(secret),
      undefined, // ROLLBACK
    ]);

    const payload = [{ email: "x@example.com", event: "bounce", sg_event_id: "sg-evt-2" }];
    const app = buildApp();
    const res = await request(app)
      .post(`/api/v1/public/webhooks/listmonk/${INTEGRATION_1}/sendgrid`)
      .set("X-Twilio-Email-Event-Webhook-Signature", "not-a-real-signature")
      .set("X-Twilio-Email-Event-Webhook-Timestamp", "123")
      .send(payload);

    expect(res.status).toBe(401);
  });
});

describe("POST /webhooks/listmonk/:integrationId/postmark", () => {
  it("requires Basic Auth to be configured — refuses to accept an unverifiable event", async () => {
    queueResponses([undefined, undefined, integrationRow(), undefined, credentialRow("plain-api-key"), undefined]);

    const app = buildApp();
    const res = await request(app).post(`/api/v1/public/webhooks/listmonk/${INTEGRATION_1}/postmark`).send({ RecordType: "Bounce", Type: "HardBounce", Email: "a@b.com" });

    expect(res.status).toBe(503);
  });

  it("accepts a valid Basic Auth request and suppresses a hard bounce", async () => {
    const secret = JSON.stringify({ apiKey: "k", webhookVerification: { postmarkBasicAuthUser: "hook-user", postmarkBasicAuthPass: "hook-pass" } });
    queueResponses([
      undefined,
      undefined,
      integrationRow(),
      undefined,
      credentialRow(secret),
      { rowCount: 1, rows: [{ id: "event-2" }] },
      { rows: [] },
      { rows: [] },
      undefined,
    ]);

    const basic = Buffer.from("hook-user:hook-pass").toString("base64");
    const app = buildApp();
    const res = await request(app)
      .post(`/api/v1/public/webhooks/listmonk/${INTEGRATION_1}/postmark`)
      .set("Authorization", `Basic ${basic}`)
      .send({ RecordType: "Bounce", Type: "HardBounce", Email: "bounced@example.com", MessageID: "msg-1" });

    expect(res.status).toBe(200);
    expect(res.body.events[0].suppressed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// SES (via SNS) — REAL signature verification tests (Milestone 3, Phase 1:
// this used to be a documented, unresolved gap — these tests prove the real
// accept AND reject paths against a genuine RSA keypair + a genuine
// self-signed X.509 certificate, not a mocked-away shortcut. `openssl` (used
// below to generate the test certificate — node:crypto itself can parse but
// not mint an X.509 certificate) must be on PATH; this is the same
// requirement any CI image running this suite already needs for other
// tooling, and is confirmed present in this project's dev/CI environment.
// ---------------------------------------------------------------------------
const SNS_CERT_DIR = mkdtempSync(join(tmpdir(), "listmonk-ses-test-"));
const SNS_KEY_PATH = join(SNS_CERT_DIR, "key.pem");
const SNS_CERT_PATH = join(SNS_CERT_DIR, "cert.pem");
execFileSync("openssl", [
  "req",
  "-x509",
  "-newkey",
  "rsa:2048",
  "-keyout",
  SNS_KEY_PATH,
  "-out",
  SNS_CERT_PATH,
  "-days",
  "1",
  "-nodes",
  "-subj",
  "/CN=sns-test.amazonaws.com",
]);
const snsPrivateKeyPem = readFileSync(SNS_KEY_PATH, "utf8");
const snsCertPem = readFileSync(SNS_CERT_PATH, "utf8");

// A second, unrelated keypair/cert — used to prove a signature made with a
// DIFFERENT key (i.e. not AWS's) is correctly rejected, not just "any
// well-formed signature".
const SNS_CERT_DIR_2 = mkdtempSync(join(tmpdir(), "listmonk-ses-test-2-"));
const SNS_KEY_PATH_2 = join(SNS_CERT_DIR_2, "key.pem");
execFileSync("openssl", ["genrsa", "-out", SNS_KEY_PATH_2, "2048"]);
const snsOtherPrivateKeyPem = readFileSync(SNS_KEY_PATH_2, "utf8");

/** Mirrors buildSnsStringToSign() in src/routes/listmonkWebhooks.ts exactly (AWS's documented field order). */
function buildSnsStringToSignForTest(message: Record<string, unknown>): string {
  const fields =
    message.Type === "Notification"
      ? "Subject" in message
        ? ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"]
        : ["Message", "MessageId", "Timestamp", "TopicArn", "Type"]
      : ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"];
  let out = "";
  for (const f of fields) out += `${f}\n${String(message[f])}\n`;
  return out;
}

function signSnsMessage(message: Record<string, unknown>, privateKeyPem: string): string {
  const signer = createSign("RSA-SHA256");
  signer.update(buildSnsStringToSignForTest(message), "utf8");
  signer.end();
  return signer.sign(privateKeyPem).toString("base64");
}

// The production route caches a fetched signing certificate by URL (real,
// deliberate behavior — see fetchSnsSigningCert's 1-hour TTL cache in
// src/routes/listmonkWebhooks.ts, there to avoid hammering AWS on every
// bounce). That means reusing the exact same SigningCertURL across tests
// would let a later test's signature verify successfully off an EARLIER
// test's cached fetch, without this test's own mocked fetch ever being
// called — a test-coupling hazard, not a production bug. Each test below
// that cares whether fetch was (or wasn't) actually called uses its own
// fresh, never-before-seen cert URL for a guaranteed cache miss.
let certUrlCounter = 0;
function freshCertUrl(): string {
  certUrlCounter += 1;
  return `https://sns.us-east-1.amazonaws.com/SimpleNotificationService-test${certUrlCounter}.pem`;
}

function makeSignedSnsNotification(overrides: Record<string, unknown> = {}, privateKeyPem = snsPrivateKeyPem) {
  const base: Record<string, unknown> = {
    Type: "Notification",
    MessageId: `msg-${Math.random().toString(36).slice(2)}`,
    TopicArn: "arn:aws:sns:us-east-1:123456789012:test-topic",
    Message: JSON.stringify({ notificationType: "Bounce", bounce: { bouncedRecipients: [{ emailAddress: "ses-bounced@example.com" }] } }),
    Timestamp: new Date().toISOString(),
    SignatureVersion: "2",
    SigningCertURL: freshCertUrl(),
    ...overrides,
  };
  return { ...base, Signature: signSnsMessage(base, privateKeyPem) };
}

describe("POST /webhooks/listmonk/:integrationId/ses", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async (url: string) => {
      if (typeof url === "string" && url.startsWith("https://sns.us-east-1.amazonaws.com/SimpleNotificationService-")) {
        return { ok: true, text: async () => snsCertPem } as Response;
      }
      return { ok: false } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  it("accepts a genuinely signed Notification (real RSA-SHA256 over AWS's canonical string) and writes a real suppression_list row", async () => {
    queueResponses([
      undefined,
      undefined,
      integrationRow(),
      undefined,
      credentialRow("plain-api-key"),
      { rowCount: 1, rows: [{ id: "event-ses-1" }] },
      { rows: [] }, // insert suppression_list
      { rows: [] }, // update processed
      undefined, // COMMIT
    ]);

    const app = buildApp();
    const res = await request(app).post(`/api/v1/public/webhooks/listmonk/${INTEGRATION_1}/ses`).send(makeSignedSnsNotification());

    expect(res.status).toBe(200);
    expect(res.body.events[0].suppressed).toBe(1);
    const suppressionInsertCall = queryMock.mock.calls.find((c) => typeof c[0] === "string" && c[0].includes("INSERT INTO suppression_list"));
    expect(suppressionInsertCall![1]).toEqual(expect.arrayContaining([TENANT_1, "ses-bounced@example.com", "bounced"]));
  });

  it("accepts a genuinely signed SubscriptionConfirmation (verified, but still NOT auto-fetching SubscribeURL)", async () => {
    queueResponses([
      undefined,
      undefined,
      integrationRow(),
      undefined,
      credentialRow("plain-api-key"),
      { rowCount: 1, rows: [{ id: "event-ses-2" }] },
      { rows: [] }, // mark ignored
      undefined,
    ]);

    const subscribeUrl = "https://sns.amazonaws.com/subscribe?x=1";
    const signed = makeSignedSnsNotification({ Type: "SubscriptionConfirmation", SubscribeURL: subscribeUrl, Token: "tok-1" });
    const app = buildApp();
    const res = await request(app).post(`/api/v1/public/webhooks/listmonk/${INTEGRATION_1}/ses`).send(signed);

    expect(res.status).toBe(200);
    expect(res.body.events[0].suppressed).toBe(0);
    // The real cert fetch (a guaranteed cache-miss — this test's cert URL
    // is freshly generated) genuinely happened, but the route must never
    // itself fetch SubscribeURL, signature valid or not.
    const fetchedUrls = fetchMock.mock.calls.map((c) => c[0]);
    expect(fetchedUrls).toEqual([signed.SigningCertURL]);
    expect(fetchedUrls).not.toContain(subscribeUrl);
  });

  it("deduplicates a retried, genuinely-signed notification via the integration_webhook_events unique constraint", async () => {
    const signed = makeSignedSnsNotification({ MessageId: "sns-dup-1" });
    queueResponses([undefined, undefined, integrationRow(), undefined, credentialRow("plain-api-key"), { rowCount: 0, rows: [] }, undefined]);

    const app = buildApp();
    const res = await request(app).post(`/api/v1/public/webhooks/listmonk/${INTEGRATION_1}/ses`).send(signed);

    expect(res.status).toBe(200);
    expect(res.body.events[0].deduplicated).toBe(true);
  });

  it("rejects a message with no Signature/SigningCertURL at all — the previously-unresolved gap, now closed", async () => {
    queueResponses([undefined, undefined, integrationRow(), undefined, credentialRow("plain-api-key"), undefined]);

    const app = buildApp();
    const res = await request(app)
      .post(`/api/v1/public/webhooks/listmonk/${INTEGRATION_1}/ses`)
      .send({ Type: "SubscriptionConfirmation", MessageId: "sns-unsigned", SubscribeURL: "https://sns.amazonaws.com/subscribe?x=1" });

    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled(); // never even tries to verify without a cert URL
  });

  it("rejects a SigningCertURL that isn't a real AWS SNS host — SSRF guard, never fetched", async () => {
    queueResponses([undefined, undefined, integrationRow(), undefined, credentialRow("plain-api-key"), undefined]);

    const forged = makeSignedSnsNotification({ SigningCertURL: "https://evil.example.com/cert.pem" });
    const app = buildApp();
    const res = await request(app).post(`/api/v1/public/webhooks/listmonk/${INTEGRATION_1}/ses`).send(forged);

    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled(); // the attacker-controlled URL must never be fetched
  });

  it("rejects a message signed with a key that isn't AWS's (wrong keypair) even though SigningCertURL/Signature are both present", async () => {
    queueResponses([undefined, undefined, integrationRow(), undefined, credentialRow("plain-api-key"), undefined]);

    const forged = makeSignedSnsNotification({}, snsOtherPrivateKeyPem);
    const app = buildApp();
    const res = await request(app).post(`/api/v1/public/webhooks/listmonk/${INTEGRATION_1}/ses`).send(forged);

    expect(res.status).toBe(401);
  });

  it("rejects a tampered Message body even though Signature/SigningCertURL look otherwise legitimate", async () => {
    queueResponses([undefined, undefined, integrationRow(), undefined, credentialRow("plain-api-key"), undefined]);

    const signed = makeSignedSnsNotification();
    signed.Message = JSON.stringify({ notificationType: "Bounce", bounce: { bouncedRecipients: [{ emailAddress: "attacker-injected@example.com" }] } });

    const app = buildApp();
    const res = await request(app).post(`/api/v1/public/webhooks/listmonk/${INTEGRATION_1}/ses`).send(signed);

    expect(res.status).toBe(401);
  });

  it("rejects when the real cert fetch fails (unreachable/down) rather than falling back to accepting unverified", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false }) as Response),
    );
    queueResponses([undefined, undefined, integrationRow(), undefined, credentialRow("plain-api-key"), undefined]);

    const app = buildApp();
    const res = await request(app).post(`/api/v1/public/webhooks/listmonk/${INTEGRATION_1}/ses`).send(makeSignedSnsNotification());

    expect(res.status).toBe(401);
  });
});

describe("unknown integration id", () => {
  it("returns 404 rather than guessing a tenant", async () => {
    queueResponses([undefined, undefined, { rowCount: 0, rows: [] }, undefined]);

    const app = buildApp();
    const res = await request(app).post(`/api/v1/public/webhooks/listmonk/${INTEGRATION_1}/sendgrid`).send([]);

    expect(res.status).toBe(404);
  });
});
