import { afterEach, describe, expect, it, vi } from "vitest";
import * as attention from "./attention";
import { buildAttentionItems } from "./attention";
import { lowBalanceThreshold } from "../../../lib/pricing-config";
import type { Dashboard } from "../../../lib/contracts";

/**
 * The dashboard's "needs your attention" rules.
 *
 * Two things are under test, and the second matters as much as the first: that a real
 * problem is surfaced, and that a healthy account is left ALONE. A band that is always
 * present is a band nobody reads, so silence is part of the contract.
 *
 * Every item must also be derivable from a field that is genuinely in the payload — the
 * cases below are written against the real Dashboard shape for that reason.
 */

const HEALTHY: Dashboard = {
  credits: { payerId: "p", balance: 200 },
  unlocks: [
    {
      unlockId: "u1",
      workerId: "w1",
      status: "granted",
      createdAt: "2026-08-01T00:00:00.000Z",
      expiresAt: "2026-12-01T00:00:00.000Z",
    },
  ],
  postings: [
    {
      id: "j1",
      roleTitle: "CNC Operator",
      locationLabel: "Pune",
      vacancyBand: "2-5",
      status: "open",
      applicantCount: 0,
      createdAt: "2026-06-01T00:00:00.000Z",
    },
  ],
} as Dashboard;

const EMPLOYER_OWNER = { isAgency: false, isOwner: true };
const EMPLOYER_RECRUITER = { isAgency: false, isOwner: false };

describe("buildAttentionItems", () => {
  it("says NOTHING for a healthy employer account", () => {
    expect(buildAttentionItems(HEALTHY, EMPLOYER_OWNER)).toEqual([]);
  });

  it("raises CRITICAL when the wallet is empty — it stops the core loop outright", () => {
    const out = buildAttentionItems(
      { ...HEALTHY, credits: { payerId: "p", balance: 0 } },
      EMPLOYER_OWNER,
    );
    expect(out[0]!.id).toBe("credits-empty");
    expect(out[0]!.tone).toBe("critical");
    expect(out[0]!.actionHref).toBe("/credits");
    // "Buy credits" with the ONE balance icon — never "Top up" (which also meant quota).
    expect(out[0]!.actionLabel).toBe("Buy credits");
    expect(out[0]!.actionIcon).toBe("wallet");
  });

  it("warns BEFORE the wallet empties, not after", () => {
    const out = buildAttentionItems(
      { ...HEALTHY, credits: { payerId: "p", balance: lowBalanceThreshold() - 1 } },
      EMPLOYER_OWNER,
    );
    expect(out.map((i) => i.id)).toContain("credits-low");
    expect(out.find((i) => i.id === "credits-low")!.tone).toBe("warning");
  });

  it("is silent about the wallet exactly AT the threshold", () => {
    const out = buildAttentionItems(
      { ...HEALTHY, credits: { payerId: "p", balance: lowBalanceThreshold() } },
      EMPLOYER_OWNER,
    );
    expect(out.map((i) => i.id)).not.toContain("credits-low");
    expect(out.map((i) => i.id)).not.toContain("credits-empty");
  });

  it("does NOT offer a Recruiter a top-up link they would only get a 404 from", () => {
    // Billing is Owner-only and /credits 404s a Recruiter. Pointing them at it would be
    // sending a user to a dead end to explain a problem they cannot fix themselves.
    const out = buildAttentionItems(
      { ...HEALTHY, credits: { payerId: "p", balance: 0 } },
      EMPLOYER_RECRUITER,
    );
    const wallet = out.find((i) => i.id === "credits-empty")!;
    expect(wallet.actionHref).toBeUndefined();
    expect(wallet.body).toContain("account owner");
  });

  it("counts expired unlocks — spent access the payer may not realise they lost", () => {
    const out = buildAttentionItems(
      {
        ...HEALTHY,
        unlocks: [
          { ...HEALTHY.unlocks[0]!, unlockId: "a", status: "expired" },
          { ...HEALTHY.unlocks[0]!, unlockId: "b", status: "expired" },
          { ...HEALTHY.unlocks[0]!, unlockId: "c", status: "granted" },
        ],
      },
      EMPLOYER_OWNER,
    );
    const item = out.find((i) => i.id === "unlocks-expired")!;
    expect(item.title).toContain("2 unlocked contacts have expired");
  });

  it("flags an employer with no OPEN posting — the quietest possible failure", () => {
    const out = buildAttentionItems(
      { ...HEALTHY, postings: [{ ...HEALTHY.postings[0]!, status: "closed" }] },
      EMPLOYER_OWNER,
    );
    const item = out.find((i) => i.id === "no-open-postings")!;
    expect(item.title).toBe("No open postings");
    expect(item.actionHref).toBe("/postings/new");
    expect(item.actionLabel).toBe("New posting");
    expect(item.actionIcon).toBe("plus");
  });

  it("says nothing for ZERO postings — the dashboard's panel already says 'No postings yet'", () => {
    // One page says it once: the "Your postings" panel's empty state carries it.
    const out = buildAttentionItems({ ...HEALTHY, postings: [] }, EMPLOYER_OWNER);
    expect(out.map((i) => i.id)).not.toContain("no-open-postings");
    expect(out).toEqual([]);
  });

  it("a recruiter is told to ASK the owner (no button — Credits is Owner-only)", () => {
    const empty = buildAttentionItems(
      { ...HEALTHY, credits: { payerId: "p", balance: 0 } },
      EMPLOYER_RECRUITER,
    )[0]!;
    expect(empty.body).toContain("Ask your account owner to buy credits");
    expect(empty.actionHref).toBeUndefined();
    const low = buildAttentionItems(
      { ...HEALTHY, credits: { payerId: "p", balance: lowBalanceThreshold() - 1 } },
      EMPLOYER_RECRUITER,
    )[0]!;
    expect(low.body).toContain("Ask your account owner to buy credits");
    expect(low.actionHref).toBeUndefined();
  });

  it("never makes a posting claim to an AGENT — their vacancies live in another entity", () => {
    // DATA-COHERENCE: an agent's job-postings read is empty by design; counting it would be
    // a statement about the wrong data set, contradicting their own agency demand summary.
    // All-closed postings would raise the item for a company (see above); never for an agent.
    const closed = { ...HEALTHY, postings: [{ ...HEALTHY.postings[0]!, status: "closed" as const }] };
    expect(buildAttentionItems(closed, EMPLOYER_OWNER).map((i) => i.id)).toContain(
      "no-open-postings",
    );
    const out = buildAttentionItems(closed, { isAgency: true, isOwner: true });
    expect(out.map((i) => i.id)).not.toContain("no-open-postings");
  });

  it("orders the wallet above everything else when several things are wrong at once", () => {
    const out = buildAttentionItems(
      {
        credits: { payerId: "p", balance: 0 },
        unlocks: [{ ...HEALTHY.unlocks[0]!, status: "expired" }],
        postings: [{ ...HEALTHY.postings[0]!, status: "closed" }],
      } as Dashboard,
      EMPLOYER_OWNER,
    );
    expect(out.map((i) => i.id)).toEqual([
      "credits-empty",
      "unlocks-expired",
      "no-open-postings",
    ]);
  });

  it("an agent gets only the wallet item (no posting item, whatever the job-postings read says)", () => {
    const out = buildAttentionItems(
      { ...HEALTHY, credits: { payerId: "p", balance: 0 } },
      { isAgency: true, isOwner: true },
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("credits-empty");
  });
});

/**
 * F29 (final sweep) — the dashboard now reads its three parts independently, and a part whose read
 * FAILED is `null`. A failed read is a statement about the read, never about the account: it may
 * raise no item (an unknown balance is not an empty wallet; unknown postings are not "all closed").
 */
describe("buildAttentionItems — a part that could not be read says nothing", () => {
  const EMPTY_WALLET = { payerId: "p", balance: 0 };
  const EXPIRED = [{ ...HEALTHY.unlocks[0]!, status: "expired" as const }];
  const ALL_CLOSED = [{ ...HEALTHY.postings[0]!, status: "closed" as const }];

  it("an unread balance raises no wallet item (never a guessed 'out of credits')", () => {
    const out = buildAttentionItems({ ...HEALTHY, credits: null }, EMPLOYER_OWNER);
    expect(out).toEqual([]);
    // …while the same account with the balance read still says it.
    expect(
      buildAttentionItems({ ...HEALTHY, credits: EMPTY_WALLET }, EMPLOYER_OWNER).map((i) => i.id),
    ).toEqual(["credits-empty"]);
  });

  it("unread unlocks raise no expired item; the other parts still speak", () => {
    const out = buildAttentionItems(
      { credits: EMPTY_WALLET, unlocks: null, postings: ALL_CLOSED },
      EMPLOYER_OWNER,
    );
    expect(out.map((i) => i.id)).toEqual(["credits-empty", "no-open-postings"]);
    expect(
      buildAttentionItems({ ...HEALTHY, unlocks: EXPIRED }, EMPLOYER_OWNER).map((i) => i.id),
    ).toEqual(["unlocks-expired"]);
  });

  it("unread postings raise no 'No open postings' item", () => {
    const out = buildAttentionItems({ ...HEALTHY, postings: null }, EMPLOYER_OWNER);
    expect(out).toEqual([]);
    expect(
      buildAttentionItems({ ...HEALTHY, postings: ALL_CLOSED }, EMPLOYER_OWNER).map((i) => i.id),
    ).toEqual(["no-open-postings"]);
  });

  it("nothing read at all → nothing claimed", () => {
    expect(
      buildAttentionItems({ credits: null, unlocks: null, postings: null }, EMPLOYER_OWNER),
    ).toEqual([]);
  });
});

/**
 * N7 (final re-sweep) — the dashboard warned "Only N credits left" from 10 (its own constant)
 * while /credits warned from 5 (the pricing config), so balances 5-9 read "low" on one page and
 * fine on the other. ONE threshold now: the pricing config's `lowBalanceThreshold()` (default 5,
 * `PAYER_LOW_BALANCE_THRESHOLD` overrides it) — the number /credits reads.
 */
describe("buildAttentionItems — the low-balance threshold is the pricing config's (N7)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  const at = (balance: number, opts = EMPLOYER_OWNER) =>
    buildAttentionItems({ ...HEALTHY, credits: { payerId: "p", balance } }, opts);
  const ids = (balance: number) => at(balance).map((i) => i.id);
  /** Every "Buy credits" the owner's needs-you band offers at this balance. */
  const buys = (balance: number) => at(balance).filter((i) => i.actionLabel === "Buy credits");

  it("the dashboard keeps no number of its own", () => {
    expect("LOW_BALANCE_THRESHOLD" in attention).toBe(false);
  });

  it("default: 5 — balances 5 to 9 are not low (as on /credits); 4 is, with ONE Buy credits", () => {
    vi.stubEnv("PAYER_LOW_BALANCE_THRESHOLD", "");
    expect(lowBalanceThreshold()).toBe(5);
    for (const balance of [5, 6, 7, 8, 9]) {
      expect(ids(balance), `balance ${balance}`).toEqual([]);
      expect(buys(balance), `balance ${balance}`).toEqual([]);
    }
    expect(ids(4)).toEqual(["credits-low"]);
    expect(buys(4)).toHaveLength(1);
    expect(buys(4)[0]!.actionHref).toBe("/credits");
    // A recruiter is told, never linked (Credits is Owner-only) — at the same number.
    expect(at(4, EMPLOYER_RECRUITER).map((i) => i.id)).toEqual(["credits-low"]);
    expect(at(4, EMPLOYER_RECRUITER)[0]!.actionHref).toBeUndefined();
    expect(at(5, EMPLOYER_RECRUITER)).toEqual([]);
  });

  it("the config override moves the dashboard WITH /credits (8: 7 is low, 8 is not)", () => {
    vi.stubEnv("PAYER_LOW_BALANCE_THRESHOLD", "8");
    expect(lowBalanceThreshold()).toBe(8);
    expect(ids(7)).toEqual(["credits-low"]);
    expect(buys(7)).toHaveLength(1);
    expect(ids(8)).toEqual([]);
    expect(buys(8)).toEqual([]);
  });
});
