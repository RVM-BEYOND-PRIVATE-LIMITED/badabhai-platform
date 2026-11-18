import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "@badabhai/config";
import type { SmsProvider } from "../sms/sms.provider";
import { SmsLoginChannel } from "./payer-login-channel";

/**
 * #2754 item 1 — a company's sign-in code by SMS: the same provider seam as worker codes, on the
 * company's own approved DLT template, to the phone on the account.
 */
const PHONE = "+919876543210";
const delivery = { code: "123456", email: "", phone: PHONE, payerId: "p1" };

function channel(templateId: string | undefined) {
  const sms: SmsProvider = { sendOtp: vi.fn().mockResolvedValue(undefined) };
  const config = { FAST2SMS_PAYER_DLT_TEMPLATE_ID: templateId } as unknown as ServerConfig;
  return { sms, ch: new SmsLoginChannel(config, sms) };
}

describe("SmsLoginChannel", () => {
  it("is the real sms_otp channel", () => {
    const { ch } = channel("1707000000000000001");
    expect(ch.method).toBe("sms_otp");
    expect(ch.mock).toBe(false);
  });

  it("sends the code to the account's phone on the COMPANY template, never the worker one", async () => {
    const { sms, ch } = channel("1707000000000000001");
    await ch.deliver(delivery);
    expect(sms.sendOtp).toHaveBeenCalledWith({
      phoneE164: PHONE,
      code: "123456",
      templateId: "1707000000000000001",
    });
  });

  it("throws (so the store rolls the code back) when the account has no phone", async () => {
    const { sms, ch } = channel("1707000000000000001");
    await expect(ch.deliver({ ...delivery, phone: null })).rejects.toThrow("no_phone_on_file");
    expect(sms.sendOtp).not.toHaveBeenCalled();
  });

  it("throws rather than fall back to the worker template when the company template is unset", async () => {
    const { sms, ch } = channel(undefined);
    await expect(ch.deliver(delivery)).rejects.toThrow("payer_sms_template_not_configured");
    expect(sms.sendOtp).not.toHaveBeenCalled();
  });

  it("passes a provider failure through, so the caller answers the neutral body", async () => {
    const { sms, ch } = channel("1707000000000000001");
    vi.mocked(sms.sendOtp).mockRejectedValueOnce(
      new Error("SMS delivery failed (transport error)"),
    );
    await expect(ch.deliver(delivery)).rejects.toThrow("transport");
  });
});
