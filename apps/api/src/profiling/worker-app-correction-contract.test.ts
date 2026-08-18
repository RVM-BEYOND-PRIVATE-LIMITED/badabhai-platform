import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  ProfilingAnswerSchema,
  ProfilingCorrectionResponseSchema,
  ProfilingCorrectionSchema,
} from "./profiling.dto";

/**
 * THE DART CLIENT'S WIRE KEYS FOR `POST /profiling/correct`, CHECKED AGAINST THE SCHEMAS THAT
 * PRODUCE AND JUDGE THEM (#700).
 *
 * WHY THIS FILE EXISTS — the same reason `actions/worker-app-action-contract.test.ts` does, and
 * the same failure it was written after (#707). The Dart side proves `correct()` with a
 * `MockClient` returning JSON the author of the parser also wrote, so the two agree with each
 * other and with nothing else. A renamed field on THIS side does not fail that test: `row['…']`
 * on a missing key yields `null` in Dart, so the review row silently redraws blank — no
 * exception, no 4xx, a green suite on both sides. That is exactly how a client shipped a
 * `source_surface` no server schema accepted.
 *
 * The correction path is the one where a silent blank matters most: the worker is fixing a value
 * they already saw was wrong, and the redraw is the only confirmation they get that it took.
 *
 * WHAT THIS ASSERTS. Every JSON key the Dart gateway reads out of the correction response is a
 * key the response schema actually produces, and every key it sends is one the request schema
 * accepts. It does NOT assert types or values — the Dart casts are its own business, and the
 * per-field semantics are covered on both sides already.
 *
 * If this breaks because the Dart moved, do not delete it: the contract really did change, and
 * finding out here is the entire point.
 */
const GATEWAY_PATH = join(
  __dirname,
  "../../../worker-app/lib/features/voice_form/data/http_voice_form_gateway.dart",
);
const GATEWAY = readFileSync(GATEWAY_PATH, "utf8");

/**
 * The body of one Dart method, by name — so a key read in `_parseStep` (the ANSWER path) can
 * never be mistaken for one read in `_parseCorrection`.
 *
 * TWO BRACE PROBLEMS, both of which produce a WRONG body rather than an error:
 *
 *  - Dart named parameters are themselves braced (`correct(VoiceAnswer answer, {required String
 *    questionKey})`), so "the first `{` after the signature" is the parameter list, not the body.
 *    The parameter list is found by paren depth instead, and the body is the first `{` after it.
 *  - The bodies contain nested map and constructor literals, so a lazy match to the first `}`
 *    ends the body early. Depth-counted to the matching close.
 *
 * Both mistakes yield a short, plausible string that simply contains no wire keys — which is why
 * every assertion below is guarded by a count. The first draft of this file made the first
 * mistake and the guard is what surfaced it.
 */
function methodBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(
    start,
    `${signature} not found in ${GATEWAY_PATH} — did the Dart method move?`,
  ).toBeGreaterThan(-1);

  // Walk the parameter list by paren depth; a named-parameter `{` sits INSIDE it and so cannot
  // be mistaken for the body's opening brace.
  let parens = 0;
  let i = source.indexOf("(", start);
  for (; i < source.length; i++) {
    if (source[i] === "(") parens++;
    else if (source[i] === ")") {
      parens--;
      if (parens === 0) break;
    }
  }

  const open = source.indexOf("{", i);
  let depth = 0;
  for (let j = open; j < source.length; j++) {
    if (source[j] === "{") depth++;
    else if (source[j] === "}") {
      depth--;
      if (depth === 0) return source.slice(open, j + 1);
    }
  }
  throw new Error(`unbalanced braces after ${signature}`);
}

/**
 * Keys read as `json['x']` / `row['x']` inside a body, split by receiver.
 *
 * ONE LITERAL PATTERN, FILTERED — not a pattern built from `receiver`. Interpolating the
 * receiver would be a `detect-non-literal-regexp` finding, and #737 has just made SAST blocking
 * precisely so that arrives as a red check instead of a habit. A suppression would have silenced
 * the rule's next REAL hit in this file too; a literal costs one `.filter` and silences nothing.
 */
function keysRead(body: string, receiver: "json" | "row"): string[] {
  return [...body.matchAll(/\b(json|row)\['([a-z_]+)'\]/g)]
    .filter((m) => m[1] === receiver)
    .map((m) => m[2]!);
}

const PARSE_BODY = methodBody(GATEWAY, "VoiceCorrectionOutcome _parseCorrection(");
const CORRECT_BODY = methodBody(GATEWAY, "Future<VoiceCorrectionOutcome> correct(");
const SUBMIT_BODY = methodBody(GATEWAY, "Future<VoiceFormStep> submit(");

describe("the worker app's /profiling/correct wire keys exist on this side (#700)", () => {
  it("reads only response keys the correction response actually carries", () => {
    const topLevel = keysRead(PARSE_BODY, "json");
    const rowLevel = keysRead(PARSE_BODY, "row");

    // The parser has to read SOMETHING, or a regex that quietly stopped matching would make
    // every assertion below vacuously true.
    expect(topLevel.length + rowLevel.length).toBeGreaterThan(3);

    const responseKeys = Object.keys(ProfilingCorrectionResponseSchema.shape);
    const rowKeys = Object.keys(ProfilingCorrectionResponseSchema.shape.row.shape);
    expect(responseKeys).toEqual(expect.arrayContaining(topLevel));
    expect(rowKeys).toEqual(expect.arrayContaining(rowLevel));
  });

  it("sends only body keys the request schema accepts", () => {
    const sent = [...CORRECT_BODY.matchAll(/'([a-z_]+)':/g)].map((m) => m[1]!);
    expect(sent.length).toBeGreaterThan(2);
    expect(Object.keys(ProfilingCorrectionSchema.shape)).toEqual(expect.arrayContaining(sent));
  });

  it("sends only ANSWER body keys the request schema accepts (#931)", () => {
    // THE GUARD THAT WOULD HAVE CAUGHT #931 ON THE DAY #870 SHIPPED. The correction path had this
    // check and the answer path did not, so when the Dart started sending `submission_id` here,
    // nothing noticed that no server schema declared it — and a non-strict `z.object` STRIPS an
    // unknown key rather than rejecting it. No exception, no 4xx, a green suite on both sides,
    // and the reply cache went on guessing from a clock for every answer a worker spoke.
    //
    // A stripped key is the same silent-blank failure mode this file was written after (#707),
    // arriving from the request direction instead of the response direction.
    const sent = [...SUBMIT_BODY.matchAll(/'([a-z_]+)':/g)].map((m) => m[1]!);
    expect(sent.length).toBeGreaterThan(2);
    expect(sent).toContain("submission_id");
    expect(Object.keys(ProfilingAnswerSchema.shape)).toEqual(expect.arrayContaining(sent));
  });

  it("tests `status` against a value the row's status enum can actually hold", () => {
    // `declined: row['status'] == 'declined'` is a string compare against an enum this side
    // owns. Renaming the enum member would leave the client permanently reporting "not
    // declined" — a worker's "Nahi bataya" silently redrawing as an answered row.
    const compared = [...PARSE_BODY.matchAll(/row\['status'\]\s*==\s*'([a-z_]+)'/g)].map(
      (m) => m[1]!,
    );
    expect(compared).not.toHaveLength(0);
    const allowed = ProfilingCorrectionResponseSchema.shape.row.shape.status.options;
    for (const value of compared) expect(allowed).toContain(value);
  });
});
