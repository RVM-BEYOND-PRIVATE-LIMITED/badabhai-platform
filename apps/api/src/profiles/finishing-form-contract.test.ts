import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { SetMyPreferencesSchema } from "./worker-preferences.dto";
import { PREFERENCE_KEYS } from "./worker-preferences.vocabulary";

/**
 * THE FINISHING FORM'S TWO HALVES, ASSERTED AGAINST EACH OTHER (R12 §1.5, issue #1298).
 *
 * THE FAILURE THIS EXISTS FOR IS NOT A BUG IN EITHER HALF. `SetMyPreferencesSchema` accepts
 * twelve fields, every one validated, stored, read back and rendered, with tests on all of it.
 * `finishing_models.dart` sends seven. Nothing is broken; five fields are simply unreachable, so
 * their production population is not "low", it is **structurally zero** — and every report on
 * either side reads as though the other were covering it.
 *
 * Two of the five are load-bearing. §4.4 calls expected salary MANDATORY and the band's upper end
 * (`salary_expected_max`) has no capture surface at all, so the sheet can only ever print a point
 * figure — the anchoring §4.4 exists to prevent. The other three are three of the five segments in
 * the ratified sheet's `ITI — Machinist · NCVT · 2018 · Govt. ITI, Faridabad`.
 *
 * ── WHY THE MOBILE HALF IS AN `it.fails` AND NOT A FIX ────────────────────────────────────────
 *
 * `apps/worker-app` is the mobile platform's, not the backend's, and the engineering contract
 * forbids crossing. So the backend asserts its side of the contract normally, and the mobile side
 * is written as the assertion that FAILS TODAY and passes the day Rishi's change lands — the same
 * `it.fails` shape that has now paid three times on this track (the fresher branch, the credential
 * split, the reachable verification state).
 *
 * It reads the Dart SOURCE rather than mocking it. A mock of a client cannot disagree with the
 * server, which is the whole lesson of the cross-language contract mocks that "accept anything":
 * the only thing that can catch this is the actual file the app ships.
 *
 * WHAT MAKES THE READ SAFE. It matches on `toUpdateBody`'s own body, so an unrelated mention of a
 * key elsewhere in the file — a comment, a model field, a test helper — cannot satisfy it. If the
 * file moves, the test fails loudly with the path rather than silently passing on an empty string.
 */

const WORKER_APP_FINISHING_MODELS = join(
  __dirname,
  "../../../../apps/worker-app/lib/features/finishing/domain/finishing_models.dart",
);

/** Every wire key `SetMyPreferencesSchema` accepts, derived — never restated. */
function acceptedWireKeys(): string[] {
  const shape = (SetMyPreferencesSchema as unknown as { shape: Record<string, unknown> }).shape;
  return Object.keys(shape).sort();
}

/** The body of `toUpdateBody()` — the map the app actually PATCHes. */
function toUpdateBodySource(): string {
  const src = readFileSync(WORKER_APP_FINISHING_MODELS, "utf8");
  const start = src.indexOf("Map<String, dynamic> toUpdateBody()");
  expect(start, `toUpdateBody() not found in ${WORKER_APP_FINISHING_MODELS}`).toBeGreaterThan(-1);
  // To the next method at the same indentation — `@override` on `props` in the shipped file.
  const end = src.indexOf("\n  @override", start);
  return src.slice(start, end === -1 ? undefined : end);
}

describe("the finishing form's server contract", () => {
  it("accepts all twelve fields, and every one of them has a storage kind", () => {
    // The two halves of the BACKEND contract, asserted against each other. A field on the schema
    // with no `PREFERENCE_KEYS` entry is accepted, validated and then never written; one in
    // `PREFERENCE_KEYS` with no schema field can never be reached. Both are silent.
    const accepted = acceptedWireKeys();
    expect(accepted).toEqual([
      "accommodation_needed",
      "documents_ready",
      "education_council",
      "education_credential",
      "education_institute",
      "education_year",
      "job_type",
      "languages",
      "preferred_cities",
      "salary_expected_max",
      "shift",
      "willing_to_relocate",
    ]);

    // The three names that differ between the wire and storage, and they differ on purpose:
    // `preferred_cities` and `shift` are stored under the keys `qp_universal` already uses
    // (`preferred_locations`, `shift_preference`) so a form answer UPSERTS the interview's row
    // rather than accumulating a second, competing fact; `willing_to_relocate` is
    // `relocation_willingness` for the same reason (it was `qp_universal@1`'s key before v2
    // dropped the ask). Everything else is identical, and this list is what keeps "identical"
    // from quietly becoming "mostly".
    //
    // Transcribed from `worker-preferences.service.ts`'s writer calls, which is the only place
    // the correspondence exists. Getting one wrong here would assert a mapping the service does
    // not implement — so the pairs are the claim, not the loop below.
    const wireToStored: Record<string, string> = {
      preferred_cities: "preferred_locations",
      shift: "shift_preference",
      willing_to_relocate: "relocation_willingness",
    };
    for (const key of accepted) {
      const stored = wireToStored[key] ?? key;
      expect(Object.keys(PREFERENCE_KEYS), `wire field ${key} has no storage kind`).toContain(
        stored,
      );
    }
  });

  it("rejects an unknown field rather than dropping it", () => {
    // `.strict()`. A client sending `salary_expected_min` — a plausible name for a field that
    // does not exist — must get a 400 naming it, not a 200 that stored nothing.
    const result = SetMyPreferencesSchema.safeParse({ salary_expected_min: 24000 });
    expect(result.success).toBe(false);
  });

  it("bounds the salary band's upper end, because a typo prints as a worker's asking price", () => {
    expect(SetMyPreferencesSchema.safeParse({ salary_expected_max: 240000 }).success).toBe(true);
    expect(SetMyPreferencesSchema.safeParse({ salary_expected_max: 999 }).success).toBe(false);
    expect(SetMyPreferencesSchema.safeParse({ salary_expected_max: 5_000_000 }).success).toBe(
      false,
    );
  });
});

describe("the finishing form's MOBILE contract (issue #1298 — Rishi)", () => {
  it("sends the seven keys it already carries", () => {
    // The half that passes today. Asserted so a mobile change cannot REMOVE a field while the
    // `it.fails` below is still red and nobody notices the regression underneath it.
    const body = toUpdateBodySource();
    for (const key of [
      "languages",
      "documents_ready",
      "preferred_cities",
      "willing_to_relocate",
      "accommodation_needed",
      "job_type",
      "shift",
    ]) {
      expect(body, `toUpdateBody() no longer sends '${key}'`).toContain(`'${key}'`);
    }
  });

  it.fails("sends the five fields the backend has accepted since R9/R10/R11", () => {
    // FAILS UNTIL #1298 LANDS, and then fails again until this `it.fails` is turned into an
    // `it` — which is the point: the day the form carries these, the test says so on its own
    // rather than waiting for someone to remember.
    //
    // `salary_expected_max` is the one that matters most. Without it §4.4's mandatory expected
    // salary is mandatory in name only, and the ruling that closed Q5 asked specifically for
    // completion rate on it — a number that cannot exist while the field cannot be answered.
    const body = toUpdateBodySource();
    for (const key of [
      "salary_expected_max",
      "education_credential",
      "education_council",
      "education_year",
      "education_institute",
    ]) {
      expect(body, `toUpdateBody() does not send '${key}' — #1298`).toContain(`'${key}'`);
    }
  });
});
