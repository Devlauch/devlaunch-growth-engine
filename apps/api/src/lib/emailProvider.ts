/**
 * emailProvider: the real, pluggable outbound-email send surface for
 * Multi-Channel Customer Acquisition / Campaign Execution.
 *
 * Until this file, NOTHING in this codebase ever actually sent an email —
 * routes/sendingSetup.ts verifies DNS (SPF/DKIM/DMARC) and computes warm-up
 * limits, but says outright "no real outbound sending exists in this
 * codebase yet", and advanceSequences.ts's email-step handling stopped at
 * "advancing the step is as far as 'sending' goes ... a real send
 * integration plugs in exactly here."
 *
 * This mirrors the exact NotConfiguredError idiom already used elsewhere
 * (apps/api/src/lib/keywordRankingStub.ts's NotConfiguredRankingProvider,
 * packages/agent-sdk/src/connectors/publicDirectoryConnector.ts):
 *
 *   1. `EmailProvider` — the stable pluggable interface. Any real
 *      implementation (SMTP today; Postmark/SendGrid/SES/etc. later) can
 *      implement this without any caller (advanceSequences.ts) changing.
 *   2. `NotConfiguredEmailProvider` — the honest stand-in used whenever
 *      SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS/SMTP_FROM are not ALL set.
 *      It always throws NotConfiguredError — it NEVER returns a fabricated
 *      "sent" result.
 *   3. `SmtpEmailProvider` — the one real implementation, using nodemailer
 *      against a plain SMTP server. This genuinely sends mail when SMTP
 *      credentials are configured.
 *
 * getEmailProvider() is the single factory callers should use; it reads
 * env vars fresh on every call (so tests can set/unset them per-case
 * without needing a process restart) and returns whichever of the two
 * implementations above applies.
 */

import nodemailer from "nodemailer";

export class NotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotConfiguredError";
  }
}

export interface EmailMessage {
  to: string;
  subject: string;
  body: string;
  /** Overrides the provider's configured default From address/identity for this one message. */
  from?: string | null;
}

export interface EmailSendResult {
  provider: string;
  messageId: string;
  sentAt: string;
}

/** Pluggable backend for sending a single outbound email. */
export interface EmailProvider {
  readonly name: string;
  send(message: EmailMessage): Promise<EmailSendResult>;
}

/**
 * Honest stand-in for when no SMTP connection is configured in this
 * environment. Always throws — never returns a fabricated "sent" result.
 * Wire in a real EmailProvider (SmtpEmailProvider below, or any other
 * implementer) once SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS/SMTP_FROM are
 * set.
 */
export class NotConfiguredEmailProvider implements EmailProvider {
  readonly name = "not_configured";

  async send(_message: EmailMessage): Promise<never> {
    throw new NotConfiguredError(
      "No SMTP provider is configured in this environment (SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS/SMTP_FROM " +
        "must all be set). Refusing to fabricate a 'sent' email result. Set those env vars and getEmailProvider() " +
        "will return a real SmtpEmailProvider instead.",
    );
  }
}

export interface SmtpEmailProviderConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  /** Default From header used when a message doesn't specify its own `from`. */
  from: string;
}

/**
 * Real SMTP implementation, using nodemailer. Genuinely connects to the
 * configured SMTP server and sends mail — this is the one concrete,
 * non-stub provider in this codebase.
 */
export class SmtpEmailProvider implements EmailProvider {
  readonly name = "smtp";
  private readonly transporter: nodemailer.Transporter;
  private readonly defaultFrom: string;

  constructor(config: SmtpEmailProviderConfig) {
    this.transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      // Port 465 is implicit TLS; everything else (587/25/etc.) negotiates
      // STARTTLS if the server offers it. This is nodemailer's own
      // documented convention, not a guess.
      secure: config.port === 465,
      auth: { user: config.user, pass: config.pass },
    });
    this.defaultFrom = config.from;
  }

  async send(message: EmailMessage): Promise<EmailSendResult> {
    const info = await this.transporter.sendMail({
      from: message.from ?? this.defaultFrom,
      to: message.to,
      subject: message.subject,
      text: message.body,
    });
    return {
      provider: this.name,
      messageId: info.messageId,
      sentAt: new Date().toISOString(),
    };
  }
}

/**
 * Reads SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS/SMTP_FROM fresh from
 * process.env and returns a real SmtpEmailProvider only when every one of
 * them is set; otherwise returns the honest NotConfiguredEmailProvider.
 * This is the single factory advanceSequences.ts (and any future send
 * path) should call — never construct either class directly outside of
 * tests, so a future additional provider can be added here without
 * touching callers.
 */
export function getEmailProvider(): EmailProvider {
  const host = process.env.SMTP_HOST;
  const port = process.env.SMTP_PORT;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.SMTP_FROM;

  if (!host || !port || !user || !pass || !from) {
    return new NotConfiguredEmailProvider();
  }

  const parsedPort = Number(port);
  if (!Number.isFinite(parsedPort) || parsedPort <= 0) {
    return new NotConfiguredEmailProvider();
  }

  return new SmtpEmailProvider({ host, port: parsedPort, user, pass, from });
}
