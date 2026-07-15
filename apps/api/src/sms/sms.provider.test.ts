import "reflect-metadata";
import { describe, it, expect, vi, afterEach } from "vitest";
import { Logger } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import type { PiiCryptoService } from "../common/pii-crypto.service";
import { Fast2SmsProvider } from "./fast2sms.provider";
import { SmsSendError } from "./sms.provider";

const PHONE = "+919876543210";
const CODE = "428913";

const pii = {
  hashPhone: (_phone: string) => "abcd1234ef567890abcd1234ef567890",
} as unknown as PiiCryptoService;

// NOTE: ConsoleSmsProvider was DELETED — worker OTP is real-only (Fast2SMS, no console
// fallback), so its describe block was removed with it.

describe("Fast2SmsProvider.toNationalNumber", () => {
  it("strips a leading +91 to a 10-digit national number", () => {
    expect(Fast2SmsProvider.toNationalNumber("+919876543210")).toBe("9876543210");
  });
  it("strips a leading 91 without a plus", () => {
    expect(Fast2SmsProvider.toNationalNumber("919876543210")).toBe("9876543210");
  });
  it("strips non-digit characters", () => {
    expect(Fast2SmsProvider.toNationalNumber("+91 98765-43210")).toBe("9876543210");
  });
  it("keeps a bare 10-digit number", () => {
    expect(Fast2SmsProvider.toNationalNumber("9876543210")).toBe("9876543210");
  });
});

const fast2smsConfig = {
  SMS_PROVIDER: "fast2sms",
  FAST2SMS_API_KEY: "test-api-key",
  FAST2SMS_SENDER_ID: "BADBHI",
  FAST2SMS_DLT_TEMPLATE_ID: "123456",
  FAST2SMS_ENTITY_ID: "9999",
  FAST2SMS_ROUTE: "dlt",
} as unknown as ServerConfig;

describe("Fast2SmsProvider.sendOtp", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("builds the right DLT request and resolves on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ return: true, request_id: "abc" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new Fast2SmsProvider(fast2smsConfig, pii);
    await expect(provider.sendOtp({ phoneE164: PHONE, code: CODE })).resolves.toBeUndefined();

    const url = fetchMock.mock.calls[0]![0] as string;
    const init = fetchMock.mock.calls[0]![1] as { headers: Record<string, string> };
    expect(url).toContain("https://www.fast2sms.com/dev/bulkV2");
    expect(url).toContain("route=dlt");
    expect(url).toContain("sender_id=BADBHI");
    expect(url).toContain("message=123456");
    expect(url).toContain(`variables_values=${CODE}`);
    expect(url).toContain("numbers=9876543210"); // normalized to 10 digits
    expect(url).toContain("entity_id=9999");
    expect(init.headers.authorization).toBe("test-api-key");
  });

  it("throws when the provider returns return:false — SmsSendError('provider_rejected') (F4)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ return: false, message: ["Invalid"] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = new Fast2SmsProvider(fast2smsConfig, pii);
    const err = await provider.sendOtp({ phoneE164: PHONE, code: CODE }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SmsSendError);
    expect((err as SmsSendError).reason).toBe("provider_rejected");
  });

  it("throws on a non-2xx response — SmsSendError('http_error') (F4)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({}),
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = new Fast2SmsProvider(fast2smsConfig, pii);
    const err = await provider.sendOtp({ phoneE164: PHONE, code: CODE }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SmsSendError);
    expect((err as SmsSendError).reason).toBe("http_error");
  });

  it("throws on a network failure — SmsSendError('transport') (F4)", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new Fast2SmsProvider(fast2smsConfig, pii);
    const err = await provider.sendOtp({ phoneE164: PHONE, code: CODE }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SmsSendError);
    expect((err as SmsSendError).reason).toBe("transport");
  });

  it("throws on an unparseable 200 body — SmsSendError('provider_rejected') (F4)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("not json");
      },
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = new Fast2SmsProvider(fast2smsConfig, pii);
    const err = await provider.sendOtp({ phoneE164: PHONE, code: CODE }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SmsSendError);
    expect((err as SmsSendError).reason).toBe("provider_rejected");
  });

  it("the thrown error never contains the code or the raw number", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = new Fast2SmsProvider(fast2smsConfig, pii);
    await provider.sendOtp({ phoneE164: PHONE, code: CODE }).catch((e: Error) => {
      expect(e.message).not.toContain(CODE);
      expect(e.message).not.toContain("9876543210");
    });
  });

  it("throws when not fully configured (fail closed)", async () => {
    const partial = { ...fast2smsConfig, FAST2SMS_API_KEY: undefined } as unknown as ServerConfig;
    const provider = new Fast2SmsProvider(partial, pii);
    await expect(provider.sendOtp({ phoneE164: PHONE, code: CODE })).rejects.toThrow();
  });

  // §2 invariant (OTP-3): the provider NEVER logs the raw phone or the OTP code — only a
  // prefix of the phone HASH + a status. Assert it directly across BOTH success and the
  // provider-rejected failure (the two log sites), spying every Logger level.
  it("never logs the raw phone or the OTP code (success or failure)", async () => {
    const logArgs: unknown[] = [];
    for (const level of ["log", "error", "warn", "debug", "verbose"] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
        logArgs.push(...args);
        return undefined as never;
      });
    }

    const okFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ return: true, request_id: "abc" }),
    });
    vi.stubGlobal("fetch", okFetch);
    await new Fast2SmsProvider(fast2smsConfig, pii).sendOtp({ phoneE164: PHONE, code: CODE });

    const rejectFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ return: false, message: ["Invalid"] }),
    });
    vi.stubGlobal("fetch", rejectFetch);
    await new Fast2SmsProvider(fast2smsConfig, pii)
      .sendOtp({ phoneE164: PHONE, code: CODE })
      .catch(() => undefined);

    expect(logArgs.length).toBeGreaterThan(0); // proves the log sites actually fired
    const logged = logArgs.map(String).join("\n");
    expect(logged).not.toContain(CODE); // the OTP code
    expect(logged).not.toContain("9876543210"); // the national number
    expect(logged).not.toContain(PHONE); // the raw E.164 phone
  });
});
