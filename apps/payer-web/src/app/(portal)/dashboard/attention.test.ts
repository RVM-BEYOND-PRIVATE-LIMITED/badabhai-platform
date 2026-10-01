import { describe, expect, it } from "vitest";
import { buildAttentionItems, LOW_BALANCE_THRESHOLD } from "./attention";
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
      { ...HEALTHY, credits: { payerId: "p", balance: LOW_BALANCE_THRESHOLD - 1 } },
      EMPLOYER_OWNER,
    );
    expect(out.map((i) => i.id)).toContain("credits-low");
    expect(out.find((i) => i.id === "credits-low")!.tone).toBe("warning");
  });

  it("is silent about the wallet exactly AT the threshold", () => {
    const out = buildAttentionItems(
      { ...HEALTHY, credits: { payerId: "p", balance: LOW_BALANCE_THRESHOLD } },
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
      { ...HEALTHY, credits: { payerId: "p", balance: LOW_BALANCE_THRESHOLD - 1 } },
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
