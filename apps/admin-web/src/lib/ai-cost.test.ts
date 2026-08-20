import { describe, it, expect } from "vitest";
import {
  AI_COST_CAVEAT_SINCE_0077,
  CAP_BREACH_SCOPE_PROFILE_EXTRACTION,
  COST_PER_PROFILE_BASIS_INCLUDES_ABANDONED,
  COST_PER_PROFILE_ERASURE_BIAS,
  COST_PER_PROFILE_WINDOW_EDGE_SKEW,
  capBreachReasonLabel,
  describeAiCostBasis,
  describeAiCostCaveat,
  describeCapBreachScope,
  describeCostPerProfile,
  isPlatformWideBreach,
  providerLabel,
  providerNote,
  taskTypeLabel,
  type CostPerProfileInput,
} from "./ai-cost";

/**
 * How AI spend is allowed to be DESCRIBED.
 *
 * These are the sentences that stop a partial figure being read as an authoritative one, so
 * they are asserted as behaviour rather than left to a page to get right. The three that carry
 * the weight:
 *
 *   1. `accruing_since` is rendered WITH the figures, always — "spend since <date>", never a
 *      lifetime total, because `platform_ai_cost_totals` accrues from migration 0077 forward
 *      with no backfill.
 *   2. `accruing_since === null` means NOTHING has accrued — there is no measurement, so no ₹
 *      may be presented as one.
 *   3. The `unknown` provider bucket stays visible and honestly labelled.
 */

const SINCE = "2026-08-17T01:00:00.000Z";

describe("describeAiCostBasis — the figures never travel without their basis", () => {
  it("names the DATE the figures accrue from", () => {
    const basis = describeAiCostBasis({
      accruing_since: SINCE,
      is_lifetime_total: false,
      caveat: AI_COST_CAVEAT_SINCE_0077,
    });
    expect(basis.kind).toBe("since");
    expect(basis.sinceIso).toBe(SINCE);
    // The DATE must be in the headline — the short string a tile label or a screenshot
    // actually carries. A basis that only exists in a paragraph is a basis that gets quoted
    // away from its number.
    expect(basis.headline).toContain("2026-08-17");
    expect(basis.headline.toLowerCase()).toContain("since");
  });

  it("never calls a partial figure a total", () => {
    const basis = describeAiCostBasis({
      accruing_since: SINCE,
      is_lifetime_total: false,
      caveat: AI_COST_CAVEAT_SINCE_0077,
    });
    expect(basis.kind).not.toBe("lifetime");
    expect(basis.headline.toLowerCase()).not.toContain("all time");
    expect(basis.detail.toLowerCase()).toContain("not a lifetime total");
  });

  it("`accruing_since: null` is NOTHING ACCRUED, not a measured ₹0", () => {
    const basis = describeAiCostBasis({
      accruing_since: null,
      is_lifetime_total: false,
      caveat: AI_COST_CAVEAT_SINCE_0077,
    });
    expect(basis.kind).toBe("nothing_accrued");
    expect(basis.sinceIso).toBeNull();
    expect(basis.detail).toContain("not a measured ₹0");
  });

  it("null beats a `true` lifetime flag — an empty table has no lifetime total either", () => {
    const basis = describeAiCostBasis({
      accruing_since: null,
      is_lifetime_total: true,
      caveat: AI_COST_CAVEAT_SINCE_0077,
    });
    expect(basis.kind).toBe("nothing_accrued");
  });

  it("handles the lifetime case, so the caption is already right the day a backfill lands", () => {
    const basis = describeAiCostBasis({
      accruing_since: SINCE,
      is_lifetime_total: true,
      caveat: AI_COST_CAVEAT_SINCE_0077,
    });
    expect(basis.kind).toBe("lifetime");
    expect(basis.headline).toBe("All time");
  });
});

describe("describeAiCostCaveat / describeCapBreachScope — stable codes, not prose", () => {
  it("turns the known caveat code into a sentence", () => {
    expect(describeAiCostCaveat(AI_COST_CAVEAT_SINCE_0077)).toContain("0077");
  });

  it("shows an UNRECOGNISED caveat code rather than dropping it", () => {
    const text = describeAiCostCaveat("some_future_caveat");
    expect(text).toContain("some_future_caveat");
  });

  it("states which surfaces the breach count covers", () => {
    const text = describeCapBreachScope(CAP_BREACH_SCOPE_PROFILE_EXTRACTION);
    expect(text.toUpperCase()).toContain("PROFILE EXTRACTION");
    // The whole reason the scope ships in band: a bare 0 reads as an all-clear.
    expect(text.toLowerCase()).toContain("not an all-clear");
  });

  it("does NOT reuse the narrow sentence for a scope code it does not know", () => {
    /*
     * The API DTO says this constant CHANGES VALUE when another surface starts emitting the
     * event. Reusing the old sentence would be this portal asserting a narrowing the server
     * had just withdrawn.
     */
    const text = describeCapBreachScope("cap_breaches_cover_everything");
    expect(text.toUpperCase()).not.toContain("PROFILE EXTRACTION");
    expect(text).toContain("cap_breaches_cover_everything");
  });
});

describe("describeCostPerProfile — a ratio whose shape hides both of its claims", () => {
  const PER_PROFILE: CostPerProfileInput = {
    since: SINCE,
    profiling_task_types: ["profiling_chat_turn", "profile_extraction", "profile_parse"],
    profiling_cost_inr: "71.829300",
    profiling_calls: 140,
    profiling_real_calls: 140,
    profiles_extracted_or_confirmed: 12,
    cost_per_profile_inr: "5.985775",
    basis: COST_PER_PROFILE_BASIS_INCLUDES_ABANDONED,
    window_caveat: COST_PER_PROFILE_WINDOW_EDGE_SKEW,
    erasure_caveat: COST_PER_PROFILE_ERASURE_BIAS,
  };

  /** The rows "By task type" renders — every profiling type present, so the default reconciles. */
  const BY_TASK_TYPE = [
    { task_type: "profiling_chat_turn" },
    { task_type: "profile_extraction" },
    { task_type: "profile_parse" },
    { task_type: "resume_generation" },
  ];

  const COST = {
    accruing_since: SINCE as string | null,
    is_lifetime_total: false,
    caveat: AI_COST_CAVEAT_SINCE_0077,
    per_profile: PER_PROFILE as CostPerProfileInput | null | undefined,
    by_task_type: BY_TASK_TYPE as readonly { task_type: string }[],
  };

  const state = (over: Partial<typeof COST> = {}) => describeCostPerProfile({ ...COST, ...over });

  /**
   * The MEASURED view, or a failure naming the state that came back instead. A bare `!` would
   * turn "the block silently stopped rendering" into a null-deref five lines later, which reads
   * as a broken test rather than as the regression it is.
   */
  const view = (over: Partial<typeof COST> = {}) => {
    const s = state(over);
    if (s.kind !== "measured") throw new Error(`expected a measured block, got "${s.kind}"`);
    return s.view;
  };

  it("says the average is per FINISHED PROFILE and not a per-worker unit cost", () => {
    const v = view();
    // Both halves of the distinction, because only stating one of them leaves the other
    // reading available — and the number cannot tell them apart.
    expect(v.basisHeadline.toLowerCase()).toContain("finished profile");
    expect(v.basisHeadline.toLowerCase()).toContain("not a per-worker unit cost");
    expect(v.basisDetail.toLowerCase()).toContain("abandoned");
  });

  it("NAMES the task types it summed, read from the response and not hardcoded", () => {
    /*
     * The operator reconciles this against "By task type" beside it, so the names must be the
     * ones that table renders — `taskTypeLabel`'s de-snaked form, from the server's own list.
     * A hardcoded three would go stale the day the API classifies voice spend as profiling,
     * and would go stale SILENTLY: the sentence would still read perfectly.
     */
    const v = view();
    expect(v.scopeSentence).toContain("profiling chat turn");
    expect(v.scopeSentence).toContain("profile extraction");
    expect(v.scopeSentence).toContain("profile parse");
    expect(v.scopeSentence.toLowerCase()).toContain("excluded");

    const withVoice = view({
      per_profile: { ...PER_PROFILE, profiling_task_types: ["stt_transcription"] },
      by_task_type: [{ task_type: "stt_transcription" }],
    });
    expect(withVoice.scopeSentence).toContain("stt transcription");
    expect(withVoice.scopeSentence).not.toContain("profile extraction");
  });

  it("names as ROWS only the task types that are actually IN the table below", () => {
    /*
     * MEASURED ON THE REAL DATABASE BEFORE IT WAS FIXED: the local verification database's cost
     * table held one `resume_generation` row and nothing else, and this sentence still told the
     * operator the numerator was "exactly these rows of By task type below: profiling chat turn,
     * profile extraction, profile parse" — three rows that were not below. `by_task_type` is a
     * GROUP BY, so a classified task type with no accrued call has no row, and an instruction to
     * reconcile against rows that do not exist is an instruction that cannot be followed.
     */
    const v = view({ by_task_type: [{ task_type: "profiling_chat_turn" }] });
    expect(v.scopeSentence).toContain(
      "exactly these rows of By task type below: profiling chat turn.",
    );
    // The other two are reported as having recorded nothing — not silently dropped, and not
    // claimed as rows.
    expect(v.scopeSentence).toContain("profile extraction, profile parse");
    expect(v.scopeSentence).toContain("also count as profiling spend but have recorded no call");

    // …and it AGREES WITH ITSELF about number. One absent type is "counts"/"has", not
    // "count"/"have" — the live render caught exactly this reading "profile parse also count".
    const one = view({
      by_task_type: [{ task_type: "profiling_chat_turn" }, { task_type: "profile_extraction" }],
    });
    expect(one.scopeSentence).toContain("profile parse also counts as profiling spend but has");
    expect(one.scopeSentence).not.toContain("also count as");
  });

  it("says there is nothing to reconcile against when NONE of them is below", () => {
    const v = view({ by_task_type: [{ task_type: "resume_generation" }] });
    expect(v.scopeSentence).not.toContain("exactly these rows");
    expect(v.scopeSentence.toLowerCase()).toContain("nothing there to reconcile");
  });

  it("states the DENOMINATOR's predicate AND which column times it", () => {
    /*
     * `countCurrentProfilesCompletedSince` filters on `created_at`, and `ProfilesRepository
     * .confirm` writes `profile_status`/`confirmed_at`/`updated_at` and never touches
     * `created_at`. So a profile extracted before the bound and CONFIRMED inside it is not
     * counted — which "reached extracted or confirmed" alone reads as promising.
     */
    const v = view();
    expect(v.completedSentence).toContain("extracted or confirmed");
    expect(v.completedSentence.toLowerCase()).toContain("once per worker");
    expect(v.completedSentence.toLowerCase()).toContain("first written");
    expect(v.completedSentence.toLowerCase()).toContain("confirmed inside it is not counted");
  });

  it("dates BOTH tile labels from THIS block's bound, never from the section's basis", () => {
    const v = view();
    // Not "a date appears somewhere" — the label is the string a tile actually carries, and
    // a figure whose basis lives only in a paragraph gets quoted away from it.
    expect(v.windowLabel).toBe("since 2026-08-17");
    expect(v.windowMismatchSentence).toBeNull();
  });

  it("carries the EXACT bound in the caption, not just the day", () => {
    /*
     * The band two lines down argues "over a period this short that skew is material" and the
     * tile label is a DAY. On a window a day old that rounds away hours of it, and an operator
     * sanity-checking the tile with `created_at >= date '…'` gets a bigger number and concludes
     * the dashboard undercounts. The exact instant belongs in this block, not two elements up.
     */
    const v = view();
    expect(v.windowSentence).toContain("2026-08-17 01:00:00Z");
  });

  it("says the window edges skew it, and does not claim a direction", () => {
    const v = view();
    expect(v.windowSentence.toLowerCase()).toContain("straddle");
    expect(v.windowSentence.toLowerCase()).toContain("cuts both ways");
  });

  it("discloses that DPDP erasure biases it upward, permanently", () => {
    /*
     * MEASURED: ₹10.000000 over 22 completed profiles read ₹0.454545; erasing one worker moved
     * it to ₹0.476190 with no change in what was spent or produced. `worker_profiles` cascades
     * on a `workers` delete; `platform_ai_cost_totals` has no worker link by design. One
     * direction, no expiry, and it accumulates — which neither of the other two caveats covers.
     */
    const v = view();
    expect(v.erasureSentence.toLowerCase()).toContain("erasing a worker");
    expect(v.erasureSentence.toLowerCase()).toContain("upward");
    expect(v.erasureSentence.toLowerCase()).toContain("accumulates");
  });

  it("a null average is a STATEMENT, never ₹0.00", () => {
    /*
     * THE ONE FAILURE THIS BLOCK CANNOT SURVIVE. Spend in the window with nothing finished
     * means every interview is still running or was abandoned; a rendered ₹0.00 would say
     * profiling is free, which is the strongest claim available and one nobody measured.
     */
    const v = view({
      per_profile: {
        ...PER_PROFILE,
        profiles_extracted_or_confirmed: 0,
        cost_per_profile_inr: null,
      },
    });
    expect(v.averageIsAbsent).toBe(true);
    expect(v.averageText).not.toContain("₹");
    expect(v.averageText).not.toContain("0.00");
    expect(v.averageText.toLowerCase()).toContain("no profile");
    expect(v.averageAbsentSentence).toContain("not a measured");
  });

  it("renders a real average as an exact ₹ amount, all six places kept", () => {
    const v = view();
    expect(v.averageIsAbsent).toBe(false);
    expect(v.averageText).toBe("₹5.985775");
    expect(v.averageAbsentSentence).toBeNull();
  });

  it("is ABSENT when nothing has ever accrued — there is no window to divide over", () => {
    /*
     * Checked on the BASIS, not on `per_profile`. That is what makes the panel's rule 2 ("no ₹
     * figure at all in the nothing-accrued state") hold even if a server sent a stale block:
     * the caller cannot render this into that state.
     */
    expect(state({ accruing_since: null }).kind).toBe("absent");
    expect(state({ accruing_since: null, per_profile: PER_PROFILE }).kind).toBe("absent");
  });

  it("is ABSENT when the server sent an explicit null — no profiling spend has accrued", () => {
    expect(state({ per_profile: null }).kind).toBe("absent");
  });

  it("distinguishes a MISSING block from a null one, and never confuses it with absence", () => {
    /*
     * `null` is the server's answer. MISSING is a version skew — this portal newer than the API
     * it is talking to — and rendering nothing for it would be pixel-identical to "no profiling
     * spend has accrued", i.e. a false claim about a platform that is spending money. The
     * previous contract instead failed the WHOLE dashboard parse, which took eleven unrelated
     * panels down during any rolling deploy.
     */
    const s = state({ per_profile: undefined });
    if (s.kind !== "unsupported") throw new Error(`expected "unsupported", got "${s.kind}"`);
    expect(s.sentence.toLowerCase()).toContain("does not send");
    expect(s.sentence.toLowerCase()).toContain("not a statement that nothing was spent");
    expect(s.sentence).not.toContain("₹");
  });

  it("treats the section starting EARLIER as ordinary, and explains it in plain copy", () => {
    /*
     * `accruing_since` is the minimum over the WHOLE cost table; this block's bound is the
     * minimum over the PROFILING rows only. A subset's minimum is never earlier, so the section
     * starting first is the expected shape the moment anything that is not profiling — a résumé,
     * a payer-side embedding — was paid for first. It is NOT an alarm.
     */
    const v = view({ accruing_since: "2026-06-01T00:00:00.000Z" });
    expect(v.windowMismatchSentence).toBeNull();
    expect(v.sectionBoundSentence).toContain("2026-06-01");
    expect(v.sectionBoundSentence!.toLowerCase()).toContain("first profiling call");
    // …and BOTH tiles still carry THIS block's bound, not the section's.
    expect(v.windowLabel).toBe("since 2026-08-17");
  });

  it("WARNS only when the server contradicts itself — a subset bound BEFORE the whole", () => {
    // Arithmetically impossible for a minimum over a subset, so it means the two figures did
    // not come from the same table state and the ratio is not a ratio of anything.
    const v = view({ per_profile: { ...PER_PROFILE, since: "2026-01-01T00:00:00.000Z" } });
    expect(v.windowMismatchSentence).toContain("2026-01-01");
    expect(v.windowMismatchSentence!.toLowerCase()).toContain("contradicting itself");
    expect(v.sectionBoundSentence).toBeNull();
  });

  it("treats the same instant written two ways as a MATCH, not a mismatch", () => {
    // Compared as instants: a serializer that drops the milliseconds must not raise an alarm.
    const v = view({ per_profile: { ...PER_PROFILE, since: "2026-08-17T01:00:00Z" } });
    expect(v.windowMismatchSentence).toBeNull();
    expect(v.sectionBoundSentence).toBeNull();
  });

  it("never puts a bare em dash in a tile label when the bound will not parse", () => {
    const v = view({ per_profile: { ...PER_PROFILE, since: "not-a-date" } });
    expect(v.windowLabel).not.toContain("—");
    expect(v.windowLabel).toBe("in this period");
    expect(v.windowMismatchSentence!.toLowerCase()).toContain("cannot read");
  });

  it("does NOT relabel the count 'all time' when the SPEND becomes a lifetime total", () => {
    /*
     * `is_lifetime_total` is a claim about SPEND. The count is `created_at >= since` in every
     * case, so extending that claim to it would caption a bounded count "all time" — on this
     * platform, excluding most of the profiles ever made. Dormant today (`is_lifetime_total` is
     * pinned false) and asserted now, which is the whole reason the lifetime branch exists.
     */
    const v = view({ is_lifetime_total: true });
    expect(v.windowLabel).toBe("since 2026-08-17");
    expect(v.windowLabel).not.toContain("all time");
  });

  it("flags mocked profiling calls, and says which way they move the average", () => {
    /*
     * NOT "part of this spend is simulated money" — that is false. `cost_tracker
     * .build_call_metadata` sets `estimated = 0.0` for `real_call=False` BEFORE any override,
     * so a mocked call adds exactly ₹0.000000 and none of the rupees are fictional. The real
     * hazard is the mirror image: those interviews pad the denominator's population at zero
     * cost, so the figure UNDERSTATES what the same volume costs at real prices.
     */
    expect(view().mockPostureSentence).toBeNull();
    const v = view({ per_profile: { ...PER_PROFILE, profiling_real_calls: 100 } });
    expect(v.mockPostureSentence).toContain("40 of 140");
    expect(v.mockPostureSentence!.toLowerCase()).toContain("understates");
    expect(v.mockPostureSentence!.toLowerCase()).not.toContain("simulated money");
  });

  it("does NOT reuse the known sentences for codes it has not been taught", () => {
    const v = view({
      per_profile: {
        ...PER_PROFILE,
        basis: "some_future_basis",
        window_caveat: "some_future_edge",
        erasure_caveat: "some_future_erasure",
      },
    });
    expect(v.basisHeadline.toLowerCase()).not.toContain("per-worker");
    expect(v.basisDetail).toContain("some_future_basis");
    expect(v.windowSentence).toContain("some_future_edge");
    expect(v.windowSentence.toLowerCase()).not.toContain("straddle");
    expect(v.erasureSentence).toContain("some_future_erasure");
    expect(v.erasureSentence.toLowerCase()).not.toContain("accumulates");
  });

  it("says so rather than inventing a list when the server names no task types", () => {
    const v = view({ per_profile: { ...PER_PROFILE, profiling_task_types: [] } });
    expect(v.scopeSentence.toLowerCase()).toContain("named no task types");
    expect(v.scopeSentence.toLowerCase()).not.toContain("exactly these rows");
  });
});

describe("provider labels — an OPEN set, with `unknown` kept visible", () => {
  it("names the four labels the ai-service actually produces", () => {
    expect(providerLabel("google")).toBe("Google (Gemini)");
    expect(providerLabel("anthropic")).toBe("Anthropic (Claude)");
    expect(providerLabel("sarvam")).toBe("Sarvam");
    expect(providerLabel("openai")).toBe("OpenAI");
  });

  it("labels `unknown` honestly — never blank, never folded into Sarvam", () => {
    const label = providerLabel("unknown");
    expect(label).not.toBe("");
    expect(label.toLowerCase()).toContain("unknown");
    expect(label.toLowerCase()).not.toContain("sarvam");
  });

  it("explains WHY the `unknown` bucket holds real money", () => {
    const note = providerNote("unknown");
    // Pre-fix Sarvam speech spend lives there permanently: a running sum is never backfilled.
    expect(note).toContain("Sarvam");
    expect(note).toContain("never backfilled");
  });

  it("renders a provider added after this build rather than dropping it", () => {
    expect(providerLabel("some_new_vendor")).toBe("some new vendor");
    expect(providerNote("some_new_vendor")).toContain("not been taught");
  });

  it("adds no note to a provider that needs none", () => {
    expect(providerNote("google")).toBeNull();
  });

  it("de-snakes a task type without mapping it", () => {
    expect(taskTypeLabel("stt_transcription")).toBe("stt transcription");
  });
});

describe("cap-breach reasons — one worker's budget is not a platform outage", () => {
  it("names every reason `AI_SPEND_CAP_REASONS` declares", () => {
    // Transcribed from packages/event-schema/src/payloads.ts.
    const reasons = [
      "daily_cap_exceeded",
      "cumulative_cap_exceeded",
      "user_daily_cap_exceeded",
      "kill_switch_engaged",
      "retry_budget_exhausted",
      "cost_ceiling_exceeded",
    ];
    for (const reason of reasons) {
      const label = capBreachReasonLabel(reason);
      expect(label, reason).not.toBe(reason.replace(/_/g, " "));
    }
  });

  it("separates a per-worker budget from a platform-wide stop", () => {
    expect(isPlatformWideBreach("user_daily_cap_exceeded")).toBe(false);
    expect(isPlatformWideBreach("daily_cap_exceeded")).toBe(true);
    expect(isPlatformWideBreach("cumulative_cap_exceeded")).toBe(true);
    expect(isPlatformWideBreach("kill_switch_engaged")).toBe(true);
  });

  it("shows an unmapped reason raw rather than blank", () => {
    expect(capBreachReasonLabel("a_reason_from_a_later_build")).toBe(
      "a reason from a later build",
    );
  });
});
