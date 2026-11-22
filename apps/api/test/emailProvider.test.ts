import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock nodemailer so SmtpEmailProvider tests never attempt a real network
// connection — same injectable-dependency convention as
// apps/api/src/lib/dnsVerification.ts's TxtResolver.
const sendMailMock = vi.fn();
const createTransportMock = vi.fn(() => ({ sendMail: sendMailMock }));

vi.mock("nodemailer", () => ({
  default: { createTransport: (...args: unknown[]) => createTransportMock(...args) },
}));

const {
  NotConfiguredError,
  NotConfiguredEmailProvider,
  SmtpEmailProvider,
  getEmailProvider,
} = await import("../src/lib/emailProvider.js");

const ENV_KEYS = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "SMTP_FROM"] as const;
const originalEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  sendMailMock.mockReset();
  createTransportMock.mockClear();
  for (const key of ENV_KEYS) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

describe("NotConfiguredEmailProvider", () => {
  it("always throws NotConfiguredError and never returns a fabricated 'sent' result", async () => {
    const provider = new NotConfiguredEmailProvider();
    await expect(provider.send({ to: "lead@example.com", subject: "Hi", body: "Hello" })).rejects.toThrow(
      NotConfiguredError,
    );
  });
});

describe("getEmailProvider", () => {
  it("returns NotConfiguredEmailProvider when SMTP env vars are not all set", () => {
    // No SMTP_* env vars set at all (cleared in beforeEach).
    const provider = getEmailProvider();
    expect(provider).toBeInstanceOf(NotConfiguredEmailProvider);
  });

  it("returns NotConfiguredEmailProvider when only SOME SMTP env vars are set", () => {
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.SMTP_PORT = "587";
    // SMTP_USER/SMTP_PASS/SMTP_FROM left unset
    const provider = getEmailProvider();
    expect(provider).toBeInstanceOf(NotConfiguredEmailProvider);
  });

  it("returns a real SmtpEmailProvider when every SMTP env var is set", () => {
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.SMTP_PORT = "587";
    process.env.SMTP_USER = "user@example.com";
    process.env.SMTP_PASS = "secret";
    process.env.SMTP_FROM = "sender@example.com";

    const provider = getEmailProvider();
    expect(provider).toBeInstanceOf(SmtpEmailProvider);
  });

  it("falls back to NotConfiguredEmailProvider when SMTP_PORT is not a valid positive number", () => {
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.SMTP_PORT = "not-a-number";
    process.env.SMTP_USER = "user@example.com";
    process.env.SMTP_PASS = "secret";
    process.env.SMTP_FROM = "sender@example.com";

    const provider = getEmailProvider();
    expect(provider).toBeInstanceOf(NotConfiguredEmailProvider);
  });
});

describe("SmtpEmailProvider", () => {
  it("sends mail via nodemailer with the configured defaults, and returns a real messageId", async () => {
    sendMailMock.mockResolvedValueOnce({ messageId: "<abc123@smtp.example.com>" });

    const provider = new SmtpEmailProvider({
      host: "smtp.example.com",
      port: 587,
      user: "user@example.com",
      pass: "secret",
      from: "sender@example.com",
    });

    const result = await provider.send({ to: "lead@example.com", subject: "Hi there", body: "Let's talk" });

    expect(createTransportMock).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "smtp.example.com",
        port: 587,
        secure: false,
        auth: { user: "user@example.com", pass: "secret" },
      }),
    );
    expect(sendMailMock).toHaveBeenCalledWith({
      from: "sender@example.com",
      to: "lead@example.com",
      subject: "Hi there",
      text: "Let's talk",
    });
    expect(result.provider).toBe("smtp");
    expect(result.messageId).toBe("<abc123@smtp.example.com>");
    expect(typeof result.sentAt).toBe("string");
  });

  it("uses secure:true for port 465 (implicit TLS)", () => {
    new SmtpEmailProvider({
      host: "smtp.example.com",
      port: 465,
      user: "user@example.com",
      pass: "secret",
      from: "sender@example.com",
    });

    expect(createTransportMock).toHaveBeenCalledWith(expect.objectContaining({ secure: true }));
  });

  it("overrides the default From address when the message supplies its own `from`", async () => {
    sendMailMock.mockResolvedValueOnce({ messageId: "<xyz@smtp.example.com>" });

    const provider = new SmtpEmailProvider({
      host: "smtp.example.com",
      port: 587,
      user: "user@example.com",
      pass: "secret",
      from: "default@example.com",
    });

    await provider.send({ to: "lead@example.com", subject: "Hi", body: "Hello", from: "rep@example.com" });

    expect(sendMailMock).toHaveBeenCalledWith(expect.objectContaining({ from: "rep@example.com" }));
  });
});
