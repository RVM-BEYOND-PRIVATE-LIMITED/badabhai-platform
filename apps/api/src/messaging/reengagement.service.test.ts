import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import type { Database } from "@badabhai/db";
import type { EventsService } from "../events/events.service";
import type { PiiCryptoService } from "../common/pii-crypto.service";
import type { MessagingConsentService } from "./messaging-consent.service";
import type { WhatsAppProvider } from "./whatsapp.provider";
import { ReengagementService } from "./reengagement.service";

const PHONE = "+919876500000";

/** db.select().from().where().limit() → the given rows. */
function dbReturning(rows: unknown[]): Database {
  return {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => rows }) }) }),
  } as unknown as Database;
}

function harness(opts: { consent: boolean; rows: unknown[]; sendThrows?: boolean }) {
  const emit = vi.fn().mockResolvedValue(undefined);
  const send = vi.fn(
    opts.sendThrows
      ? () => Promise.reject(new Error("provider boom"))
      : async () => ({ providerMessageId: "mock-1", realCall: false }),
  );
  const svc = new ReengagementService(
    dbReturning(opts.rows),
    { hasWhatsAppConsent: vi.fn().mockResolvedValue(opts.consent) } as unknown as MessagingConsentService,
    { emit } as unknown as EventsService,
    { decrypt: vi.fn().mockReturnValue(PHONE) } as unknown as PiiCryptoService,
    { send } as unknown as WhatsAppProvider,
  );
  const emittedNames = () => emit.mock.calls.map((c) => (c[0] as { event_name: string }).event_name);
  return { svc, emit, send, emittedNames };
}

describe("ReengagementService — consent-gated, PII-free (ADR-0020)", () => {
  it("NO consent → suppressed(no_consent), provider NEVER called", async () => {
    const h = harness({ consent: false, rows: [{ id: "w1", phoneE164: "ct" }] });
    const r = await h.svc.sendReengagement("w1", "reengage_v1");
    expect(r).toEqual({ sent: false, reason: "no_consent" });
    expect(h.send).not.toHaveBeenCalled();
    expect(h.emittedNames()).toEqual(["messaging.suppressed"]);
  });

  it("unknown worker → suppressed(unknown_worker), provider NEVER called", async () => {
    const h = harness({ consent: true, rows: [] });
    const r = await h.svc.sendReengagement("w1", "reengage_v1");
    expect(r.reason).toBe("unknown_worker");
    expect(h.send).not.toHaveBeenCalled();
    expect(h.emittedNames()).toEqual(["messaging.suppressed"]);
  });

  it("consented + found → provider gets the RAW phone; requested+sent emitted", async () => {
    const h = harness({ consent: true, rows: [{ id: "w1", phoneE164: "ct" }] });
    const r = await h.svc.sendReengagement("w1", "reengage_v1");
    expect(r.sent).toBe(true);
    expect(h.send).toHaveBeenCalledWith({ phoneE164: PHONE, template: "reengage_v1", workerId: "w1" });
    expect(h.emittedNames()).toEqual(["messaging.requested", "messaging.sent"]);
  });

  it("the raw phone NEVER appears in ANY emitted event payload (PII-free)", async () => {
    const h = harness({ consent: true, rows: [{ id: "w1", phoneE164: "ct" }] });
    await h.svc.sendReengagement("w1", "reengage_v1");
    const blob = JSON.stringify(h.emit.mock.calls);
    expect(blob).not.toContain(PHONE);
    expect(blob).not.toContain("9876500000");
  });

  it("provider failure → messaging.failed (sent=false), still no phone in events", async () => {
    const h = harness({ consent: true, rows: [{ id: "w1", phoneE164: "ct" }], sendThrows: true });
    const r = await h.svc.sendReengagement("w1", "reengage_v1");
    expect(r).toMatchObject({ sent: false, reason: "provider_error" });
    expect(h.emittedNames()).toEqual(["messaging.requested", "messaging.failed"]);
    expect(JSON.stringify(h.emit.mock.calls)).not.toContain(PHONE);
  });
});
