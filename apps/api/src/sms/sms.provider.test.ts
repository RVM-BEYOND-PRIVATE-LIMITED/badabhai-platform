import "reflect-metadata";
import { describe, it, expect, vi, afterEach } from "vitest";
import type { ServerConfig } from "@badabhai/config";
import type { PiiCryptoService } from "../common/pii-crypto.service";
import { ConsoleSmsProvider } from "./console-sms.provider";
import { Fast2SmsProvider } from "./fast2sms.provider";

const PHONE = "+919876543210";
const CODE = "428913";

const pii = {
  hashPhone: (_phone: string) => "abcd1234ef567890abcd1234ef567890",
} as unknown as PiiCryptoService;

describe("ConsoleSmsProvider", () => {
  it("logs the code (dev only) without throwing", async () => {
    const provider = new ConsoleSmsProvider(pii);
    await expect(provider.sendOtp({ phoneE164: PHONE, code: CODE })).resolves.toBeUndefined();
  });
});

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

  it("throws when the provider returns return:false", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ return: false, message: ["Invalid"] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = new Fast2SmsProvider(fast2smsConfig, pii);
    await expect(provider.sendOtp({ phoneE164: PHONE, code: CODE })).rejects.toThrow();
  });

  it("throws on a non-2xx response", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({}),
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = new Fast2SmsProvider(fast2smsConfig, pii);
    await expect(provider.sendOtp({ phoneE164: PHONE, code: CODE })).rejects.toThrow();
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
});
