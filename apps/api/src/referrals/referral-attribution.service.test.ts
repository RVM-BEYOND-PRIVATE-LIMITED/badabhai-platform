import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ReferralAttributionService } from "./referral-attribution.service";
import type { ConsentRepository } from "../consent/consent.repository";
import type { InviteService } from "../messaging/invite.service";
import type { AgencyService } from "../agency/agency.service";

const WORKER = "44444444-4444-4444-8444-444444444444";
const CODE = "abcdef012345";

/** An ACTIVE consent row (only the fields the service reads matter). */
const activeConsent = { revokedAt: null } as never;
const revokedConsent = { revokedAt: new Date() } as never;

function make() {
  const consent = { findLatestByWorker: vi.fn() };
  const workerInvites = { recordAccept: vi.fn() };
  const agency = { attributeWorkerToInvite: vi.fn() };
  const svc = new ReferralAttributionService(
    consent as unknown as ConsentRepository,
    workerInvites as unknown as InviteService,
    agency as unknown as AgencyService,
  );
  return { svc, consent, workerInvites, agency };
}

describe("ReferralAttributionService — consent gate (invariant #6, fail-closed)", () => {
  let h: ReturnType<typeof make>;
  beforeEach(() => (h = make()));

  it("NO active consent → no-op, NEITHER seam is called, no attribution", async () => {
    h.consent.findLatestByWorker.mockResolvedValue(undefined);
    const out = await h.svc.attribute(CODE, WORKER);
    expect(out).toEqual({ attributed: false, kind: "none", reason: "no_consent" });
    expect(h.workerInvites.recordAccept).not.toHaveBeenCalled();
    expect(h.agency.attributeWorkerToInvite).not.toHaveBeenCalled();
  });

  it("REVOKED consent → no-op, neither seam called", async () => {
    h.consent.findLatestByWorker.mockResolvedValue(revokedConsent);
    const out = await h.svc.attribute(CODE, WORKER);
    expect(out.attributed).toBe(false);
    expect(out.reason).toBe("no_consent");
    expect(h.workerInvites.recordAccept).not.toHaveBeenCalled();
    expect(h.agency.attributeWorkerToInvite).not.toHaveBeenCalled();
  });
});

describe("ReferralAttributionService — namespace dispatch (worker first, agency fallback)", () => {
  let h: ReturnType<typeof make>;
  beforeEach(() => {
    h = make();
    h.consent.findLatestByWorker.mockResolvedValue(activeConsent);
  });

  it("worker invite attributes → kind:worker, agency NEVER tried", async () => {
    h.workerInvites.recordAccept.mockResolvedValue({ ok: true });
    const out = await h.svc.attribute(CODE, WORKER);
    expect(out).toEqual({ attributed: true, kind: "worker" });
    expect(h.workerInvites.recordAccept).toHaveBeenCalledWith(CODE, WORKER);
    expect(h.agency.attributeWorkerToInvite).not.toHaveBeenCalled();
  });

  it("unknown to worker table → falls through to agency, which attributes → kind:agency", async () => {
    h.workerInvites.recordAccept.mockResolvedValue({ ok: false, reason: "unknown_code" });
    h.agency.attributeWorkerToInvite.mockResolvedValue({ ok: true });
    const out = await h.svc.attribute(CODE, WORKER);
    expect(out).toEqual({ attributed: true, kind: "agency" });
    expect(h.agency.attributeWorkerToInvite).toHaveBeenCalledWith(CODE, WORKER);
  });

  it("KNOWN worker invite that can't attribute (self_invite) is TERMINAL — agency NOT tried", async () => {
    h.workerInvites.recordAccept.mockResolvedValue({ ok: false, reason: "self_invite" });
    const out = await h.svc.attribute(CODE, WORKER);
    expect(out).toEqual({ attributed: false, kind: "worker", reason: "self_invite" });
    expect(h.agency.attributeWorkerToInvite).not.toHaveBeenCalled();
  });

  it("already-attributed worker invite is TERMINAL — agency NOT tried", async () => {
    h.workerInvites.recordAccept.mockResolvedValue({ ok: false, reason: "already_attributed" });
    const out = await h.svc.attribute(CODE, WORKER);
    expect(out.kind).toBe("worker");
    expect(out.attributed).toBe(false);
    expect(h.agency.attributeWorkerToInvite).not.toHaveBeenCalled();
  });

  it("unknown to BOTH tables → neutral no-op kind:none", async () => {
    h.workerInvites.recordAccept.mockResolvedValue({ ok: false, reason: "unknown_code" });
    h.agency.attributeWorkerToInvite.mockResolvedValue({ ok: false, reason: "unknown_code" });
    const out = await h.svc.attribute(CODE, WORKER);
    expect(out).toEqual({ attributed: false, kind: "none", reason: "unknown_code" });
  });

  it("agency declines on no_consent (its own re-check) → neutral no-op", async () => {
    h.workerInvites.recordAccept.mockResolvedValue({ ok: false, reason: "unknown_code" });
    h.agency.attributeWorkerToInvite.mockResolvedValue({ ok: false, reason: "no_consent" });
    const out = await h.svc.attribute(CODE, WORKER);
    expect(out.attributed).toBe(false);
    expect(out.kind).toBe("none");
  });
});

describe("ReferralAttributionService — fail-safe (never throws to the caller)", () => {
  it("a seam throwing is neutralized to a no-op, not propagated", async () => {
    const h = make();
    h.consent.findLatestByWorker.mockResolvedValue(activeConsent);
    h.workerInvites.recordAccept.mockRejectedValue(new Error("db down"));
    const out = await h.svc.attribute(CODE, WORKER);
    expect(out).toEqual({ attributed: false, kind: "none", reason: "error" });
  });

  it("a consent-read failure is neutralized (no throw)", async () => {
    const h = make();
    h.consent.findLatestByWorker.mockRejectedValue(new Error("db down"));
    const out = await h.svc.attribute(CODE, WORKER);
    expect(out.attributed).toBe(false);
    expect(out.reason).toBe("error");
  });
});
