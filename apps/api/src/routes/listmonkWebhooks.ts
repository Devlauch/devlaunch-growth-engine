import { createHash, createPublicKey, createVerify, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { Errors } from "../lib/httpError.js";
import { logger } from "../lib/logger.js";
import { rateLimitMiddleware } from "../middleware/rateLimit.js";
import { env } from "../config/env.js";
import { getIntegrationCredential } from "../lib/integrationCredentials.js";
import { parseListmonkCredential } from "../lib/listmonkClient.js";

/**
 * Public, unauthenticated-by-necessity inbound receiver for ESP
 * bounce/complaint notifications, mirroring listmonk's own
 * `POST /webhooks/service/:service` convention (confirmed directly in the
 * read-only reference clone at ~/project/Growth/listmonk,
 * cmd/handlers.go:285 `g.POST("/webhooks/service/:service", a.BounceWebhook)`
 * and cmd/bounce.go's `BounceWebhook` handler, which dispatches on
 * `service` to SES/SendGrid/Postmark/Azure/ForwardEmail/Lettermint
 * processors).
 *
 * Mounted at /api/v1/public (see app.ts wiring snippet in the handback) as
 * /webhooks/listmonk/:integrationId/:service. Each tenant's own ESP
 * (SES/SendGrid/Postmark) is configured, independently of listmonk's own
 * bounce intake, to ALSO deliver its bounce/complaint notifications to
 * this platform endpoint — this is what lets a tenant's bounce/complaint
 * end up in platform's own RLS-isolated `suppression_list`
 * (apps/api/src/lib/suppression.ts), since listmonk's own bounce table has
 * no tenant concept and platform does not query it. The URL embeds
 * :integrationId (a random uuid, not a guessable sequential id) rather
 * than a shared secret, mirroring the per-project public_api_key pattern
 * used by publicLeads.ts/publicChatbot.ts — see
 * packages/db/migrations/293_add_public_lookup_rls_integrations.sql for
 * the narrowly-scoped RLS lookup policy this depends on.
 *
 * --- Signature verification status, per ESP (verified against the real
 * reference clone, not guessed — docs/OPEN_SOURCE_INTEGRATION_AUDIT.md
 * flagged this exact gap and asked it be checked) ---
 *
 *   - SendGrid: REAL verification implemented below. SendGrid's Event
 *     Webhook signs every delivery with ECDSA (P-256) over
 *     `${timestamp}${raw body}`, in
 *     `X-Twilio-Email-Event-Webhook-Signature` (base64 DER signature) +
 *     `X-Twilio-Email-Event-Webhook-Timestamp`, verified against a public
 *     key the tenant pastes in at connect time (see listmonkIntegration.ts's
 *     connect endpoint, `sendgridPublicKey`) and stored in the same
 *     encrypted credential envelope as the API key. A request with no
 *     configured key, a missing header, or a signature mismatch is
 *     rejected with 401 — never silently accepted.
 *
 *   - Amazon SES (via SNS): REAL verification implemented below, closing
 *     the gap this file previously documented as unresolved (Milestone 3,
 *     Phase 1 — see docs/INTEGRATION_STATUS.md's "Listmonk real-world
 *     verification" subsection). AWS's documented scheme
 *     (https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html):
 *     every SNS delivery (`Notification`, `SubscriptionConfirmation`,
 *     `UnsubscribeConfirmation`) includes a base64 `Signature`, a
 *     `SigningCertURL` pointing at the real X.509 certificate AWS signed
 *     it with, and a `SignatureVersion` ("1" = RSA-SHA1, "2" = RSA-SHA256).
 *     `verifySesSignature()` below (a) validates `SigningCertURL` is
 *     actually an `https://sns.<region>.amazonaws.com/...pem` URL —
 *     REQUIRED before ever fetching it, since fetching an
 *     attacker-controlled URL server-side is a real SSRF vector — (b)
 *     fetches (and short-TTL caches) that certificate, (c) rebuilds AWS's
 *     documented canonical "string to sign" (the exact ordered field list
 *     differs for `Notification` vs. `*Confirmation` messages — see AWS's
 *     docs linked above), and (d) verifies the signature against the
 *     certificate's public key with `node:crypto`. A message with a
 *     missing/non-AWS `SigningCertURL`, an unreachable certificate, or a
 *     signature that doesn't verify is rejected 401 — never silently
 *     accepted. This closes the gap for ALL SES message types, including
 *     `SubscriptionConfirmation`/`UnsubscribeConfirmation` (previously
 *     accepted/logged with NO verification at all) — this route still
 *     deliberately does NOT auto-fetch `SubscribeURL` even once the
 *     envelope's signature is confirmed genuine (a human must still
 *     confirm the SNS subscription itself; signature verification only
 *     proves the message really came from AWS SNS, it doesn't imply
 *     platform should auto-subscribe).
 *
 *   - Postmark: Postmark's bounce webhook has NO cryptographic signature
 *     scheme at all (confirmed against both the reference clone —
 *     cmd/bounce.go's Postmark branch calls
 *     `a.bounce.Postmark.ProcessBounce(rawReq, c)` with no signature
 *     header read anywhere — AND Postmark's own current (2026) webhook
 *     docs, re-checked for this round: "Postmark does not currently
 *     support HMAC webhook signature verification" and "The recommended
 *     approach to protect your webhook endpoint is HTTP Basic
 *     Authentication" — nothing better has shipped since the original
 *     audit). This route REQUIRES `postmarkBasicAuthUser`/
 *     `postmarkBasicAuthPass` to be configured on the integration (set at
 *     connect time) and rejects with 503 if they are not, rather than
 *     accepting an unverifiable request. This is still the best available
 *     verification for this specific path, explicitly flagged as weaker
 *     than SendGrid/SES's cryptographic schemes — Postmark's own docs
 *     recommend pairing Basic Auth with their published source-IP list for
 *     defense-in-depth, which is a deployment-level firewall rule, not
 *     something this application-layer route can itself enforce.
 */
export const listmonkWebhooksRouter = Router();

const paramsSchema = z.object({
  integrationId: z.string().uuid(),
  service: z.enum(["sendgrid", "ses", "postmark"]),
});

const perIpLimiter = rateLimitMiddleware({
  windowMs: 60_000,
  max: env.publicLeadsRateLimitPerIpPerMin,
  name: "listmonk-webhook-ip",
  keyFn: (req) => req.ip ?? "unknown",
});
const perIntegrationLimiter = rateLimitMiddleware({
  windowMs: 60_000,
  // ESP bounce volume can legitimately spike (a bad send blasts many
  // bounces at once) — a materially higher ceiling than the public
  // lead-capture widget's per-key limiter, which guards a very different
  // (low, human-driven) traffic shape.
  max: 600,
  name: "listmonk-webhook-integration",
  keyFn: (req) => req.params.integrationId,
});

interface ParsedSuppressionEvent {
  email: string;
  reason: "bounced" | "complained" | "unsubscribed";
}

interface ParsedWebhook {
  externalEventId: string;
  eventType: string;
  suppressions: ParsedSuppressionEvent[];
  /** true means "acknowledge only, nothing to record" (e.g. an SNS subscription confirmation). */
  acknowledgeOnly?: boolean;
}

// ---------------------------------------------------------------------------
// SendGrid — real ECDSA verification
// ---------------------------------------------------------------------------

function verifySendgridSignature(rawBody: Buffer, signatureB64: string, timestamp: string, publicKeyDerB64: string): boolean {
  try {
    const publicKey = createPublicKey({
      key: Buffer.from(publicKeyDerB64, "base64"),
      format: "der",
      type: "spki",
    });
    const verifier = createVerify("sha256");
    verifier.update(Buffer.concat([Buffer.from(timestamp, "utf8"), rawBody]));
    verifier.end();
    return verifier.verify(publicKey, Buffer.from(signatureB64, "base64"));
  } catch (err) {
    logger.warn({ err }, "sendgrid webhook signature verification threw");
    return false;
  }
}

interface SendgridEvent {
  sg_event_id?: string;
  email?: string;
  event?: string;
}

function parseSendgrid(body: unknown): ParsedWebhook[] {
  const events = Array.isArray(body) ? (body as SendgridEvent[]) : [];
  return events
    .filter((e) => e.email && e.event)
    .map((e) => {
      const reason = e.event === "bounce" || e.event === "dropped" ? "bounced" : e.event === "spamreport" ? "complained" : e.event === "unsubscribe" ? "unsubscribed" : null;
      return {
        externalEventId: e.sg_event_id ?? createHash("sha256").update(JSON.stringify(e)).digest("hex"),
        eventType: e.event ?? "unknown",
        suppressions: reason ? [{ email: e.email as string, reason }] : [],
      };
    });
}

// ---------------------------------------------------------------------------
// Amazon SES (via SNS) — real signature verification (closes the previously
// documented gap — see the module doc comment above for the full writeup).
// ---------------------------------------------------------------------------

/**
 * AWS SNS's own `SigningCertURL` is always `https://sns.<region>.amazonaws.com/...pem`
 * (https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html).
 * Validating this BEFORE fetching the URL is required — without it, a
 * forged `SigningCertURL` pointing anywhere else would make this route
 * fetch an attacker-controlled URL server-side (SSRF), or let an attacker
 * supply their OWN certificate/keypair and sign their own forged payload
 * with it, defeating the entire point of verification.
 */
function isValidSnsCertUrl(raw: unknown): raw is string {
  if (typeof raw !== "string") return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (!/^sns\.[a-z0-9-]+\.amazonaws\.com$/.test(url.hostname)) return false;
  if (!/^\/SimpleNotificationService-[A-Za-z0-9]+\.pem$/.test(url.pathname)) return false;
  return true;
}

interface SnsCertCacheEntry {
  pem: string;
  fetchedAt: number;
}
const snsCertCache = new Map<string, SnsCertCacheEntry>();
const SNS_CERT_CACHE_TTL_MS = 60 * 60 * 1000;

async function fetchSnsSigningCert(url: string): Promise<string | null> {
  const cached = snsCertCache.get(url);
  if (cached && Date.now() - cached.fetchedAt < SNS_CERT_CACHE_TTL_MS) return cached.pem;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return null;
    const pem = await res.text();
    if (!pem.includes("BEGIN CERTIFICATE")) return null;
    snsCertCache.set(url, { pem, fetchedAt: Date.now() });
    return pem;
  } catch (err) {
    logger.warn({ err, url }, "listmonk webhook (ses): failed to fetch SNS signing certificate");
    return null;
  }
}

/**
 * AWS's documented canonical "string to sign" — an ordered, newline-joined
 * list of `Name\nValue\n` pairs. The field set and order is FIXED and
 * DIFFERENT per message Type; this is not something flexible/inferred from
 * the payload. `Subject` is included for `Notification` only when present
 * (a `Notification` with no `Subject` omits that line entirely — adding an
 * empty line would break verification against AWS's own signature).
 */
function buildSnsStringToSign(message: Record<string, unknown>): string | null {
  const type = message.Type;
  let fields: string[];
  if (type === "Notification") {
    fields = "Subject" in message ? ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"] : ["Message", "MessageId", "Timestamp", "TopicArn", "Type"];
  } else if (type === "SubscriptionConfirmation" || type === "UnsubscribeConfirmation") {
    fields = ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"];
  } else {
    return null;
  }

  let out = "";
  for (const field of fields) {
    const value = message[field];
    if (value === undefined || value === null) return null; // a required field is missing — can't build a valid string, can't verify
    out += `${field}\n${String(value)}\n`;
  }
  return out;
}

/**
 * Real verification: validates SigningCertURL is genuinely an AWS SNS cert
 * URL, fetches (and caches) that certificate, rebuilds AWS's canonical
 * string, and verifies `Signature` against the certificate's public key.
 * Returns false (never throws) for any malformed/unverifiable/forged
 * message — the caller always treats false as "reject 401".
 */
async function verifySesSnsSignature(message: Record<string, unknown>): Promise<boolean> {
  const certUrl = message.SigningCertURL;
  if (!isValidSnsCertUrl(certUrl)) return false;
  const signatureB64 = message.Signature;
  if (typeof signatureB64 !== "string" || signatureB64.length === 0) return false;

  const stringToSign = buildSnsStringToSign(message);
  if (!stringToSign) return false;

  const certPem = await fetchSnsSigningCert(certUrl);
  if (!certPem) return false;

  // SignatureVersion "2" = SHA256withRSA (current default for new SNS
  // topics); "1" = SHA1withRSA (older topics, still real AWS-issued
  // signatures — SHA1 here is AWS's own documented legacy scheme, not a
  // weakening introduced by this code). Anything else is unrecognized and
  // rejected rather than guessed at.
  const sigVersion = message.SignatureVersion;
  const algorithm = sigVersion === "2" ? "RSA-SHA256" : sigVersion === "1" ? "RSA-SHA1" : null;
  if (!algorithm) return false;

  try {
    // node:crypto's createPublicKey accepts a PEM-encoded X.509 certificate
    // directly (Node >= 15.6) and extracts its SPKI public key — no
    // separate X.509-parsing dependency needed.
    const publicKey = createPublicKey({ key: certPem, format: "pem" });
    const verifier = createVerify(algorithm);
    verifier.update(stringToSign, "utf8");
    verifier.end();
    return verifier.verify(publicKey, Buffer.from(signatureB64, "base64"));
  } catch (err) {
    logger.warn({ err }, "listmonk webhook (ses): signature verification threw");
    return false;
  }
}

function parseSes(body: unknown): ParsedWebhook | null {
  if (!body || typeof body !== "object") return null;
  const obj = body as Record<string, unknown>;
  const type = obj.Type;
  const messageId = typeof obj.MessageId === "string" ? obj.MessageId : createHash("sha256").update(JSON.stringify(obj)).digest("hex");

  if (type === "SubscriptionConfirmation" || type === "UnsubscribeConfirmation") {
    logger.warn(
      { messageId, type },
      "listmonk webhook (ses): received an SNS subscription/unsubscribe confirmation — NOT auto-confirmed (would require fetching SubscribeURL, a deliberate SSRF/trust decision this route does not make automatically). Confirm manually via the AWS SNS console if this subscription is expected.",
    );
    return { externalEventId: messageId, eventType: String(type), suppressions: [], acknowledgeOnly: true };
  }

  if (type !== "Notification") return null;

  let message: Record<string, unknown>;
  try {
    message = typeof obj.Message === "string" ? JSON.parse(obj.Message) : {};
  } catch {
    return { externalEventId: messageId, eventType: "unparseable", suppressions: [] };
  }

  const notificationType = message.notificationType as string | undefined;
  const suppressions: ParsedSuppressionEvent[] = [];

  if (notificationType === "Bounce") {
    const bounce = message.bounce as Record<string, unknown> | undefined;
    const recipients = (bounce?.bouncedRecipients as Array<{ emailAddress?: string }> | undefined) ?? [];
    for (const r of recipients) if (r.emailAddress) suppressions.push({ email: r.emailAddress, reason: "bounced" });
  } else if (notificationType === "Complaint") {
    const complaint = message.complaint as Record<string, unknown> | undefined;
    const recipients = (complaint?.complainedRecipients as Array<{ emailAddress?: string }> | undefined) ?? [];
    for (const r of recipients) if (r.emailAddress) suppressions.push({ email: r.emailAddress, reason: "complained" });
  }

  return { externalEventId: messageId, eventType: notificationType ?? "unknown", suppressions };
}

// ---------------------------------------------------------------------------
// Postmark — Basic Auth is the only available verification (no HMAC scheme)
// ---------------------------------------------------------------------------

function verifyPostmarkBasicAuth(req: import("express").Request, user: string, pass: string): boolean {
  const header = req.header("authorization");
  if (!header || !header.startsWith("Basic ")) return false;
  let decoded: string;
  try {
    decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  } catch {
    return false;
  }
  const sepIndex = decoded.indexOf(":");
  if (sepIndex < 0) return false;
  const providedUser = decoded.slice(0, sepIndex);
  const providedPass = decoded.slice(sepIndex + 1);

  const userBuf = Buffer.from(providedUser, "utf8");
  const expectedUserBuf = Buffer.from(user, "utf8");
  const passBuf = Buffer.from(providedPass, "utf8");
  const expectedPassBuf = Buffer.from(pass, "utf8");

  const userOk = userBuf.length === expectedUserBuf.length && timingSafeEqual(userBuf, expectedUserBuf);
  const passOk = passBuf.length === expectedPassBuf.length && timingSafeEqual(passBuf, expectedPassBuf);
  return userOk && passOk;
}

function parsePostmark(body: unknown): ParsedWebhook {
  const obj = (body ?? {}) as Record<string, unknown>;
  const recordType = typeof obj.RecordType === "string" ? obj.RecordType : "unknown";
  const messageId = typeof obj.MessageID === "string" ? obj.MessageID : null;
  const email = typeof obj.Email === "string" ? obj.Email : null;
  const externalEventId = messageId ? `${recordType}:${messageId}` : createHash("sha256").update(JSON.stringify(obj)).digest("hex");

  const suppressions: ParsedSuppressionEvent[] = [];
  if (email) {
    if (recordType === "Bounce") {
      const type = typeof obj.Type === "string" ? obj.Type : "";
      // Postmark's "HardBounce" is permanent; soft/transient bounce types
      // (e.g. "Transient") are NOT suppressed — only a hard bounce means
      // "never send here again".
      if (type === "HardBounce") suppressions.push({ email, reason: "bounced" });
    } else if (recordType === "SpamComplaint") {
      suppressions.push({ email, reason: "complained" });
    } else if (recordType === "SubscriptionChange" && obj.SuppressSending === true) {
      suppressions.push({ email, reason: "unsubscribed" });
    }
  }

  return { externalEventId, eventType: recordType, suppressions };
}

/**
 * POST /webhooks/listmonk/:integrationId/:service
 */
listmonkWebhooksRouter.post(
  "/webhooks/listmonk/:integrationId/:service",
  perIpLimiter,
  perIntegrationLimiter,
  async (req, res, next) => {
    const client = await pool.connect();
    let settled = false;
    try {
      const { integrationId, service } = paramsSchema.parse(req.params);

      await client.query("BEGIN");
      await client.query("SELECT set_config('app.lookup_integration_id', $1, true)", [integrationId]);

      const integrationResult = await client.query<{ id: string; tenant_id: string; project_id: string }>(
        `SELECT id, tenant_id, project_id FROM integrations WHERE id = $1 AND provider = 'listmonk'`,
        [integrationId],
      );
      if (integrationResult.rowCount === 0) {
        await client.query("ROLLBACK");
        settled = true;
        client.release();
        next(Errors.notFound("Unknown listmonk integration"));
        return;
      }
      const integration = integrationResult.rows[0];
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [integration.tenant_id]);

      // Shared resolver (apps/api/src/lib/integrationCredentials.ts, built
      // by the orchestrator's section-6 registry upgrade) + the same
      // config/secret parser listmonkClient.ts's getListmonkClient() and
      // checkHealth() use — one parsing rule for "is there a usable
      // listmonk credential", not three.
      const resolved = await getIntegrationCredential(client, integration.tenant_id, integration.project_id, "listmonk");
      const credential = resolved ? parseListmonkCredential(resolved.config, resolved.secret) : null;
      if (!credential) {
        await client.query("ROLLBACK");
        settled = true;
        client.release();
        res.status(503).json({
          error: "not_configured",
          message: "This listmonk integration has no usable credential yet (config.baseUrl/config.apiUser + a stored secret are all required).",
        });
        return;
      }

      const verification = credential.webhookVerification ?? {};

      let parsed: ParsedWebhook[] = [];
      if (service === "sendgrid") {
        const sig = req.header("X-Twilio-Email-Event-Webhook-Signature");
        const ts = req.header("X-Twilio-Email-Event-Webhook-Timestamp");
        if (!verification.sendgridPublicKey) {
          await client.query("ROLLBACK");
          settled = true;
          client.release();
          res.status(503).json({ error: "not_configured", message: "No sendgridPublicKey configured for this integration — refusing to accept unverifiable events." });
          return;
        }
        if (!sig || !ts || !req.rawBody || !verifySendgridSignature(req.rawBody, sig, ts, verification.sendgridPublicKey)) {
          logger.warn({ integrationId }, "listmonk webhook (sendgrid) rejected: missing/invalid signature");
          await client.query("ROLLBACK");
          settled = true;
          client.release();
          res.status(401).json({ error: "unauthorized", message: "Invalid or missing SendGrid webhook signature" });
          return;
        }
        parsed = parseSendgrid(req.body);
      } else if (service === "ses") {
        // Real verification (see module doc comment + verifySesSnsSignature
        // above) — a message whose SigningCertURL/Signature doesn't check
        // out against AWS's own documented SNS signing scheme is rejected
        // 401, never silently accepted.
        const body = req.body;
        const valid = body && typeof body === "object" && (await verifySesSnsSignature(body as Record<string, unknown>));
        if (!valid) {
          logger.warn({ integrationId }, "listmonk webhook (ses) rejected: missing/invalid SNS signature");
          await client.query("ROLLBACK");
          settled = true;
          client.release();
          res.status(401).json({ error: "unauthorized", message: "Invalid, missing, or unverifiable SNS message signature" });
          return;
        }
        const one = parseSes(req.body);
        parsed = one ? [one] : [];
      } else {
        // postmark
        if (!verification.postmarkBasicAuthUser || !verification.postmarkBasicAuthPass) {
          await client.query("ROLLBACK");
          settled = true;
          client.release();
          res.status(503).json({
            error: "not_configured",
            message: "No postmarkBasicAuthUser/postmarkBasicAuthPass configured for this integration — Postmark has no signature scheme, so Basic Auth is required before events are accepted.",
          });
          return;
        }
        if (!verifyPostmarkBasicAuth(req, verification.postmarkBasicAuthUser, verification.postmarkBasicAuthPass)) {
          logger.warn({ integrationId }, "listmonk webhook (postmark) rejected: missing/invalid Basic Auth");
          await client.query("ROLLBACK");
          settled = true;
          client.release();
          res.status(401).json({ error: "unauthorized", message: "Invalid or missing Basic Auth credentials" });
          return;
        }
        parsed = [parsePostmark(req.body)];
      }

      const results: Array<{ eventId: string | null; deduplicated: boolean; suppressed: number }> = [];

      for (const event of parsed) {
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO integration_webhook_events (tenant_id, integration_id, provider, external_event_id, event_type, payload, status)
           VALUES ($1, $2, 'listmonk', $3, $4, $5::jsonb, 'pending')
           ON CONFLICT (integration_id, external_event_id) DO NOTHING
           RETURNING id`,
          [integration.tenant_id, integrationId, event.externalEventId, event.eventType, JSON.stringify({ service, raw: req.body })],
        );

        if (inserted.rowCount === 0) {
          results.push({ eventId: null, deduplicated: true, suppressed: 0 });
          continue;
        }
        const eventRowId = inserted.rows[0].id;

        if (event.acknowledgeOnly) {
          await client.query(`UPDATE integration_webhook_events SET status = 'ignored', processed_at = now() WHERE id = $1`, [eventRowId]);
          results.push({ eventId: eventRowId, deduplicated: false, suppressed: 0 });
          continue;
        }

        // Write into the EXISTING suppression_list table (same shape as
        // src/routes/compliance.ts's suppressionRouter POST handler) —
        // reusing the one real suppression mechanism, never a parallel one.
        for (const s of event.suppressions) {
          await client.query(
            `INSERT INTO suppression_list (tenant_id, email, reason, channel, source_note)
             VALUES ($1, $2, $3, 'email', $4)
             ON CONFLICT DO NOTHING`,
            [integration.tenant_id, s.email, s.reason, `listmonk webhook (${service}), event ${event.externalEventId}`],
          );
        }

        await client.query(`UPDATE integration_webhook_events SET status = 'processed', processed_at = now() WHERE id = $1`, [eventRowId]);
        results.push({ eventId: eventRowId, deduplicated: false, suppressed: event.suppressions.length });
      }

      await client.query("COMMIT");
      settled = true;
      client.release();

      res.status(200).json({ received: true, events: results });
    } catch (err) {
      if (!settled) {
        await client.query("ROLLBACK").catch(() => undefined);
        client.release();
      }
      next(err);
    }
  },
);
