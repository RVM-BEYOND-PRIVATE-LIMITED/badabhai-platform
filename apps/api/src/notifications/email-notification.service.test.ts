import "reflect-metadata";
import { describe, it, expect, vi, afterEach } from "vitest";
import { Logger } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import type { PiiCryptoService } from "../common/pii-crypto.service";
import { EmailNotificationService } from "./email-notification.service";
import type { EmailMessage } from "./email-notification.service";

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

/**
 * A representative message. The pipeline is principal-agnostic, so the subject/body are
 * just strings to it — but the CODE is embedded exactly as a real caller would embed it,
 * which is what lets the logging assertions below prove the code never leaks.
 */
const MESSAGE: EmailMessage = {
  to: EMAIL,
  subject: "Your BadaBhai login code",
  html: `<p>${CODE}</p>`,
  text: `Your BadaBhai login code is ${CODE}.`,
  principal: "payer",
  purpose: "login_code",
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

describe("EmailNotificationService — principal-agnostic by construction", () => {
  it("carries no per-principal state: the SAME instance serves every principal", async () => {
    // The point of consolidating. Before ADR-0038 each principal had (or lacked) its own
    // transport copy; the admin principal had none at all, which is why no admin could log
    // in. Nothing here may branch on `principal` — it is a log dimension, not behaviour.
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ code: "EM_104" }] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const svc = new EmailNotificationService(zeptoConfig(), pii);
    for (const principal of ["worker", "payer", "agency", "admin"] as const) {
      await expect(svc.send({ ...MESSAGE, principal })).resolves.toBeUndefined();
    }
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});

describe("EmailNotificationService.send — ZeptoMail HTTPS path", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
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

    const channel = new EmailNotificationService(zeptoConfig(), pii);
    await expect(channel.send(MESSAGE)).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("https://api.zeptomail.in/v1.1/email");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Zoho-enczapikey enc-token-xyz");
    expect(headers["Content-Type"]).toBe("application/json");

    const sent = JSON.parse(init.body as string) as {
      to: Array<{ email_address: { address: string } }>;
      from: { address: string };
      reply_to?: Array<{ address: string }>;
      htmlbody: string;
      textbody: string;
    };
    expect(sent.to[0]!.email_address.address).toBe(EMAIL);
    expect(sent.from.address).toBe("noreply@badabhai.in");
    // The ZeptoMail v1.1 API has NO mail-agent body field — the agent is bound to the
    // send-mail token. Sending a non-standard field could be rejected, so it must be absent.
    expect(sent).not.toHaveProperty("mail_agent_alias");
    expect(sent.reply_to?.[0]!.address).toBe("support@badabhai.in");
    // The code is in the email body (its legitimate place) and only there.
    expect(sent.htmlbody).toContain(CODE);
    expect(sent.textbody).toContain(CODE);
  });

  it("strips a pasted 'Zoho-enczapikey ' prefix so the auth header is never doubled", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ code: "EM_104" }] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    // A user pastes the FULL header value (prefix + raw token) into ZEPTOMAIL_API_TOKEN.
    const channel = new EmailNotificationService(
      zeptoConfig({ ZEPTOMAIL_API_TOKEN: "Zoho-enczapikey raw-token-abc" }),
      pii,
    );
    await expect(channel.send(MESSAGE)).resolves.toBeUndefined();

    const [, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    const auth = (init.headers as Record<string, string>).Authorization;
    // Exactly ONE prefix — not a doubled "Zoho-enczapikey Zoho-enczapikey …" (the HTTP-500 bug).
    expect(auth).toBe("Zoho-enczapikey raw-token-abc");
  });

  it("throws on a non-2xx response (and the error is opaque)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: { code: "TM_3201" } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const channel = new EmailNotificationService(zeptoConfig(), pii);
    await channel.send(MESSAGE).catch((e: Error) => {
      expect(e.message).not.toContain(EMAIL);
      expect(e.message).not.toContain(CODE);
      expect(e.message).toBe("email delivery failed");
    });
    await expect(channel.send(MESSAGE)).rejects.toThrow();
  });

  it("throws when fetch rejects (transport error)", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error(`boom for ${EMAIL}`));
    vi.stubGlobal("fetch", fetchMock);
    const channel = new EmailNotificationService(zeptoConfig(), pii);
    await channel.send(MESSAGE).catch((e: Error) => {
      expect(e.message).not.toContain(EMAIL);
      expect(e.message).not.toContain(CODE);
    });
    await expect(channel.send(MESSAGE)).rejects.toThrow();
  });

  it("throws when the ZeptoMail body indicates failure (error object present)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ error: { code: "SM_101", details: [] } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const channel = new EmailNotificationService(zeptoConfig(), pii);
    await expect(channel.send(MESSAGE)).rejects.toThrow();
  });

  it("sets the documented sandbox flag on the request when ZEPTOMAIL_SANDBOX_MODE=true", async () => {
    // Explicit rather than relying on vitest's ambient NODE_ENV — isDevEnv() now gates
    // this (#813/#814), so the case under test must pin its own env like the others.
    vi.stubEnv("NODE_ENV", "development");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ code: "EM_104" }] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const channel = new EmailNotificationService(
      zeptoConfig({ ZEPTOMAIL_SANDBOX_MODE: true }),
      pii,
    );
    await expect(channel.send(MESSAGE)).resolves.toBeUndefined();

    // The request still fires (full request path exercised) AND carries the sandbox flag.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const sent = JSON.parse(init.body as string) as { sandbox?: boolean };
    expect(sent.sandbox).toBe(true);
  });

  it("IGNORES sandbox in production, so a leftover SANDBOX_MODE=true still DELIVERS (#813/#814)", async () => {
    // The deployed box runs NODE_ENV=production; a leftover ZEPTOMAIL_SANDBOX_MODE=true
    // there was making every payer OTP return code_sent while ZeptoMail delivered
    // nothing. `isDevEnv()` reads the RAW env — not the parsed `config.NODE_ENV` — so
    // the stub is what actually decides the branch under test, matching
    // health.controller.test.ts's convention for the same gate.
    vi.stubEnv("NODE_ENV", "production");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ code: "EM_104" }] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const warnSpy = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);

    const channel = new EmailNotificationService(
      zeptoConfig({ ZEPTOMAIL_SANDBOX_MODE: true, NODE_ENV: "production" }),
      pii,
    );
    await expect(channel.send(MESSAGE)).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const sent = JSON.parse(init.body as string) as { sandbox?: boolean };
    expect(sent.sandbox).toBeUndefined();
    // The override is logged LOUD — an operator watching logs must be able to see it.
    assertNoPiiInLogs([warnSpy]);
    expect(warnSpy.mock.calls.flat().join(" ")).toContain("IGNORED");
  });

  it("IGNORES sandbox with an UNSET NODE_ENV too — isDevEnv is fail-closed, not the parsed default (R14)", async () => {
    // The R14 trap: nodeEnvSchema defaults the PARSED config to "development" when
    // NODE_ENV is unset, so a check against `config.NODE_ENV !== "production"` would
    // read an unset var as "not production" and keep honouring sandbox — silently
    // reopening the exact #813/#814 hole on a box that simply forgot to set NODE_ENV.
    // `isDevEnv()` reads the raw env and is fail-closed: unset is NOT dev, so the
    // override still fires here even though `config.NODE_ENV` is left at its default.
    vi.stubEnv("NODE_ENV", undefined);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ code: "EM_104" }] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const channel = new EmailNotificationService(
      zeptoConfig({ ZEPTOMAIL_SANDBOX_MODE: true }),
      pii,
    );
    await expect(channel.send(MESSAGE)).resolves.toBeUndefined();

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const sent = JSON.parse(init.body as string) as { sandbox?: boolean };
    expect(sent.sandbox).toBeUndefined();
  });

  it("still HONOURS sandbox under NODE_ENV=test — CI/local dev must not start real-sending", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ code: "EM_104" }] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const channel = new EmailNotificationService(
      zeptoConfig({ ZEPTOMAIL_SANDBOX_MODE: true }),
      pii,
    );
    await expect(channel.send(MESSAGE)).resolves.toBeUndefined();

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const sent = JSON.parse(init.body as string) as { sandbox?: boolean };
    expect(sent.sandbox).toBe(true);
  });
});

describe("EmailNotificationService.send — logging discipline (no raw PII)", () => {
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

    const channel = new EmailNotificationService(zeptoConfig(), pii);
    await channel.send(MESSAGE);

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
    // ADR-0038 — a give-up is logged at ERROR, not WARN. The old per-principal channels
    // used warn, which meant a total delivery outage sat at the same level as a retry.
    const errorSpy = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);

    const channel = new EmailNotificationService(zeptoConfig(), pii);
    await expect(channel.send(MESSAGE)).rejects.toThrow();

    assertNoPiiInLogs([logSpy, warnSpy, errorSpy]);
    const errored = errorSpy.mock.calls.flat().join(" ");
    expect(errored).toContain(EMAIL_HASH_PREFIX);
    expect(errored).toContain("status=failed");
    // The closed-vocabulary dimensions that make the line triageable.
    expect(errored).toContain("principal=payer");
    expect(errored).toContain("purpose=login_code");
  });
});

describe("EmailNotificationService.send — SMTP path (nodemailer)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    sendMailMock.mockReset();
    createTransportMock.mockClear();
  });

  it("provider=smtp reaches the SMTP branch and sends to the input email", async () => {
    sendMailMock.mockResolvedValue({ messageId: "m1" });
    const channel = new EmailNotificationService(smtpConfig(), pii);
    await expect(channel.send(MESSAGE)).resolves.toBeUndefined();

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
    const channel = new EmailNotificationService(smtpConfig(), pii);
    await channel.send(MESSAGE).catch((e: Error) => {
      expect(e.message).not.toContain(EMAIL);
      expect(e.message).not.toContain(CODE);
      expect(e.message).toBe("email delivery failed");
    });
    await expect(channel.send(MESSAGE)).rejects.toThrow();
  });

  it("auto falls back to SMTP when ZeptoMail creds are incomplete", async () => {
    sendMailMock.mockResolvedValue({ messageId: "m2" });
    const channel = new EmailNotificationService(
      smtpConfig({ EMAIL_PROVIDER: "auto", ZEPTOMAIL_API_TOKEN: undefined }),
      pii,
    );
    await expect(channel.send(MESSAGE)).resolves.toBeUndefined();
    expect(sendMailMock).toHaveBeenCalledTimes(1);
  });
});

describe("EmailNotificationService.send — fail-closed on an unmapped EMAIL_PROVIDER", () => {
  it("throws (never silently no-ops) if reached with an unmapped provider value", async () => {
    // EMAIL_PROVIDER is real-only (zeptomail/smtp/auto); the "none"/mock value was removed. The
    // resolveTransport default arm still fails CLOSED for any out-of-band value — exercise it
    // by forcing one past the type (a config drift / future-provider safety net).
    const channel = new EmailNotificationService(
      zeptoConfig({ EMAIL_PROVIDER: "unmapped" as unknown as ServerConfig["EMAIL_PROVIDER"] }),
      pii,
    );
    await expect(channel.send(MESSAGE)).rejects.toThrow();
  });
});
