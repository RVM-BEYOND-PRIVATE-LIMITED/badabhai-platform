import { describe, expect, it } from "vitest";
import { deriveWorkerSkills, workerSkillDeriveInput } from "@badabhai/match-engine";
import { POSTING_TRADE_KINDS, isLevelConfirmed, postingTradeFor } from "@badabhai/taxonomy";
import { isSampleWorkerId } from "./sample-workers";
import {
  PAYER_DEMO_PHONE_PATTERN,
  PAYER_DEMO_TRADES,
  PAYER_DEMO_WORKER_COUNT,
  PER_TRADE_COUNT,
  buildPayerDemoWorkers,
  payerDemoLadder,
  profileSkillsForRoute,
} from "./seed-payer-demo-candidates";

/**
 * #2651 — the payer-demo cohort (480 workers, applied to production 2026-11-03). Importing the
 * seed here is itself a test: its trade table and ladders are evaluated at load time, and a
 * broken one must be a red test, not a dead seed nobody noticed (the #2513 lesson).
 */
const PLAN = buildPayerDemoWorkers();

describe("seed-payer-demo-candidates — the cohort", () => {
  it("is 30 workers for each of exactly the 16 postable trades", () => {
    expect(PLAN).toHaveLength(PAYER_DEMO_WORKER_COUNT);
    expect(PAYER_DEMO_WORKER_COUNT).toBe(480);
    expect(PAYER_DEMO_TRADES.map((t) => t.roleKind).sort()).toEqual([...POSTING_TRADE_KINDS].sort());
    for (const trade of PAYER_DEMO_TRADES) {
      expect(PLAN.filter((w) => w.trade.roleKind === trade.roleKind), trade.roleKind).toHaveLength(
        PER_TRADE_COUNT,
      );
    }
  });

  it("every worker is a SAMPLE candidate — badged, never unlockable (R74)", () => {
    for (const w of PLAN) expect(isSampleWorkerId(w.workerId), w.workerId).toBe(true);
    // Profiles and consents are not workers: the predicate is about workers only.
    expect(isSampleWorkerId(PLAN[0]!.profileId)).toBe(false);
  });

  it("ids and phones are unique, and every phone is in the reserved synthetic block", () => {
    expect(new Set(PLAN.map((w) => w.workerId)).size).toBe(PLAN.length);
    expect(new Set(PLAN.map((w) => w.phoneE164)).size).toBe(PLAN.length);
    for (const w of PLAN) {
      expect(w.phoneE164).toMatch(PAYER_DEMO_PHONE_PATTERN);
      // `+91` + five zeros can never be a real Indian mobile (those start 6–9).
      expect(w.phoneE164).toMatch(/^\+910{5}\d{5}$/);
    }
  });

  it("keeps the ids production already holds (a re-sync updates rows, never re-creates them)", () => {
    expect(PLAN[0]!.workerId).toBe("be162000-0000-4000-8000-000000000000");
    expect(PLAN[479]!.workerId).toBe("be162000-0000-4000-8000-0000000001df");
    expect(PLAN[0]!.phoneE164).toBe("+910000061001");
  });
});

describe("seed-payer-demo-candidates — CEO ladders (#2550)", () => {
  it("every rung is on its trade's CEO posting ladder — no legacy keys like helper", () => {
    for (const w of PLAN) {
      const ladder = postingTradeFor(w.trade.roleKind)!.ladder.map((r) => r.rung as string);
      expect(ladder, `${w.trade.roleKind}:${w.tradeLevel}`).toContain(w.tradeLevel);
    }
    expect(PLAN.some((w) => (w.tradeLevel as string) === "helper")).toBe(false);
  });

  it("covers every rung of every ladder, Supervisor included", () => {
    for (const trade of PAYER_DEMO_TRADES) {
      const seeded = new Set(
        PLAN.filter((w) => w.trade.roleKind === trade.roleKind).map((w) => w.tradeLevel),
      );
      expect([...seeded].sort(), trade.roleKind).toEqual([...payerDemoLadder(trade.roleKind)].sort());
    }
  });

  it("levelConfirmed is the taxonomy's own rule, never a hand-kept copy", () => {
    for (const w of PLAN) expect(w.levelConfirmed).toBe(isLevelConfirmed(w.tradeLevel));
  });
});

describe("seed-payer-demo-candidates — every trade derives its own match skill", () => {
  it("through the SAME derivation the live rebuild and db:backfill:worker-skills run", () => {
    for (const trade of PAYER_DEMO_TRADES) {
      const route = trade.route;
      const input = workerSkillDeriveInput({
        profile: {
          canonicalRoleId: route.kind === "role" ? route.roleId : null,
          profileSkills: profileSkillsForRoute(route, trade.flavorSkills),
          totalYears: 5,
          sourceSession: null,
        },
        secondaryRoleIds: [],
        packAnswers:
          route.kind === "pack"
            ? [{ packId: route.packId, attributeKey: route.attributeKey, optionKeys: [route.optionKey] }]
            : [],
      });
      expect(input, trade.roleKind).not.toBeNull();
      const derived = deriveWorkerSkills(input!).map((row) => row.skillId as string);
      expect(derived, trade.roleKind).toContain(trade.skillId);
    }
  });

  it("the stored trade skill is each trade's own posting skill", () => {
    for (const trade of PAYER_DEMO_TRADES) {
      expect(trade.skillId, trade.roleKind).toBe(postingTradeFor(trade.roleKind)!.matchSkillId);
    }
  });
});
