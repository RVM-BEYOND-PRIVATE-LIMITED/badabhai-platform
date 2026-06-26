import "reflect-metadata";
import { describe, it, expect, vi, afterEach } from "vitest";
import { Logger } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import type { PiiCryptoService } from "../common/pii-crypto.service";
import { ZeptoMailEmailLoginChannel } from "./zeptomail-email-login-channel";
import type { PayerLoginCodeDelivery } from "./payer-login-channel";

// --- nodemailer mock (the SMTP branch) -------------------------------------
// Hoisted so it is in place before the channel imports nodemailer. `sendMailMock`
// is the controllable send used by the SMTP-path tests.
const { sendMailMock, createTransportMock } = vi.hoisted(() => {
  const sendMailMock = vi.fn();
  const createTransportMock = vi.fn(() => ({ sendMail: sendMailMock }));
  return { sendMailMock, createTransportMock };
});
vi.mock("nodemailer", () => ({
  createTransport: createTransportMock,
  default: { createTransport: createTransportMock },
}));

const EMAIL = "payer@example.com";
const CODE = "428913";
// The keyed-HMAC prefix the channel logs (its first 8 chars). The raw email/code must
// never appear anywhere in a log call — only this prefix + a status token.
const EMAIL_HMAC = "abcd1234ef567890abcd1234ef567890";
const EMAIL_HASH_PREFIX = EMAIL_HMAC.slice(0, 8);

const pii = {
  hmac: (_value: string) => EMAIL_HMAC,
} as unknown as PiiCryptoService;

const DELIVERY: PayerLoginCodeDelivery = {
  code: CODE,
  email: EMAIL,
  phone: null,
  payerId: "00000000-0000-0000-0000-000000000001",
};

const zeptoConfig = (over: Partial<ServerConfig> = {}): ServerConfig =>
  ({
    EMAIL_PROVIDER: "zeptomail",
    ZEPTOMAIL_API_URL: "https://api.zeptomail.in/v1.1/email",
    ZEPTOMAIL_API_TOKEN: "enc-token-xyz",
    ZEPTOMAIL_MAIL_AGENT: "agent-alias-123",
    ZEPTOMAIL_SANDBOX_MODE: false,
    EMAIL_FROM_ADDRESS: "noreply@badabhai.in",
    EMAIL_FROM_NAME: "BadaBhai",
    EMAIL_REPLY_TO: "support@badabhai.in",
    ...over,
  }) as unknown as ServerConfig;

const smtpConfig = (over: Partial<ServerConfig> = {}): ServerConfig =>
  ({
    EMAIL_PROVIDER: "smtp",
    SMTP_HOST: "smtp.example.com",
    SMTP_PORT: 587,
    SMTP_USER: "smtp-user",
    SMTP_PASS: "smtp-pass",
    SMTP_FROM: undefined,
    EMAIL_FROM_ADDRESS: "noreply@badabhai.in",
    EMAIL_FROM_NAME: "BadaBhai",
    EMAIL_REPLY_TO: "support@badabhai.in",
    ...over,
  }) as unknown as ServerConfig;

/** Assert NO log call argument leaked the raw email, the code, or a JSON response body. */
const assertNoPiiInLogs = (spies: Array<{ mock: { calls: unknown[][] } }>): void => {
  for (const spy of spies) {
    for (const call of spy.mock.calls) {
      for (const arg of call) {
        const text = typeof arg === "string" ? arg : JSON.stringify(arg);
        expect(text).not.toContain(EMAIL);
        expect(text).not.toContain(CODE);
        // a JSON response body would carry these provider keys
        expect(text).not.toContain("request_id");
        expect(text).not.toContain('"data"');
      }
    }
  }
};

describe("ZeptoMailEmailLoginChannel — declared shape", () => {
  it("is a real (non-mock) email_otp channel", () => {
    const channel = new ZeptoMailEmailLoginChannel(zeptoConfig(), pii);
    expect(channel.method).toBe("email_otp");
    expect(channel.mock).toBe(false);
  });
});

describe("ZeptoMailEmailLoginChannel.deliver — ZeptoMail HTTPS path", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    sendMailMock.mockReset();
    createTransportMock.mockClear();
  });

  it("POSTs once to the API URL with Zoho-enczapikey auth and the input email as the recipient", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ code: "EM_104", message: "success" }], request_id: "r1" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const channel = new ZeptoMailEmailLoginChannel(zeptoConfig(), pii);
    await expect(channel.deliver(DELIVERY)).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("https://api.zeptomail.in/v1.1/email");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Zoho-enczapikey enc-token-xyz");
    expect(headers["Content-Type"]).toBe("application/json");

    const sent = JSON.parse(init.body as string) as {
      to: Array<{ email_address: { address: string } }>;
      from: { address: string };
      mail_agent_alias: string;
      reply_to?: Array<{ address: string }>;
      htmlbody: string;
      textbody: string;
    };
    expect(sent.to[0]!.email_address.address).toBe(EMAIL);
    expect(sent.from.address).toBe("noreply@badabhai.in");
    expect(sent.mail_agent_alias).toBe("agent-alias-123");
    expect(sent.reply_to?.[0]!.address).toBe("support@badabhai.in");
    // The code is in the email body (its legitimate place) and only there.
    expect(sent.htmlbody).toContain(CODE);
    expect(sent.textbody).toContain(CODE);
  });

  it("throws on a non-2xx response (and the error is opaque)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: { code: "TM_3201" } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const channel = new ZeptoMailEmailLoginChannel(zeptoConfig(), pii);
    await channel.deliver(DELIVERY).catch((e: Error) => {
      expect(e.message).not.toContain(EMAIL);
      expect(e.message).not.toContain(CODE);
      expect(e.message).toBe("email delivery failed");
    });
    await expect(channel.deliver(DELIVERY)).rejects.toThrow();
  });

  it("throws when fetch rejects (transport error)", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error(`boom for ${EMAIL}`));
    vi.stubGlobal("fetch", fetchMock);
    const channel = new ZeptoMailEmailLoginChannel(zeptoConfig(), pii);
    await channel.deliver(DELIVERY).catch((e: Error) => {
      expect(e.message).not.toContain(EMAIL);
      expect(e.message).not.toContain(CODE);
    });
    await expect(channel.deliver(DELIVERY)).rejects.toThrow();
  });

  it("throws when the ZeptoMail body indicates failure (error object present)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ error: { code: "SM_101", details: [] } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const channel = new ZeptoMailEmailLoginChannel(zeptoConfig(), pii);
    await expect(channel.deliver(DELIVERY)).rejects.toThrow();
  });

  it("sets the documented sandbox flag on the request when ZEPTOMAIL_SANDBOX_MODE=true", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ code: "EM_104" }] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const channel = new ZeptoMailEmailLoginChannel(
      zeptoConfig({ ZEPTOMAIL_SANDBOX_MODE: true }),
      pii,
    );
    await expect(channel.deliver(DELIVERY)).resolves.toBeUndefined();

    // The request still fires (full request path exercised) AND carries the sandbox flag.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const sent = JSON.parse(init.body as string) as { sandbox?: boolean };
    expect(sent.sandbox).toBe(true);
  });
});

describe("ZeptoMailEmailLoginChannel.deliver — logging discipline (no raw PII)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs only the email-hash prefix + status on success — never the email, code, or body", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ code: "EM_104" }], request_id: "r9" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const logSpy = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);

    const channel = new ZeptoMailEmailLoginChannel(zeptoConfig(), pii);
    await channel.deliver(DELIVERY);

    assertNoPiiInLogs([logSpy, warnSpy]);
    // The success line carries the hash prefix + a status token.
    const logged = logSpy.mock.calls.flat().join(" ");
    expect(logged).toContain(EMAIL_HASH_PREFIX);
    expect(logged).toContain("status=sent");
  });

  it("logs only the email-hash prefix + a short reason on failure — never the email, code, or body", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ error: { code: "SM_101" }, request_id: "r-fail" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const logSpy = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);

    const channel = new ZeptoMailEmailLoginChannel(zeptoConfig(), pii);
    await expect(channel.deliver(DELIVERY)).rejects.toThrow();

    assertNoPiiInLogs([logSpy, warnSpy]);
    const warned = warnSpy.mock.calls.flat().join(" ");
    expect(warned).toContain(EMAIL_HASH_PREFIX);
    expect(warned).toContain("status=failed");
  });
});

describe("ZeptoMailEmailLoginChannel.deliver — SMTP path (nodemailer)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    sendMailMock.mockReset();
    createTransportMock.mockClear();
  });

  it("provider=smtp reaches the SMTP branch and sends to the input email", async () => {
    sendMailMock.mockResolvedValue({ messageId: "m1" });
    const channel = new ZeptoMailEmailLoginChannel(smtpConfig(), pii);
    await expect(channel.deliver(DELIVERY)).resolves.toBeUndefined();

    expect(createTransportMock).toHaveBeenCalledTimes(1);
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    const mail = sendMailMock.mock.calls[0]![0] as {
      to: string;
      from: string;
      text: string;
      html: string;
      replyTo?: string;
    };
    expect(mail.to).toBe(EMAIL);
    expect(mail.replyTo).toBe("support@badabhai.in");
    expect(mail.text).toContain(CODE);
    expect(mail.html).toContain(CODE);
  });

  it("throws an opaque error when nodemailer rejects", async () => {
    sendMailMock.mockRejectedValue(new Error(`smtp blew up for ${EMAIL} code ${CODE}`));
    const channel = new ZeptoMailEmailLoginChannel(smtpConfig(), pii);
    await channel.deliver(DELIVERY).catch((e: Error) => {
      expect(e.message).not.toContain(EMAIL);
      expect(e.message).not.toContain(CODE);
      expect(e.message).toBe("email delivery failed");
    });
    await expect(channel.deliver(DELIVERY)).rejects.toThrow();
  });

  it("auto falls back to SMTP when ZeptoMail creds are incomplete", async () => {
    sendMailMock.mockResolvedValue({ messageId: "m2" });
    const channel = new ZeptoMailEmailLoginChannel(
      smtpConfig({ EMAIL_PROVIDER: "auto", ZEPTOMAIL_API_TOKEN: undefined }),
      pii,
    );
    await expect(channel.deliver(DELIVERY)).resolves.toBeUndefined();
    expect(sendMailMock).toHaveBeenCalledTimes(1);
  });
});

describe("ZeptoMailEmailLoginChannel.deliver — fail-closed on an unmapped EMAIL_PROVIDER", () => {
  it("throws (never silently no-ops) if reached with an unmapped provider value", async () => {
    // EMAIL_PROVIDER is real-only (zeptomail/smtp/auto); the "none"/mock value was removed. The
    // resolveTransport default arm still fails CLOSED for any out-of-band value — exercise it
    // by forcing one past the type (a config drift / future-provider safety net).
    const channel = new ZeptoMailEmailLoginChannel(
      zeptoConfig({ EMAIL_PROVIDER: "unmapped" as unknown as ServerConfig["EMAIL_PROVIDER"] }),
      pii,
    );
    await expect(channel.deliver(DELIVERY)).rejects.toThrow();
  });
});
