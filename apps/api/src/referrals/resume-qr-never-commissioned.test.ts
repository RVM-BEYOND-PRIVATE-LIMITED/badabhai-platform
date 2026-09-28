import "reflect-metadata";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  isCommissionedLinkKind,
  NON_COMMISSIONED_REFERRAL_LINK_KINDS,
  REFERRAL_LINK_KINDS,
} from "@badabhai/types";
import type { ConsentRepository } from "../consent/consent.repository";
import type { InviteService } from "../messaging/invite.service";
import type { AgencyService } from "../agency/agency.service";
import type { EventsService } from "../events/events.service";
import { ReferralAttributionService } from "./referral-attribution.service";
import type { ReferralBonusRepository } from "./referral-bonus.repository";
import { ReferralBonusService } from "./referral-bonus.service";
import type { ReferralLinkService } from "./referral-link.service";

/**
 * #1800 — A RÉSUMÉ-QR SIGNUP NEVER PAYS ANYONE (owner ruling 2026-09-28: "no referral bonus, ever").
 *
 * Two halves, because the rule rests on two facts and either could drift on its own:
 *  1. BEHAVIOUR — a worker whose install is claimed through a `resume_qr` link is never written as
 *     anyone's invitee, so the ₹20 bonus's evaluation answers `no_referral`. Run through the REAL
 *     attribution and bonus services over one shared in-memory `invites` table.
 *  2. STRUCTURE — money reads only `invites` (the worker bonus) and `agency_invites` (the agency
 *     commission). If a payout ever starts reading `referral_links` / `referral_clicks`, the second
 *     block turns red and names `isCommissionedLinkKind` as the rule it must consult.
 */

const OWNER = "55555555-5555-4555-8555-555555555555";
const SCANNER = "66666666-6666-4666-8666-666666666666";
const INVITER = "77777777-7777-4777-8777-777777777777";
const CODE = "abcdef012345";

describe("a claimed résumé-QR install → ReferralBonusService.evaluate answers no_referral", () => {
  it("even when the SAME code also sits in `invites` (the cross-space collision)", async () => {
    // ONE in-memory `invites` table, shared by the write seam and the bonus's read, holding a
    // pending invite whose code collides with the résumé-QR code.
    const invitesTable = [
      { id: "i1", code: CODE, inviterWorkerId: INVITER, invitedWorkerId: null as string | null },
    ];

    const workerInvites = {
      recordAccept: vi.fn(async (code: string, workerId: string) => {
        const row = invitesTable.find((r) => r.code === code);
        if (!row) return { ok: false, reason: "unknown_code" };
        row.invitedWorkerId = workerId;
        return { ok: true };
      }),
    };
    const attribution = new ReferralAttributionService(
      {
        findLatestByWorker: vi.fn().mockResolvedValue({ revokedAt: null }),
      } as unknown as ConsentRepository,
      workerInvites as unknown as InviteService,
      {
        attributeWorkerToInvite: vi.fn().mockResolvedValue({ ok: true }),
      } as unknown as AgencyService,
      {
        claimInstall: vi.fn().mockResolvedValue({
          claimed: true,
          referralLinkId: "11111111-1111-4111-8111-111111111111",
          linkKind: "resume_qr",
        }),
      } as unknown as ReferralLinkService,
    );

    const attributed = await attribution.attribute(CODE, SCANNER, "install_referrer");
    expect(attributed).toMatchObject({ attributed: true, kind: "resume_qr" });
    expect(workerInvites.recordAccept).not.toHaveBeenCalled();

    // Every OTHER gate open, so the only thing that can refuse is the missing invite.
    const bonusRepo = {
      findAttributingInvite: vi.fn(async (invitedWorkerId: string) => {
        const row = invitesTable.find((r) => r.invitedWorkerId === invitedWorkerId);
        return row ? { inviteId: row.id, inviterWorkerId: row.inviterWorkerId } : undefined;
      }),
      findAccrualByInvitedWorker: vi.fn().mockResolvedValue(undefined),
      hasConfirmedProfile: vi.fn().mockResolvedValue(true),
      hasGrantedUnlock: vi.fn().mockResolvedValue(true),
      sharesPhoneHash: vi.fn().mockResolvedValue(false),
      phoneAlreadyEarned: vi.fn().mockResolvedValue(false),
      accrue: vi.fn(),
      totals: vi.fn(),
    };
    const emit = vi.fn();
    const bonus = new ReferralBonusService(
      bonusRepo as unknown as ReferralBonusRepository,
      { emit } as unknown as EventsService,
    );

    expect(await bonus.evaluate(SCANNER)).toEqual({ accrued: false, reason: "no_referral" });
    expect(bonusRepo.accrue).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
    // The résumé's owner is not an inviter of anyone either.
    expect(invitesTable[0]!.invitedWorkerId).toBeNull();
    expect(await bonus.evaluate(OWNER)).toEqual({ accrued: false, reason: "no_referral" });
  });
});

describe("money reads only invites / agency_invites — never the referral_links space", () => {
  const read = (rel: string): string => readFileSync(join(__dirname, "..", rel), "utf8");

  it.each([
    "referrals/referral-bonus.repository.ts",
    "referrals/referral-bonus.service.ts",
    "agency/agency-payout.repository.ts",
    "agency/agency-payout.service.ts",
  ])("%s names neither referral_links nor referral_clicks", (file) => {
    // If this fails, a payout has started reading the resolver's tables. It MUST then exclude the
    // non-commissioned kinds with `isCommissionedLinkKind` before this pin is relaxed.
    expect(read(file)).not.toMatch(/referralLinks|referralClicks|referral_links|referral_clicks/);
  });

  it("the worker bonus's attribution read is the `invites` table", () => {
    expect(read("referrals/referral-bonus.repository.ts")).toMatch(/\.from\(invites\)/);
  });
});

describe("isCommissionedLinkKind", () => {
  it("resume_qr is the one kind that can never pay", () => {
    expect([...NON_COMMISSIONED_REFERRAL_LINK_KINDS]).toEqual(["resume_qr"]);
    expect(isCommissionedLinkKind("resume_qr")).toBe(false);
    for (const kind of REFERRAL_LINK_KINDS.filter((k) => k !== "resume_qr")) {
      expect(isCommissionedLinkKind(kind), kind).toBe(true);
    }
  });
});
