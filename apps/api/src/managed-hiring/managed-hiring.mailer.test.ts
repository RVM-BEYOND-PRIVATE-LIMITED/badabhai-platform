/**
 * #2751 items 9 and 13 — the company's emails: one per order change, every one carrying the terms
 * line, none promising a hire; a phone-only login is skipped; a failure never throws.
 */
import { describe, expect, it, vi } from "vitest";

import {
  ManagedHiringMailer,
  composeManagedHiringNotice,
  type ManagedHiringNoticeKind,
} from "./managed-hiring.mailer";

const KINDS: ManagedHiringNoticeKind[] = ["activated", "met", "extended", "closed_unmet"];
const DUE = new Date("2026-11-30T18:30:00.000Z"); // the start of 1 Dec IST = the end of 30 Nov

describe("composeManagedHiringNotice", () => {
  it.each(KINDS)("%s: no hire promise anywhere", (kind) => {
    const { subject, lines } = composeManagedHiringNotice({
      kind,
      confirmedCount: 4,
      targetCount: 5,
      until: DUE,
    });
    const text = [subject, ...lines].join(" ").toLowerCase();
    expect(text).not.toMatch(
      /guarantee|assured|you will hire|we will hire|hire is certain|placement is certain/,
    );
    expect(text).not.toMatch(/\bhired\b/);
  });

  it("names the deadline as the last IST day it covers", () => {
    const { lines } = composeManagedHiringNotice({
      kind: "activated",
      confirmedCount: 0,
      targetCount: 5,
      until: DUE,
    });
    // ICU spells it "Mon, 30 Nov, 2026" or "Mon 30 Nov 2026" depending on the Node build.
    expect(lines.join(" ")).toMatch(/30 Nov,? 2026/);
  });

  it("met says the contacts cost no credits; extended says no charge", () => {
    expect(
      composeManagedHiringNotice({
        kind: "met",
        confirmedCount: 5,
        targetCount: 5,
        until: null,
      }).lines.join(" "),
    ).toContain("costs you no credits");
    expect(
      composeManagedHiringNotice({
        kind: "extended",
        confirmedCount: 4,
        targetCount: 5,
        until: DUE,
      }).subject,
    ).toContain("no charge");
  });
});

describe("ManagedHiringMailer", () => {
  const notice = { kind: "met" as const, confirmedCount: 5, targetCount: 5, until: null };

  it("sends to the buyer's email, with the terms line, under its own purpose", async () => {
    const send = vi.fn(async () => undefined);
    const mailer = new ManagedHiringMailer(
      { findById: async () => ({ emailEnc: "enc" }) } as never,
      { decrypt: () => "owner@example.com" } as never,
      { send } as never,
    );
    await mailer.notify("payer-1", "order-1", notice);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "owner@example.com",
        principal: "payer",
        purpose: "managed_hiring_update",
        text: expect.stringContaining("BadaBhai does not promise a hire."),
      }),
    );
  });

  it("skips a phone-only login, and swallows a send failure", async () => {
    const send = vi.fn(async () => {
      throw new Error("provider down");
    });
    const phoneOnly = new ManagedHiringMailer(
      { findById: async () => ({ emailEnc: null }) } as never,
      { decrypt: () => "x" } as never,
      { send } as never,
    );
    await phoneOnly.notify("payer-1", "order-1", notice);
    expect(send).not.toHaveBeenCalled();
    const failing = new ManagedHiringMailer(
      { findById: async () => ({ emailEnc: "enc" }) } as never,
      { decrypt: () => "owner@example.com" } as never,
      { send } as never,
    );
    await expect(failing.notify("payer-1", "order-1", notice)).resolves.toBeUndefined();
  });
});
