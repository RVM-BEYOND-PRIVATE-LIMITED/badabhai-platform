import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import type { EmailMessage } from "../notifications/email-notification.service";
import type { EmailNotificationService } from "../notifications/email-notification.service";
import { ZeptoMailEmailLoginChannel } from "./zeptomail-email-login-channel";

/**
 * ADR-0038 — this channel no longer owns a transport, so its TRANSPORT tests moved to
 * `notifications/email-notification.service.test.ts` (intact — consolidation must not lose
 * the coverage the duplicated copies had). What is left here is what this class still owns:
 * COMPOSING the payer's login email correctly and propagating the pipeline's opaque failure.
 */

const CODE = "428913";
const EMAIL = "payer@example.com";
const DELIVERY = { code: CODE, email: EMAIL, phone: null, payerId: "p1" };

function make(sendImpl?: () => Promise<void>) {
  const send = vi.fn<(m: EmailMessage) => Promise<void>>(sendImpl ?? (async () => undefined));
  const channel = new ZeptoMailEmailLoginChannel({ send } as unknown as EmailNotificationService);
  return { channel, send, sent: (): EmailMessage => send.mock.calls[0]![0] };
}

describe("ZeptoMailEmailLoginChannel — declared shape", () => {
  it("is a real (non-mock) email_otp channel", () => {
    const { channel } = make();
    expect(channel.method).toBe("email_otp");
    expect(channel.mock).toBe(false);
  });
});

describe("ZeptoMailEmailLoginChannel.deliver — composition", () => {
  it("sends to the payer's address, tagged principal=payer purpose=login_code", async () => {
    const { channel, sent } = make();
    await channel.deliver(DELIVERY);
    const msg = sent();
    expect(msg.to).toBe(EMAIL);
    // These two are the log dimensions the shared pipeline emits. Mis-tagging would make an
    // admin outage look like a payer one in the only signal ops has.
    expect(msg.principal).toBe("payer");
    expect(msg.purpose).toBe("login_code");
  });

  it("puts the code in BOTH bodies (its only legitimate home) and never in the subject", async () => {
    const { channel, sent } = make();
    await channel.deliver(DELIVERY);
    const msg = sent();
    expect(msg.text).toContain(CODE);
    expect(msg.html).toContain(CODE);
    // Subjects are the part of an email most likely to end up in a notification preview,
    // a push banner, or a mail-server log line.
    expect(msg.subject).not.toContain(CODE);
  });

  it("PROPAGATES a delivery failure so the reserved code is rolled back", async () => {
    // PayerOtpService deletes the stored code when deliver() throws. Swallowing here would
    // leave a live code nobody received — unusable to the payer, valid to anyone who had it.
    const { channel } = make(async () => {
      throw new Error("email delivery failed");
    });
    await expect(channel.deliver(DELIVERY)).rejects.toThrow(/email delivery failed/);
  });
});
