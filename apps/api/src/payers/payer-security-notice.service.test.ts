import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import type { Payer } from "@badabhai/db";
import { PayerSecurityNoticeService } from "./payer-security-notice.service";
import {
  EmailPayerSecurityNoticeMailer,
  type PayerSecurityNotice,
} from "./payer-security-notice.mailer";

function payerRow(over: Partial<Payer> = {}): Payer {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    role: "employer",
    emailEnc: "email-enc",
    emailHash: "email-hash",
    phoneEnc: null,
    phoneHash: null,
    orgNameEnc: "org-enc",
    orgNameLookupHash: null,
    passwordHash: null,
    passwordSetAt: null,
    passwordPepperVersion: null,
    status: "active",
    previousStatus: null,
    mustChangePassword: false,
    passwordRevokedAt: null,
    sessionsValidAfter: null,
    lastLoginAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as Payer;
}

function setup(row: Payer | undefined = payerRow()) {
  const payers = { findById: vi.fn(async () => row) };
  const pii = { decrypt: vi.fn(() => "owner@example.com") };
  const mailer = { send: vi.fn(async (_notice: PayerSecurityNotice) => undefined) };
  const svc = new PayerSecurityNoticeService(payers as never, pii as never, mailer as never);
  return { svc, payers, pii, mailer };
}

describe("PayerSecurityNoticeService (#2563)", () => {
  it("sends to the account's OWN email and carries no password, admin or reason", async () => {
    const d = setup();
    await d.svc.notify(payerRow().id, "reset");

    expect(d.mailer.send).toHaveBeenCalledTimes(1);
    expect(d.mailer.send.mock.calls[0]![0]).toMatchObject({
      email: "owner@example.com",
      kind: "reset",
      at: expect.any(Date),
    });
    expect(Object.keys(d.mailer.send.mock.calls[0]![0]).sort()).toEqual(["at", "email", "kind"]);
  });

  it("a phone-only account gets no notice and the skip log carries only the payer prefix", async () => {
    const d = setup(payerRow({ emailEnc: null }));
    const log = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await d.svc.notify(payerRow().id, "changed");
      expect(d.mailer.send).not.toHaveBeenCalled();
      expect(d.pii.decrypt).not.toHaveBeenCalled();
      const out = log.mock.calls.map((c) => String(c[0])).join("");
      expect(out).toContain("reason=no_email");
      expect(out).not.toContain("owner@example.com");
    } finally {
      log.mockRestore();
    }
  });

  it("a mail failure is swallowed — a committed credential change never rolls back", async () => {
    const d = setup();
    d.mailer.send.mockRejectedValueOnce(new Error("provider down"));
    await expect(d.svc.notify(payerRow().id, "revoked")).resolves.toBeUndefined();
  });

  it("a decrypt failure is swallowed and the ciphertext never reaches the log", async () => {
    const d = setup();
    d.pii.decrypt.mockImplementationOnce(() => {
      throw new Error("gcm auth failed for email-enc");
    });
    const log = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await expect(d.svc.notify(payerRow().id, "changed")).resolves.toBeUndefined();
      const out = log.mock.calls.map((c) => String(c[0])).join("");
      expect(out).not.toContain("email-enc");
    } finally {
      log.mockRestore();
    }
  });
});

describe("EmailPayerSecurityNoticeMailer copy (#2563)", () => {
  it("renders setup/reset/revoked/changed in the plain owner-ruling copy and never a secret", async () => {
    const email = { send: vi.fn(async (_message: unknown) => undefined) };
    const mailer = new EmailPayerSecurityNoticeMailer(email as never);
    const at = new Date("2026-11-04T09:15:00.000Z");
    for (const kind of ["setup", "reset", "revoked", "changed"] as const) {
      await mailer.send({ email: "owner@example.com", kind, at });
      const message = email.send.mock.calls.at(-1)![0] as {
        text: string;
        subject: string;
        purpose: string;
        principal: string;
      };
      const verb = kind === "setup" ? "set up" : kind;
      expect(message.text).toContain(`was ${verb} on`);
      // A "setup" notice must not claim the password was CHANGED.
      expect(message.subject).toContain(`was ${verb}`);
      expect(message.text).toContain("IST");
      expect(message.text).toContain("If this wasn't you, contact BadaBhai support.");
      expect(message.text).not.toContain("Xk7mPq2rTn9wZa"); // no password shape
      expect(message.purpose).toBe("security_notice");
      expect(message.principal).toBe("payer");
      expect(message.subject).not.toContain("owner@example.com");
    }
  });
});
