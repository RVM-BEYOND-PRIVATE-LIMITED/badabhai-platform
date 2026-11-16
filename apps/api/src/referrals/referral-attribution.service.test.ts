import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ReferralAttributionService } from "./referral-attribution.service";
import type { ConsentRepository } from "../consent/consent.repository";
import type { InviteService } from "../messaging/invite.service";
import type { AgencyService } from "../agency/agency.service";
import type { ReferralLinkService } from "./referral-link.service";
import type { WorkerOriginRepository } from "./worker-origin.repository";

const WORKER = "44444444-4444-4444-8444-444444444444";
const CODE = "abcdef012345";

/** An ACTIVE consent row (only the fields the service reads matter). */
const activeConsent = { revokedAt: null } as never;
const revokedConsent = { revokedAt: new Date() } as never;

function make() {
  const consent = { findLatestByWorker: vi.fn() };
  const workerInvites = { recordAccept: vi.fn() };
  const agency = { attributeWorkerToInvite: vi.fn() };
  // B4: the first-touch claim. Defaults to "nothing to claim" (no click row), which is
  // exactly the LEGACY situation — every invite shared before the resolver existed. The
  // assertions below therefore also pin that B4 did not change legacy attribution.
  const referralLinks = { claimInstall: vi.fn().mockResolvedValue({ claimed: false }) };
  // #2753 item 12 — the came-from write. Defaults to "wrote the row".
  const origins = { recordFirst: vi.fn().mockResolvedValue(true) };
  const svc = new ReferralAttributionService(
    consent as unknown as ConsentRepository,
    workerInvites as unknown as InviteService,
    agency as unknown as AgencyService,
    referralLinks as unknown as ReferralLinkService,
    origins as unknown as WorkerOriginRepository,
  );
  return { svc, consent, workerInvites, agency, referralLinks, origins };
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

  /**
   * THE B4 CLAIM IS BEHIND THE SAME GATE — and this test exists because it caught a real
   * hole. A mutation that hoisted `claimInstall` ABOVE the consent check left the entire
   * suite green: the two assertions above only cover the two legacy seams, so the newest
   * write path was silently exempt from invariant #6.
   *
   * The claim WRITES (it stamps `claimed_by_worker_id` on a click row and emits
   * `referral.install_claimed`), so running it pre-consent would attribute a worker who has
   * not consented to being processed — exactly what the DPDP gate forbids. Fail-closed:
   * no consent, no claim.
   */
  it("NO consent → the B4 first-touch claim is NOT attempted either (invariant #6, fail-closed)", async () => {
    h.consent.findLatestByWorker.mockResolvedValue(undefined);
    await h.svc.attribute(CODE, WORKER);
    expect(h.referralLinks.claimInstall).not.toHaveBeenCalled();
  });

  it("REVOKED consent → the B4 first-touch claim is NOT attempted either", async () => {
    h.consent.findLatestByWorker.mockResolvedValue(revokedConsent);
    await h.svc.attribute(CODE, WORKER);
    expect(h.referralLinks.claimInstall).not.toHaveBeenCalled();
  });

  it("ACTIVE consent → the claim IS attempted, and only after the gate passed", async () => {
    h.consent.findLatestByWorker.mockResolvedValue(activeConsent);
    h.workerInvites.recordAccept.mockResolvedValue({ ok: true });
    await h.svc.attribute(CODE, WORKER, "install_referrer");
    expect(h.referralLinks.claimInstall).toHaveBeenCalledWith({
      code: CODE,
      workerId: WORKER,
      source: "install_referrer",
    });
    // Ordering, pinned directly: the consent read resolved before the claim was invoked.
    const consentOrder = h.consent.findLatestByWorker.mock.invocationCallOrder[0]!;
    const claimOrder = h.referralLinks.claimInstall.mock.invocationCallOrder[0]!;
    expect(consentOrder).toBeLessThan(claimOrder);
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
    expect(out).toEqual({ attributed: true, kind: "worker", claimed: false });
    expect(h.workerInvites.recordAccept).toHaveBeenCalledWith(CODE, WORKER, "unknown");
    expect(h.agency.attributeWorkerToInvite).not.toHaveBeenCalled();
  });

  it("unknown to worker table → falls through to agency, which attributes → kind:agency", async () => {
    h.workerInvites.recordAccept.mockResolvedValue({ ok: false, reason: "unknown_code" });
    h.agency.attributeWorkerToInvite.mockResolvedValue({ ok: true });
    const out = await h.svc.attribute(CODE, WORKER);
    expect(out).toEqual({ attributed: true, kind: "agency", claimed: false });
    expect(h.agency.attributeWorkerToInvite).toHaveBeenCalledWith(CODE, WORKER, "unknown");
  });

  // ---- B4: the install `source` reaches whichever seam attributes ----

  it("threads the source to the WORKER seam", async () => {
    h.workerInvites.recordAccept.mockResolvedValue({ ok: true });
    await h.svc.attribute(CODE, WORKER, "app_link");
    expect(h.workerInvites.recordAccept).toHaveBeenCalledWith(CODE, WORKER, "app_link");
  });

  it("threads the source to the AGENCY seam on fall-through", async () => {
    h.workerInvites.recordAccept.mockResolvedValue({ ok: false, reason: "unknown_code" });
    h.agency.attributeWorkerToInvite.mockResolvedValue({ ok: true });
    await h.svc.attribute(CODE, WORKER, "custom_scheme");
    expect(h.agency.attributeWorkerToInvite).toHaveBeenCalledWith(CODE, WORKER, "custom_scheme");
  });

  it("KNOWN worker invite that can't attribute (self_invite) is TERMINAL — agency NOT tried", async () => {
    h.workerInvites.recordAccept.mockResolvedValue({ ok: false, reason: "self_invite" });
    const out = await h.svc.attribute(CODE, WORKER);
    expect(out).toEqual({
      attributed: false,
      kind: "worker",
      reason: "self_invite",
      claimed: false,
    });
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
    expect(out).toEqual({
      attributed: false,
      kind: "none",
      reason: "unknown_code",
      claimed: false,
    });
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

/**
 * #1800 — A RÉSUMÉ-QR CODE NEVER REACHES A PAYING SEAM.
 *
 * Its attribution IS the first-touch claim (`referral.install_claimed` names the link, and the
 * link names the worker whose sheet was scanned). It is never commissioned, so the hook must stop
 * BEFORE `recordAccept` (the worker bonus's input) and `attributeWorkerToInvite` (the agency
 * commission's) — including when the SAME code also exists in one of those tables, which is the
 * cross-space collision this ordering exists to make harmless.
 */
describe("ReferralAttributionService — #1800 résumé-QR codes stop before invites and agency", () => {
  let h: ReturnType<typeof make>;
  beforeEach(() => {
    h = make();
    h.consent.findLatestByWorker.mockResolvedValue(activeConsent);
    // The collision case: BOTH legacy seams would attribute this code if they were asked.
    h.workerInvites.recordAccept.mockResolvedValue({ ok: true });
    h.agency.attributeWorkerToInvite.mockResolvedValue({ ok: true });
  });

  it("a CLAIMED résumé-QR install is attributed as resume_qr — and neither seam is called", async () => {
    h.referralLinks.claimInstall.mockResolvedValue({
      claimed: true,
      referralLinkId: "11111111-1111-4111-8111-111111111111",
      linkKind: "resume_qr",
    });
    const out = await h.svc.attribute(CODE, WORKER, "install_referrer");
    expect(out).toEqual({ attributed: true, kind: "resume_qr", claimed: true });
    expect(h.workerInvites.recordAccept).not.toHaveBeenCalled();
    expect(h.agency.attributeWorkerToInvite).not.toHaveBeenCalled();
  });

  it.each([
    "self_claim",
    "dead_link",
    "already_claimed",
    "unknown_code",
    "outside_window",
  ] as const)(
    "an UNCLAIMED résumé-QR code (%s) is terminal too — never a fall-through to a paying seam",
    async (reason) => {
      h.referralLinks.claimInstall.mockResolvedValue({
        claimed: false,
        reason,
        linkKind: "resume_qr",
      });
      const out = await h.svc.attribute(CODE, WORKER);
      expect(out).toEqual({ attributed: false, kind: "resume_qr", reason, claimed: false });
      expect(h.workerInvites.recordAccept).not.toHaveBeenCalled();
      expect(h.agency.attributeWorkerToInvite).not.toHaveBeenCalled();
    },
  );

  it.each(["agent", "worker", "campaign", null] as const)(
    "every OTHER kind (%s) still reaches the legacy seams exactly as before",
    async (linkKind) => {
      h.referralLinks.claimInstall.mockResolvedValue({ claimed: false, linkKind });
      const out = await h.svc.attribute(CODE, WORKER);
      expect(out.kind).toBe("worker");
      expect(h.workerInvites.recordAccept).toHaveBeenCalledOnce();
    },
  );
});

/**
 * #2753 item 12 — CAME-FROM. A SUCCESSFUL attribution writes the worker's `worker_origins` row
 * (`referrer` for a worker's invite, `partner` for an agency's, ref = the code); a refused or
 * neutral one writes nothing; a failed origin write never changes the outcome. First-origin-wins
 * is the repository's `ON CONFLICT DO NOTHING`, pinned against Postgres in
 * `referral-came-from.db.test.ts`.
 */
describe("ReferralAttributionService — came-from on a successful attribution (#2753 item 12)", () => {
  let h: ReturnType<typeof make>;
  beforeEach(() => {
    h = make();
    h.consent.findLatestByWorker.mockResolvedValue(activeConsent);
  });

  it("a worker's invite attributes → one `referrer` origin with the code, AFTER the seam said yes", async () => {
    h.workerInvites.recordAccept.mockResolvedValue({ ok: true });
    const out = await h.svc.attribute(CODE, WORKER);
    expect(out).toEqual({ attributed: true, kind: "worker", claimed: false });
    expect(h.origins.recordFirst).toHaveBeenCalledOnce();
    expect(h.origins.recordFirst).toHaveBeenCalledWith(WORKER, "referrer", CODE);
    expect(h.workerInvites.recordAccept.mock.invocationCallOrder[0]!).toBeLessThan(
      h.origins.recordFirst.mock.invocationCallOrder[0]!,
    );
  });

  it("an agency's invite attributes → one `partner` origin with the code", async () => {
    h.workerInvites.recordAccept.mockResolvedValue({ ok: false, reason: "unknown_code" });
    h.agency.attributeWorkerToInvite.mockResolvedValue({ ok: true });
    const out = await h.svc.attribute(CODE, WORKER);
    expect(out).toEqual({ attributed: true, kind: "agency", claimed: false });
    expect(h.origins.recordFirst).toHaveBeenCalledOnce();
    expect(h.origins.recordFirst).toHaveBeenCalledWith(WORKER, "partner", CODE);
  });

  it.each([
    ["no consent", () => h.consent.findLatestByWorker.mockResolvedValue(undefined)],
    ["revoked consent", () => h.consent.findLatestByWorker.mockResolvedValue(revokedConsent)],
    [
      "a self invite",
      () => h.workerInvites.recordAccept.mockResolvedValue({ ok: false, reason: "self_invite" }),
    ],
    [
      "an already-attributed worker invite",
      () =>
        h.workerInvites.recordAccept.mockResolvedValue({ ok: false, reason: "already_attributed" }),
    ],
    [
      "an unknown code (both seams)",
      () => {
        h.workerInvites.recordAccept.mockResolvedValue({ ok: false, reason: "unknown_code" });
        h.agency.attributeWorkerToInvite.mockResolvedValue({ ok: false, reason: "unknown_code" });
      },
    ],
    [
      "an already-attributed agency invite",
      () => {
        h.workerInvites.recordAccept.mockResolvedValue({ ok: false, reason: "unknown_code" });
        h.agency.attributeWorkerToInvite.mockResolvedValue({
          ok: false,
          reason: "already_attributed",
        });
      },
    ],
    ["a seam failure", () => h.workerInvites.recordAccept.mockRejectedValue(new Error("db down"))],
  ])("%s → no origin is written", async (_name, arrange) => {
    arrange();
    const out = await h.svc.attribute(CODE, WORKER);
    expect(out.attributed).toBe(false);
    expect(h.origins.recordFirst).not.toHaveBeenCalled();
  });

  it("a claimed résumé-QR install writes no origin (not a partner or referrer code, #1800)", async () => {
    h.referralLinks.claimInstall.mockResolvedValue({
      claimed: true,
      referralLinkId: "11111111-1111-4111-8111-111111111111",
      linkKind: "resume_qr",
    });
    const out = await h.svc.attribute(CODE, WORKER, "install_referrer");
    expect(out).toEqual({ attributed: true, kind: "resume_qr", claimed: true });
    expect(h.origins.recordFirst).not.toHaveBeenCalled();
  });

  it("an origin he already has (first origin wins) leaves the outcome unchanged", async () => {
    h.workerInvites.recordAccept.mockResolvedValue({ ok: true });
    h.origins.recordFirst.mockResolvedValue(false);
    const out = await h.svc.attribute(CODE, WORKER);
    expect(out).toEqual({ attributed: true, kind: "worker", claimed: false });
  });

  it("a FAILED origin write is neutralized: the attribution stays attributed, nothing throws", async () => {
    h.workerInvites.recordAccept.mockResolvedValue({ ok: false, reason: "unknown_code" });
    h.agency.attributeWorkerToInvite.mockResolvedValue({ ok: true });
    const err = new Error('relation "worker_origins" does not exist');
    err.name = "PostgresError";
    h.origins.recordFirst.mockRejectedValue(err);
    const out = await h.svc.attribute(CODE, WORKER);
    expect(out).toEqual({ attributed: true, kind: "agency", claimed: false });
  });
});
