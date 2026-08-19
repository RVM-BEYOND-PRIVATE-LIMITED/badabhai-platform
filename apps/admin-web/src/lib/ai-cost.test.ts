import { describe, it, expect } from "vitest";
import {
  AI_COST_CAVEAT_SINCE_0077,
  CAP_BREACH_SCOPE_PROFILE_EXTRACTION,
  capBreachReasonLabel,
  describeAiCostBasis,
  describeAiCostCaveat,
  describeCapBreachScope,
  isPlatformWideBreach,
  providerLabel,
  providerNote,
  taskTypeLabel,
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
