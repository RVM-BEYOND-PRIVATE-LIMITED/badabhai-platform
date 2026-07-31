import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ReferralBonusService } from "./referral-bonus.service";
import type { ReferralBonusRepository } from "./referral-bonus.repository";
import type { EventsService } from "../events/events.service";

const INVITER = "11111111-1111-4111-8111-111111111111";
const INVITED = "22222222-2222-4222-8222-222222222222";
const INVITE_ID = "33333333-3333-4333-8333-333333333333";
const ACCRUAL_ID = "44444444-4444-4444-8444-444444444444";

/** Every gate OPEN by default — each test closes exactly the one it is about. */
function make(overrides: Partial<Record<keyof ReferralBonusRepository, unknown>> = {}) {
  const emit = vi.fn().mockResolvedValue(undefined);
  const repo = {
    findAttributingInvite: vi
      .fn()
      .mockResolvedValue({ inviteId: INVITE_ID, inviterWorkerId: INVITER }),
    findAccrualByInvitedWorker: vi.fn().mockResolvedValue(undefined),
    hasConfirmedProfile: vi.fn().mockResolvedValue(true),
    hasGrantedUnlock: vi.fn().mockResolvedValue(true),
    sharesPhoneHash: vi.fn().mockResolvedValue(false),
    phoneAlreadyEarned: vi.fn().mockResolvedValue(false),
    accrue: vi.fn().mockResolvedValue({
      id: ACCRUAL_ID,
      inviterWorkerId: INVITER,
      invitedWorkerId: INVITED,
      amountInr: 20,
      qualifiedAt: new Date(),
    }),
    totals: vi.fn().mockResolvedValue({ accrual_count: 3, total_inr: 60 }),
    ...overrides,
  } as unknown as ReferralBonusRepository;
  const svc = new ReferralBonusService(repo, { emit } as unknown as EventsService);
  return { svc, repo, emit };
}

describe("ReferralBonusService — the X.6 rule: profile complete AND unlocked", () => {
  let h: ReturnType<typeof make>;
  beforeEach(() => (h = make()));

  it("accrues ₹20 exactly once when BOTH legs hold, and emits referral.bonus_accrued", async () => {
    const out = await h.svc.evaluate(INVITED);
    expect(out).toEqual({ accrued: true, accrual_id: ACCRUAL_ID, amount_inr: 20 });

    const call = h.emit.mock.calls[0]![0] as {
      event_name: string;
      subject: { subject_type: string; subject_id: string };
      payload: Record<string, unknown>;
      idempotencyKey: string;
    };
    expect(call.event_name).toBe("referral.bonus_accrued");
    expect(call.subject).toEqual({ subject_type: "referral_bonus", subject_id: ACCRUAL_ID });
    expect(call.payload).toEqual({
      accrual_id: ACCRUAL_ID,
      inviter_worker_id: INVITER,
      invited_worker_id: INVITED,
      amount_inr: 20,
    });
    // "One bonus per referred worker, EVER" — stated on the spine, not just in the DB.
    expect(call.idempotencyKey).toBe(`referral.bonus_accrued:${INVITED}`);
  });

  it("does NOT accrue when the profile is not CONFIRMED (never on click/install/upload)", async () => {
    const { svc, repo, emit } = make({ hasConfirmedProfile: vi.fn().mockResolvedValue(false) });
    expect(await svc.evaluate(INVITED)).toEqual({ accrued: false, reason: "profile_incomplete" });
    expect(repo.accrue).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("does NOT accrue when NOBODY has been granted an unlock — the leg fraud cannot fake", async () => {
    const { svc, repo, emit } = make({ hasGrantedUnlock: vi.fn().mockResolvedValue(false) });
    expect(await svc.evaluate(INVITED)).toEqual({ accrued: false, reason: "not_unlocked" });
    expect(repo.accrue).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("checks the unlock leg only AFTER the profile leg (cheap-first, no wasted reads)", async () => {
    const { svc, repo } = make({ hasConfirmedProfile: vi.fn().mockResolvedValue(false) });
    await svc.evaluate(INVITED);
    expect(repo.hasGrantedUnlock).not.toHaveBeenCalled();
  });
});

describe("ReferralBonusService — fraud disqualification", () => {
  it("refuses when inviter and invited share a PHONE HASH (the second-handset farm)", async () => {
    const { svc, repo, emit } = make({ sharesPhoneHash: vi.fn().mockResolvedValue(true) });
    expect(await svc.evaluate(INVITED)).toEqual({ accrued: false, reason: "duplicate_phone" });
    expect(repo.accrue).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("refuses when the invited PHONE already earned a bonus under another worker row", async () => {
    const { svc, repo } = make({ phoneAlreadyEarned: vi.fn().mockResolvedValue(true) });
    expect(await svc.evaluate(INVITED)).toEqual({ accrued: false, reason: "duplicate_phone" });
    expect(repo.accrue).not.toHaveBeenCalled();
  });

  it("refuses a SELF-referral (fail-closed assertion of the rule InviteService owns)", async () => {
    const { svc, repo } = make({
      findAttributingInvite: vi
        .fn()
        .mockResolvedValue({ inviteId: INVITE_ID, inviterWorkerId: INVITED }),
    });
    expect(await svc.evaluate(INVITED)).toEqual({ accrued: false, reason: "self_referral" });
    expect(repo.accrue).not.toHaveBeenCalled();
  });

  it("refuses when the worker was never referred, or the inviter was DSAR-erased", async () => {
    const none = make({ findAttributingInvite: vi.fn().mockResolvedValue(undefined) });
    expect(await none.svc.evaluate(INVITED)).toEqual({ accrued: false, reason: "no_referral" });

    const erased = make({
      findAttributingInvite: vi
        .fn()
        .mockResolvedValue({ inviteId: INVITE_ID, inviterWorkerId: null }),
    });
    expect(await erased.svc.evaluate(INVITED)).toEqual({
      accrued: false,
      reason: "inviter_unavailable",
    });
    expect(erased.emit).not.toHaveBeenCalled(); // never a payload with a null uuid
  });

  it("never logs an id — a 'worker X: duplicate_phone' line is itself a relationship claim", async () => {
    const { svc } = make({ sharesPhoneHash: vi.fn().mockResolvedValue(true) });
    const log = vi.spyOn(
      (svc as unknown as { logger: { log: (m: string) => void } }).logger,
      "log",
    );
    await svc.evaluate(INVITED);
    expect(log).toHaveBeenCalled();
    for (const call of log.mock.calls) {
      const line = String(call[0]);
      expect(line).toContain("duplicate_phone");
      expect(line).not.toContain(INVITED);
      expect(line).not.toContain(INVITER);
    }
  });
});

describe("ReferralBonusService — idempotency is the DATABASE's", () => {
  it("short-circuits when an accrual already exists for the referred worker", async () => {
    const { svc, repo, emit } = make({
      findAccrualByInvitedWorker: vi.fn().mockResolvedValue({ id: ACCRUAL_ID }),
    });
    expect(await svc.evaluate(INVITED)).toEqual({ accrued: false, reason: "already_accrued" });
    expect(repo.accrue).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("emits NOTHING when the UNIQUE insert loses the race (no row back ⇒ no event)", async () => {
    // The read-then-write check above can be raced; the ON CONFLICT DO NOTHING insert cannot.
    const { svc, emit } = make({ accrue: vi.fn().mockResolvedValue(undefined) });
    expect(await svc.evaluate(INVITED)).toEqual({ accrued: false, reason: "already_accrued" });
    expect(emit).not.toHaveBeenCalled();
  });

  it("accrues the ₹20 constant, in whole rupees", async () => {
    const { svc, repo } = make();
    await svc.evaluate(INVITED);
    expect(ReferralBonusService.BONUS_INR).toBe(20);
    expect(repo.accrue).toHaveBeenCalledWith(
      expect.objectContaining({
        inviterWorkerId: INVITER,
        invitedWorkerId: INVITED,
        amountInr: 20,
      }),
    );
  });

  it("exposes ops totals as aggregates only (counts + rupees, no ids)", async () => {
    const { svc } = make();
    expect(await svc.totals()).toEqual({
      accrual_count: 3,
      total_inr: 60,
      amount_inr_per_referral: 20,
    });
  });
});
