import { describe, it, expect } from "vitest";
import {
  AI_TRACE_TASK_TYPES,
  AI_TRACE_TEXT_CAVEAT,
  AI_TRACE_TEXT_CONTROLS,
  aiTraceErrorLabel,
  aiTraceErrorNote,
  aiTraceHalf,
  outcomeTone,
  realCallLabel,
} from "./ai-trace-view";

/**
 * How an AI call trace is allowed to be described.
 *
 * Two of the groups below are ordinary label tests. The other two are the reason this file
 * exists:
 *
 *  * THE CAVEAT. This platform once shipped a tooltip telling an operator "every id is
 *    replaced" while an Aadhaar number sat on the screen. The sentence rendered above a
 *    worker's own words is not a styling decision, and "someone would notice in review" is
 *    exactly the assurance that failed last time.
 *  * THE THREE-STATE HALF. An undecryptable column and an empty one both arrive as `null`, and
 *    reporting the first as the second tells an operator to stop looking at the moment they
 *    should escalate.
 */

describe("the text caveat — the one string that must never overclaim", () => {
  /**
   * The failure mode is a REASSURANCE, so the assertion is against reassuring shapes rather
   * than for a fixed sentence — copy is allowed to be edited, and it is allowed to get
   * *stronger*; it is not allowed to promise the text is clean.
   */
  it("promises nothing about identity having been removed", () => {
    const combined = `${AI_TRACE_TEXT_CAVEAT} ${AI_TRACE_TEXT_CONTROLS}`.toLowerCase();
    for (const claim of [
      "are removed",
      "is removed",
      "are replaced",
      "is replaced",
      "are stripped",
      "is stripped",
      "are masked",
      "is masked",
      "are redacted",
      "is redacted",
      "anonymised",
      "anonymized",
      "no personal",
      "contains no",
      "free of",
      "safe to share",
    ]) {
      expect(combined, `the caveat must not claim "${claim}"`).not.toContain(claim);
    }
  });

  it("says what the text IS — the AI service's own prompt and reply, not the API's request", () => {
    // `AICallMetadata.prompt_text` / `response_text` are written by the ai-service's router from
    // the values it actually dispatched, both run through its pseudonymization mask. Describing
    // this as "the request this API sent" was accurate for the FIRST cut, which stored exactly
    // that — the worker's raw words — and is now wrong.
    expect(AI_TRACE_TEXT_CAVEAT).toContain("the AI service's own copy of the prompt");
    expect(AI_TRACE_TEXT_CAVEAT).toContain("the reply it produced");
    // The old sentence must not survive an edit: it located the rewriting step on the wrong side.
    expect(AI_TRACE_TEXT_CAVEAT).not.toContain("after this text was captured");
    expect(AI_TRACE_TEXT_CAVEAT).not.toContain("kept exactly as they were");
  });

  it("says the rewriting step RAN, and immediately says that is not a guarantee", () => {
    // The narrow line this copy walks. "The step ran" is true and worth telling an operator —
    // it is the difference between this build and the one that stored raw words. It is also the
    // exact claim that gets rounded up to "so the names are gone", so the sentence that states
    // it has to carry its own limit.
    expect(AI_TRACE_TEXT_CAVEAT).toContain("had run over both");
    expect(AI_TRACE_TEXT_CAVEAT).toContain("best-effort");
    expect(AI_TRACE_TEXT_CAVEAT).toContain("measured to miss names");
    expect(AI_TRACE_TEXT_CAVEAT).toContain("nothing here guarantees");
  });

  it("tells the operator what to DO with that: treat it as identifying", () => {
    expect(AI_TRACE_TEXT_CAVEAT).toContain("Treat everything below as identifying");
  });

  it("states only controls that actually exist, and names no role", () => {
    // Encryption at rest, no search, no export, audit-before-decrypt, a per-admin allowance —
    // every one of them enforced server-side. The role→capability matrix is the server's and is
    // rendered from it on /roles; a role named in prose here would be a second copy that drifts.
    expect(AI_TRACE_TEXT_CONTROLS).toContain("encrypted in the database");
    expect(AI_TRACE_TEXT_CONTROLS).toContain("no search over it and no export");
    expect(AI_TRACE_TEXT_CONTROLS).toContain("before anything is decrypted");
    expect(AI_TRACE_TEXT_CONTROLS).toContain("allowance");
    for (const role of ["super_admin", "super admin", "ops_admin", "support", "analyst"]) {
      expect(AI_TRACE_TEXT_CONTROLS.toLowerCase()).not.toContain(role);
    }
  });
});

describe("the two halves of a call, and their three states", () => {
  it("text present is text present", () => {
    expect(aiTraceHalf("hello", 5)).toEqual({ kind: "text", text: "hello" });
  });

  it("an empty string is TEXT, not an absence", () => {
    // `charCount("")` is 0 and the writer still mints a token for it, so "" is a real stored
    // value. Falling back to `absent` on a falsy check would report a genuinely empty request
    // as never having been recorded.
    expect(aiTraceHalf("", 0)).toEqual({ kind: "text", text: "" });
  });

  it("null text with NO length recorded means nothing was ever stored", () => {
    expect(aiTraceHalf(null, null)).toEqual({ kind: "absent" });
  });

  it("null text WITH a length means it was stored and did not come back", () => {
    // The distinction the server cannot make and this can: the writer derives the length and
    // the ciphertext from the same value in the same statement, so a recorded length is proof
    // text was written. Collapsing this into "absent" would report a key-rotation failure as an
    // ordinary empty field.
    expect(aiTraceHalf(null, 412)).toEqual({ kind: "undecryptable", chars: 412 });
  });

  it("a recorded length of ZERO still means it was stored", () => {
    // The off-by-one that would undo the rule above: `if (chars)` instead of `if (chars !== null)`.
    expect(aiTraceHalf(null, 0)).toEqual({ kind: "undecryptable", chars: 0 });
  });
});

describe("error codes", () => {
  it("names the codes the recorder itself mints", () => {
    expect(aiTraceErrorLabel("provider_error")).toBe("Provider failed — code not recognised");
    expect(aiTraceErrorLabel("unknown_error")).toBe("Failed, with no code");
  });

  it("names the per-surface terminal codes", () => {
    expect(aiTraceErrorLabel("stt_service_unreachable")).toBe("Speech service unreachable");
    expect(aiTraceErrorLabel("extract_deadline_exceeded")).toBe("Extraction deadline exceeded");
  });

  it("reuses the dashboard's wording for the six spend-cap reasons", () => {
    // Delegated to `capBreachReasonLabel` rather than restated. Two label maps over one
    // vocabulary is how the same code ends up reading two different ways on two screens.
    expect(aiTraceErrorLabel("kill_switch_engaged")).toBe("Kill switch engaged");
    expect(aiTraceErrorLabel("user_daily_cap_exceeded")).toBe("One worker's daily budget");
  });

  it("shows an unmapped code de-snaked rather than blank", () => {
    // A code this portal has not been taught about is a reason to look, not a reason to render
    // an empty cell — and the server can add one without admin-web redeploying.
    expect(aiTraceErrorLabel("brand_new_failure")).toBe("brand new failure");
  });

  it("explains ONLY the two codes that describe the recording rather than the call", () => {
    expect(aiTraceErrorNote("provider_error")).toContain("discarded rather than stored");
    expect(aiTraceErrorNote("unknown_error")).toContain("no code at all");
    expect(aiTraceErrorNote("kill_switch_engaged")).toBeNull();
    expect(aiTraceErrorNote("brand_new_failure")).toBeNull();
  });
});

describe("outcome and posture", () => {
  it("tones success and failure, with no middle", () => {
    expect(outcomeTone(true)).toBe("ok");
    expect(outcomeTone(false)).toBe("bad");
  });

  it("words a provider call as `real` / `mock`, matching healthTone's vocabulary", () => {
    // The labels are fed straight to `healthTone`, which maps `real`→ok and `mock`→warn. Any
    // other word falls through to `warn`, which would paint every real call amber.
    expect(realCallLabel(true)).toBe("real");
    expect(realCallLabel(false)).toBe("mock");
  });
});

describe("the task-type filter vocabulary", () => {
  it("mirrors the nine task types the platform routes today", () => {
    // Pinned as a literal: when the AI service gains a surface, this fails and someone decides
    // whether the dropdown should offer it — rather than the option silently never appearing.
    expect([...AI_TRACE_TASK_TYPES].sort()).toEqual(
      [
        "domain_match",
        "job_posting_chat_turn",
        "profile_extraction",
        "profile_parse",
        "profiling_chat_turn",
        "resume_generation",
        "skill_embedding",
        "stt_transcription",
        "tts_synthesis",
      ].sort(),
    );
  });
});
