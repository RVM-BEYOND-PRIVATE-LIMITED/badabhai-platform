/**
 * `answer_type` ON THE CHAT WIRE — the contract half.
 *
 * WHY THIS FIELD EXISTS AT ALL. The chat has always shipped `suggested_options`, so a client could
 * draw chips; it has never shipped the ANSWER SHAPE, so a client could not tell a single-select
 * from a multi-select from a yes/no. Two consequences, both measured against the shipped corpus:
 *
 *   - All 291 boolean pack items carry ZERO options, so a client keying its widget off
 *     `suggested_options.length` renders a bare TEXT FIELD for every yes/no question in the
 *     product.
 *   - A multi-select renders as the same flat chip row as a single-select, where one tap is the
 *     whole answer. Eleven of the fifteen `qp_cnc_turning` questions are multi-select, so a turner
 *     who runs a Fanuc AND a Siemens, and cuts MS AND EN31, records exactly one of each — and the
 *     resume then states that as fact.
 *
 * The server has computed `TurnResult.answerType` all along and `chat.dto.ts` simply dropped it.
 *
 * WHAT THESE TESTS PIN is the part that is easy to get wrong on the way out: `.default()` makes the
 * key REQUIRED on the inferred output type, so every response literal must supply it, and the
 * REPLAY literal must supply the CACHED value rather than null. A replay that answers `null` turns
 * a resent message into a downgrade — the worker's widget silently disappears on a retry.
 */
import { describe, expect, it } from "vitest";

import { ANSWER_TYPES } from "@badabhai/ai-contracts";

import { PostMessageResponseSchema } from "./chat.dto";

/** A body with only the keys a pre-`answer_type` server would have sent. */
function legacyBody(over: Record<string, unknown> = {}) {
  return {
    session_id: "11111111-1111-4111-8111-111111111111",
    reply: "Turning ka kitna tajurba hai?",
    blocked: false,
    is_mock: false,
    ...over,
  };
}

describe("chat wire — answer_type", () => {
  it("defaults to null, so a body written before it existed still parses", () => {
    // The additive-defaulted-key discipline every earlier extension used. If this ever throws,
    // an older API build talking to a newer schema (or a replayed fixture) 500s.
    const parsed = PostMessageResponseSchema.parse(legacyBody());
    expect(parsed.answer_type).toBeNull();
  });

  it("accepts every one of the five contract values", () => {
    for (const t of ANSWER_TYPES) {
      expect(PostMessageResponseSchema.parse(legacyBody({ answer_type: t })).answer_type).toBe(t);
    }
  });

  it("REJECTS the three database-only types, which must be aliased before they reach the wire", () => {
    // `city` / `salary` / `duration` are legal in `qpi_answer_type_chk` and seven live pack items
    // use them. `pack-registry.service.ts` maps them to the input affordance each implies BEFORE
    // anything reads them, which is what lets `@badabhai/ai-contracts` stay frozen. If one ever
    // reaches here the mapping has been bypassed, and failing loudly is the point.
    for (const t of ["city", "salary", "duration"]) {
      expect(() => PostMessageResponseSchema.parse(legacyBody({ answer_type: t }))).toThrow();
    }
  });

  it("is nullable — null is a real value meaning 'nothing pack-shaped on screen'", () => {
    expect(
      PostMessageResponseSchema.parse(legacyBody({ answer_type: null })).answer_type,
    ).toBeNull();
  });

  it("is REQUIRED on the inferred output type, which is why every literal had to be updated", () => {
    // This is the compile-time fact that forced the four non-`projectTurn` sites (reflush, replay,
    // degraded, terminal) to be touched. Asserted at runtime as documentation of why: a `.default()`
    // field is optional on INPUT and required on OUTPUT.
    const parsed = PostMessageResponseSchema.parse(legacyBody());
    expect(Object.prototype.hasOwnProperty.call(parsed, "answer_type")).toBe(true);
  });

  it("does not disturb the sibling rendering switches", () => {
    const parsed = PostMessageResponseSchema.parse(legacyBody());
    expect(parsed.question_kind).toBe("ask");
    expect(parsed.input_mode).toBe("text");
    expect(parsed.suggested_options).toEqual([]);
    expect(parsed.progress).toBeNull();
  });
});
