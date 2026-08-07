/**
 * The shared L0/L1 span search.
 *
 * Two consumers depend on these exact semantics — the eval harness that publishes the
 * Phase 2 acceptance number, and the live index that answers workers. The ordering rules
 * below are not preferences; each one is a case where the other order gives a worse answer
 * to a real utterance.
 */
import { describe, expect, it } from "vitest";

import { buildSpanIndex, matchSpan } from "./index.js";

const index = (entries: Record<string, string[]>) =>
  buildSpanIndex(Object.entries(entries).map(([id, aliases]) => ({ id, aliases })));

describe("buildSpanIndex", () => {
  it("normalizes aliases on the way in, so both sides of a match are symmetric", () => {
    // Passing a pre-normalized `text_norm` from the database would bind the index to
    // whichever particle list was in force when that column was last backfilled.
    const i = index({ jd_a: ["Welder, Gas"] });
    expect(i.exact.has("welder gas")).toBe(true);
  });

  it("keeps EVERY claimant of a shared key", () => {
    const i = index({ jd_mason: ["mistri"], jd_repair: ["mistri"] });
    expect(i.exact.get("mistri")).toEqual(["jd_mason", "jd_repair"]);
  });

  it("does not double-count a domain that repeats an alias", () => {
    expect(index({ jd_a: ["welder", "Welder"] }).exact.get("welder")).toEqual(["jd_a"]);
  });

  it("skips aliases that normalize to nothing", () => {
    expect(index({ jd_a: ["- / -", "  "] }).exact.size).toBe(0);
  });

  it("records the longest alias, which caps the span scan", () => {
    expect(index({ jd_a: ["gas welding operator"], jd_b: ["welder"] }).maxSpanTokens).toBe(3);
  });
});

describe("matchSpan", () => {
  it("finds an occupation inside a full sentence", () => {
    const i = index({ jd_weld: ["welding"] });
    const hit = matchSpan(i, "main pichhle char saal se welding ka kaam karta hoon");
    expect(hit?.ids).toEqual(["jd_weld"]);
    expect(hit?.layer).toBe("L0");
  });

  it("prefers the LONGER span, keeping the worker's own qualifier", () => {
    // Taking "welding" here would silently discard the word that chose the occupation.
    const i = index({ jd_gas: ["gas welding"], jd_any: ["welding"] });
    const hit = matchSpan(i, "main gas welding karta hoon");
    expect(hit?.ids).toEqual(["jd_gas"]);
    expect(hit?.spanTokens).toBe(2);
  });

  it("exhausts L0 at EVERY span length before trying L1 at any", () => {
    // The skeleton fold collapses mistri/mystery, fitter/father and driver/drover — all
    // bare, extremely common trade words whose exact form must win outright, even when a
    // longer span would match fuzzily.
    const i = index({ jd_exact: ["mistri"], jd_fuzzy: ["mystery shopper"] });
    const hit = matchSpan(i, "mistri mystery shoppar");
    expect(hit?.layer).toBe("L0");
    expect(hit?.ids).toEqual(["jd_exact"]);
  });

  it("falls to L1 for a misspelling no exact key covers", () => {
    const hit = matchSpan(index({ jd_weld: ["welder"] }), "main waelder hoon");
    expect(hit?.layer).toBe("L1");
    expect(hit?.ids).toEqual(["jd_weld"]);
  });

  it("returns null rather than guessing when nothing matches", () => {
    expect(matchSpan(index({ jd_weld: ["welder"] }), "aaj mausam accha hai")).toBeNull();
  });

  it("returns null for empty and particle-only input", () => {
    const i = index({ jd_weld: ["welder"] });
    expect(matchSpan(i, "")).toBeNull();
    expect(matchSpan(i, "   ")).toBeNull();
  });

  it("never scans spans longer than the longest alias", () => {
    // A span longer than any alias cannot match; scanning it is waste on every turn.
    const i = index({ jd_a: ["welder"] });
    expect(i.maxSpanTokens).toBe(1);
    expect(matchSpan(i, "a b c d e f g welder")?.spanTokens).toBe(1);
  });
});
