import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AiCostSummary } from "../lib/dashboard";
import { AiSpendPanel } from "./ai-spend-panel";

/**
 * What the AI-spend panel actually RENDERS.
 *
 * ── WHY A RENDER TEST AND NOT JUST `ai-cost.test.ts` ────────────────────────────────────
 * `status-pill.render.test.tsx` records the precedent: the pure `statusTone` tests passed
 * happily while the credits ledger rendered a pill reading "applied" next to every ops grant.
 * The bug was never in the pure function; it was in what reached the DOM, and nothing asserted
 * that. Same risk here — `describeAiCostBasis` can be perfectly correct while the panel prints
 * the ₹ figure and drops the caption, which is the one failure this whole surface exists to
 * prevent.
 *
 * `renderToStaticMarkup` is enough: these are plain function components with no hooks, so the
 * node environment this app's vitest runs in needs no jsdom.
 */

const html = (el: React.ReactElement) => renderToStaticMarkup(el);

/**
 * Every `.stat__value` tile in the markup, in order.
 *
 * Needed because "no ₹ was rendered" is a claim about the TILES, and the panel legitimately
 * renders one non-₹ tile (the cap-breach count, which reads the event spine) in the very state
 * where no ₹ may appear. `not.toContain("stat__value")` used to stand in for both, and it
 * cannot any more without also forbidding the tile that has to be there.
 */
const statValues = (out: string) =>
  [...out.matchAll(/<span class="stat__value">([^<]*)<\/span>/g)].map((m) => m[1]!);

const rupeeTiles = (out: string) => statValues(out).filter((v) => v.includes("₹"));

const COST: AiCostSummary = {
  accruing_since: "2026-08-17T01:00:00.000Z",
  is_lifetime_total: false,
  caveat: "totals_accrue_from_migration_0077_no_backfill",
  total_cost_inr: "23.750000",
  total_calls: 156,
  real_calls: 146,
  by_provider: [
    {
      provider: "google",
      total_cost_inr: "12.500000",
      call_count: 100,
      real_call_count: 90,
      first_recorded_at: "2026-08-18T09:00:00.000Z",
    },
    {
      provider: "sarvam",
      total_cost_inr: "3.000000",
      call_count: 12,
      real_call_count: 12,
      first_recorded_at: "2026-08-19T01:00:00.000Z",
    },
    {
      // Pre-fix Sarvam speech spend plus any genuinely unrecognised model id. Real money.
      provider: "unknown",
      total_cost_inr: "1.000000",
      call_count: 4,
      real_call_count: 4,
      first_recorded_at: "2026-08-17T01:00:00.000Z",
    },
  ],
  by_task_type: [
    {
      task_type: "stt_transcription",
      total_cost_inr: "4.000000",
      call_count: 16,
      real_call_count: 16,
    },
  ],
  cap_breaches: {
    window_days: 30,
    total: 0,
    scope: "cap_breaches_cover_profile_extraction_only",
    by_reason: [],
  },
};

describe("AI spend — no ₹ figure is ever rendered without its basis", () => {
  it("prints the accrual DATE in the TOTAL's own label", () => {
    const out = html(<AiSpendPanel cost={COST} />);
    expect(out).toContain("₹23.75");
    /*
     * ⚠ THE ASSERTION IS THE LABEL, NOT "the date appears somewhere".
     *
     * The looser form survived a mutation that replaced the whole "since <date>" basis with
     * "All time": the date still appeared further down the page, on the `unknown` provider
     * row's own `first_recorded_at`. A test that passes while the headline lies is worse than
     * no test, since it reads as coverage. Pinning the tile LABEL is what makes it fail.
     */
    expect(out).toContain("Spend recorded since 2026-08-17");
  });

  it("never labels a partial figure a total", () => {
    const out = html(<AiSpendPanel cost={COST} />);
    expect(out).toContain("Not a lifetime total");
    expect(out).not.toContain("All time");
  });

  it("renders NO ₹ at all when nothing has ever accrued", () => {
    /*
     * `accruing_since: null` means the cost table has never been written to. A "₹0.00" tile
     * would state "we measured the platform and it spent nothing" — the strongest possible
     * claim, and one nobody made.
     */
    const out = html(
      <AiSpendPanel
        cost={{
          ...COST,
          accruing_since: null,
          total_cost_inr: "0",
          total_calls: 0,
          real_calls: 0,
          by_provider: [],
          by_task_type: [],
        }}
      />,
    );
    // NOT `not.toContain("₹")` — the explanation deliberately says the words "not a
    // measured ₹0". What must be absent is a rendered ₹ FIGURE, so the assertion is on the
    // tile VALUES rather than on the class name: the cap-breach tile is a different data
    // source and stays, which `not.toContain("stat__value")` would have forbidden.
    expect(rupeeTiles(out)).toEqual([]);
    expect(out).not.toContain("Spend recorded");
    expect(out).not.toContain("Calls recorded");
    expect(out).toContain("No AI spend recorded yet");
    expect(out).toContain("not a measured");
  });
});

describe("AI spend — a cap breach is reported even when nothing has accrued", () => {
  /*
   * ⚠ `cap_breaches` IS NOT DERIVED FROM THE COST TABLE. The API counts
   * `ai.spend_cap_exceeded` over the EVENT SPINE in a rolling window; `accruing_since` comes
   * from `platform_ai_cost_totals`. So `accruing_since: null` says nothing whatsoever about
   * whether a cap was breached, and two reachable states have both at once:
   *
   *   1. the breach window reaches back past migration 0077, where the totals table starts
   *      empty and was never backfilled — the state this platform is in today; and
   *   2. the documented accrual-failure path in `ai-cost-recorder.service.ts`, where the
   *      events commit while the savepointed `accrue()` fails and the totals trail the spine.
   *
   * Gating the breach block on the ₹ basis hid `kill_switch_engaged` and
   * `cumulative_cap_exceeded` — the most operationally urgent numbers on the page — behind
   * "Nothing has accrued yet", and dropped the in-band scope sentence with them.
   */
  const NOTHING_ACCRUED_WITH_BREACH: AiCostSummary = {
    ...COST,
    accruing_since: null,
    total_cost_inr: "0",
    total_calls: 0,
    real_calls: 0,
    by_provider: [],
    by_task_type: [],
    cap_breaches: {
      ...COST.cap_breaches,
      total: 1,
      by_reason: [{ reason: "kill_switch_engaged", count: 1 }],
    },
  };

  it("renders the breach count and its scope sentence with no ₹ figure beside them", () => {
    const out = html(<AiSpendPanel cost={NOTHING_ACCRUED_WITH_BREACH} />);

    // The count, in the tile and in the reason breakdown.
    expect(out).toContain("Cap breaches (last 30 days)");
    expect(statValues(out)).toContain("1");
    expect(out).toContain("Kill switch engaged");
    expect(out).toContain("provider calls stopped");

    // THE SCOPE SHIPS WITH THE NUMBER — the reason the DTO puts it in band at all.
    expect(out).toContain("PROFILE EXTRACTION");

    // …and rule 2 still holds for the money: no ₹ tile, and the absence is stated.
    expect(rupeeTiles(out)).toEqual([]);
    expect(out).toContain("No AI spend recorded yet");
  });
});

describe("AI spend — the `unknown` provider stays visible", () => {
  it("renders the unknown bucket, its money, and why it exists", () => {
    const out = html(<AiSpendPanel cost={COST} />);
    expect(out).toContain("Unknown provider");
    expect(out).toContain("₹1.00");
    // Its explanation ships with it: pre-fix Sarvam speech spend lives there permanently.
    expect(out).toContain("never backfilled");
  });

  it("does not fold `unknown` into Sarvam — both rows render, with their own amounts", () => {
    const out = html(<AiSpendPanel cost={COST} />);
    expect(out).toContain(">Sarvam<");
    expect(out).toContain("₹3.00");
    expect(out).toContain("₹1.00");
  });

  it("renders a provider label this build has never seen rather than dropping it", () => {
    const out = html(
      <AiSpendPanel
        cost={{
          ...COST,
          by_provider: [
            {
              provider: "some_new_vendor",
              total_cost_inr: "0.500000",
              call_count: 1,
              real_call_count: 1,
              first_recorded_at: "2026-08-19T02:00:00.000Z",
            },
          ],
        }}
      />,
    );
    expect(out).toContain("some new vendor");
    expect(out).toContain("₹0.50");
  });
});

describe("AI spend — a zero cap-breach count never reads as an all-clear", () => {
  it("states the scope beside the zero", () => {
    const out = html(<AiSpendPanel cost={COST} />);
    expect(out).toContain("PROFILE EXTRACTION");
    expect(out.toLowerCase()).toContain("not an all-clear");
  });

  it("marks a platform-wide breach differently from a per-worker one", () => {
    const out = html(
      <AiSpendPanel
        cost={{
          ...COST,
          cap_breaches: {
            ...COST.cap_breaches,
            total: 3,
            by_reason: [
              { reason: "user_daily_cap_exceeded", count: 2 },
              { reason: "kill_switch_engaged", count: 1 },
            ],
          },
        }}
      />,
    );
    expect(out).toContain("One worker&#x27;s daily budget");
    expect(out).toContain("self-limiting");
    expect(out).toContain("Kill switch engaged");
    expect(out).toContain("provider calls stopped");
  });
});

describe("AI spend — sub-paisa amounts are not rounded away", () => {
  it("keeps all six places rather than collapsing to ₹0.00", () => {
    // "We spent a fraction of a paisa" and "we spent nothing" are different facts.
    const out = html(<AiSpendPanel cost={{ ...COST, total_cost_inr: "0.000012" }} />);
    expect(out).toContain("₹0.000012");
  });
});
