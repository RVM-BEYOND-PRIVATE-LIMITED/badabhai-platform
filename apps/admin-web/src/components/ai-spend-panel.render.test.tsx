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
/*
 * The class list is matched with `[^"]*` rather than pinned exactly, because a tile whose value
 * is an ABSENCE ("No profile finished yet") carries `stat__value stat__value--absent`. Pinning
 * the bare class would have quietly excluded exactly the tiles the ₹ assertions below are
 * about — a helper that stops seeing a tile is indistinguishable from a tile that renders
 * correctly, and every assertion built on it would keep passing.
 */
const statValues = (out: string) =>
  [...out.matchAll(/<span class="stat__value[^"]*">([^<]*)<\/span>/g)].map((m) => m[1]!);

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
  /*
   * THE ROWS THE NUMERATOR IS RECONCILED AGAINST, and they must actually add up: the caption
   * tells the operator the profiling subtotal IS these rows, so a fixture that names three rows
   * and renders one is a fixture asserting a sentence the screen contradicts. 15.00 + 4.75 +
   * 0.00 = ₹19.75 (the numerator), and + ₹4.00 of `stt_transcription` = ₹23.75 (the total).
   */
  by_task_type: [
    {
      task_type: "profiling_chat_turn",
      total_cost_inr: "15.000000",
      call_count: 120,
      real_call_count: 120,
    },
    {
      task_type: "profile_extraction",
      total_cost_inr: "4.750000",
      call_count: 19,
      real_call_count: 19,
    },
    {
      task_type: "profile_parse",
      total_cost_inr: "0.000000",
      call_count: 1,
      real_call_count: 1,
    },
    {
      task_type: "stt_transcription",
      total_cost_inr: "4.000000",
      call_count: 16,
      real_call_count: 16,
    },
  ],
  // The PROFILING SLICE, not the ₹23.75 total — `resume_generation` is rendered from a profile
  // that already exists. `since` is the first PROFILING accrual, which is at or after
  // `accruing_since` above and is a DIFFERENT field; here they coincide.
  per_profile: {
    since: "2026-08-17T01:00:00.000Z",
    profiling_task_types: ["profiling_chat_turn", "profile_extraction", "profile_parse"],
    profiling_cost_inr: "19.750000",
    profiling_calls: 140,
    profiling_real_calls: 140,
    profiles_extracted_or_confirmed: 25,
    cost_per_profile_inr: "0.790000",
    basis: "profiling_spend_per_completed_profile_incl_abandoned_interviews",
    window_caveat: "interviews_straddling_the_accrual_bound_are_split",
    erasure_caveat: "erased_workers_leave_the_count_but_not_the_spend",
  },
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
          // The API nulls this in lockstep — no accrual bound, no window, no ratio.
          per_profile: null,
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
    per_profile: null,
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

describe("AI spend — what a finished profile costs", () => {
  const perProfileCost = (over: Partial<NonNullable<AiCostSummary["per_profile"]>>) => ({
    ...COST,
    per_profile: { ...COST.per_profile!, ...over },
  });

  it("renders the numerator, the denominator and the quotient", () => {
    const out = html(<AiSpendPanel cost={COST} />);
    // ₹19.75 / 25 = ₹0.79. The three figures are on screen in that order so the arithmetic
    // the caption describes is the arithmetic an operator can check.
    expect(statValues(out)).toContain("₹19.75");
    expect(statValues(out)).toContain("25");
    expect(statValues(out)).toContain("₹0.79");
  });

  it("puts the window in BOTH new tile labels — neither figure travels period-less", () => {
    const out = html(<AiSpendPanel cost={COST} />);
    expect(out).toContain("Profiling spend since 2026-08-17");
    expect(out).toContain("Profiles completed since 2026-08-17");
  });

  it("says it is cost per finished profile INCLUDING abandoned interviews", () => {
    const out = html(<AiSpendPanel cost={COST} />);
    expect(out).toContain("not a per-worker unit cost");
    expect(out).toContain("abandoned");
  });

  it("names the three task types, so it reconciles against By task type beside it", () => {
    const out = html(<AiSpendPanel cost={COST} />);
    expect(out).toContain("profiling chat turn");
    expect(out).toContain("profile extraction");
    expect(out).toContain("profile parse");
  });

  it("does NOT claim a task type is a row below when no such row is rendered", () => {
    /*
     * THE LIVE STATE OF THE VERIFICATION DATABASE BEFORE THE FIX. Its cost table held a single
     * `resume_generation` row, and this caption still told the operator the numerator was
     * "exactly these rows of By task type below: profiling chat turn, profile extraction,
     * profile parse" — with a By task type table beneath it containing none of them. The one
     * instruction the operator is given for auditing the numerator could not be followed.
     */
    const out = html(
      <AiSpendPanel
        cost={{
          ...COST,
          by_task_type: [
            {
              task_type: "profiling_chat_turn",
              total_cost_inr: "19.750000",
              call_count: 140,
              real_call_count: 140,
            },
          ],
        }}
      />,
    );
    expect(out).toContain("exactly these rows of By task type below: profiling chat turn.");
    expect(out).toContain("recorded no call");
  });

  it("states the window-edge skew rather than implying the ratio is clean", () => {
    const out = html(<AiSpendPanel cost={COST} />);
    expect(out).toContain("straddle");
    expect(out).toContain("cuts both ways");
    // The EXACT bound, not just the day the tile labels carry — the same paragraph argues the
    // skew is material over a window this short, and then must not round the bound away.
    expect(out).toContain("2026-08-17 01:00:00Z");
  });

  it("discloses that DPDP erasure biases the average upward and never washes out", () => {
    const out = html(<AiSpendPanel cost={COST} />);
    expect(out).toContain("Erasing a worker under DPDP");
    expect(out).toContain("accumulates");
  });

  it("says mocked calls make the average UNDERSTATE — never that the spend is simulated", () => {
    /*
     * `cost_tracker.build_call_metadata` prices `real_call=False` at ₹0.0 before any override,
     * so a mocked call contributes exactly nothing to the ₹ above. Calling that "simulated
     * money" is a claim the code does not support, and it points the wrong way: those calls pad
     * the interview volume at zero cost, so the figure understates real-price spend.
     */
    const out = html(
      <AiSpendPanel cost={perProfileCost({ profiling_calls: 140, profiling_real_calls: 100 })} />,
    );
    expect(out).toContain("40 of 140");
    expect(out).toContain("understates");
    expect(out).not.toContain("simulated money");
  });

  it("renders NO ₹0.00 average when no profile finished — it says so instead", () => {
    /*
     * THE EMPTY STATE THAT MATTERS. Spend in the window with nothing finished means every
     * interview is still running or was abandoned. A ₹0.00 tile there would read as
     * "profiling is free" — the strongest claim available, and one nobody measured.
     */
    const out = html(
      <AiSpendPanel
        cost={perProfileCost({
          profiles_extracted_or_confirmed: 0,
          cost_per_profile_inr: null,
        })}
      />,
    );
    expect(out).toContain("No profile finished yet");
    // The absence is styled as an absence, not set in the KPI face beside real figures.
    expect(out).toContain("stat__value--absent");
    expect(out).toContain("not a measured");
    // The denominator is still shown — "0 profiles completed" is a measurement.
    expect(statValues(out)).toContain("0");
    // …and no ₹ tile anywhere in this block claims a per-profile figure.
    expect(rupeeTiles(out)).not.toContain("₹0.00");
  });

  it("renders the block ABSENT when nothing has ever accrued", () => {
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
          per_profile: null,
        }}
      />,
    );
    expect(out).not.toContain("What a finished profile costs");
    expect(out).not.toContain("Average per profile produced");
    expect(rupeeTiles(out)).toEqual([]);
  });

  it("renders the block absent even if a STALE per_profile arrives with a null bound", () => {
    /*
     * `accruing_since: null` and a non-null `per_profile` cannot both be true from this API —
     * but the panel's rule 2 is that NO ₹ figure renders in the nothing-accrued state, and a
     * rule that holds only while the server cooperates is not a rule. `describeCostPerProfile`
     * gates on the BASIS, so the block cannot reach the DOM in that state.
     */
    const out = html(
      <AiSpendPanel cost={{ ...COST, accruing_since: null, by_provider: [], by_task_type: [] }} />,
    );
    expect(out).not.toContain("What a finished profile costs");
    expect(rupeeTiles(out)).toEqual([]);
  });

  it("WARNS only when the server contradicts itself about the bound", () => {
    const warnBanners = (out: string) => out.split("notice notice--warn").length - 1;
    // The section ALREADY renders one warn banner (the accrual basis), so "a warn banner is
    // present" proves nothing here — the assertion has to be that a SECOND one appeared.
    expect(warnBanners(html(<AiSpendPanel cost={COST} />))).toBe(1);

    // A profiling bound EARLIER than the whole table's minimum is impossible for a subset of
    // the same rows, so it means the two figures did not come from one table state.
    const out = html(<AiSpendPanel cost={perProfileCost({ since: "2026-01-01T00:00:00.000Z" })} />);
    expect(out).toContain("contradicting itself");
    expect(warnBanners(out)).toBe(2);
  });

  it("does NOT warn when the SECTION starts earlier — that is the ordinary shape", () => {
    /*
     * `accruing_since` is the minimum over the whole cost table; this block's bound is the
     * minimum over the profiling rows only. The section starting first is what happens whenever
     * something that is not profiling — a résumé, a payer-side embedding — was paid for first,
     * and warning on it would train the operator to ignore the banner that matters.
     */
    const warnBanners = (out: string) => out.split("notice notice--warn").length - 1;
    const out = html(
      <AiSpendPanel cost={{ ...COST, accruing_since: "2026-06-01T00:00:00.000Z" }} />,
    );
    expect(warnBanners(out)).toBe(1);
    expect(out).toContain("start earlier");
    // BOTH of this block's tiles still carry ITS bound, never the section's.
    expect(out).toContain("Profiling spend since 2026-08-17");
    expect(out).toContain("Profiles completed since 2026-08-17");
    expect(out).not.toContain("Profiling spend since 2026-06-01");
  });

  it("never captions this bounded COUNT 'all time', even when the spend becomes lifetime", () => {
    /*
     * `is_lifetime_total` is a claim about SPEND. The count is `created_at >= since` in every
     * case, so extending the claim to it would caption a bounded count "all time" — excluding,
     * on this platform, most of the profiles ever made. Dormant today; asserted now, which is
     * the entire reason the lifetime branch is handled at all.
     */
    const out = html(<AiSpendPanel cost={{ ...COST, is_lifetime_total: true }} />);
    expect(out).toContain("Profiles completed since 2026-08-17");
    expect(out).not.toContain("Profiles completed all time");
    expect(out).not.toContain("Profiling spend all time");
  });

  it("says so — and renders no ₹ — when the API is older than this portal", () => {
    /*
     * A missing `per_profile` is a version skew, not the server's answer. Rendering nothing
     * would be pixel-identical to "no profiling spend has accrued", i.e. a false claim about a
     * platform that is spending money; failing the parse (the previous contract) took the whole
     * dashboard down over one analytics block during any rolling deploy.
     */
    const { per_profile: _dropped, ...withoutBlock } = COST;
    const out = html(<AiSpendPanel cost={withoutBlock as AiCostSummary} />);
    expect(out).toContain("What a finished profile costs");
    expect(out).toContain("does not send");
    expect(out).not.toContain("Average per profile produced");
    // The section's own ₹ tiles are untouched; only this block's are absent.
    expect(rupeeTiles(out)).toContain("₹23.75");
    expect(rupeeTiles(out)).not.toContain("₹0.79");
  });
});

describe("AI spend — sub-paisa amounts are not rounded away", () => {
  it("keeps all six places rather than collapsing to ₹0.00", () => {
    // "We spent a fraction of a paisa" and "we spent nothing" are different facts.
    const out = html(<AiSpendPanel cost={{ ...COST, total_cost_inr: "0.000012" }} />);
    expect(out).toContain("₹0.000012");
  });
});
