import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { SetMyPreferencesSchema } from "./worker-preferences.dto";
import { PREFERENCE_KEYS } from "./worker-preferences.vocabulary";

/**
 * THE FINISHING FORM'S TWO HALVES, ASSERTED AGAINST EACH OTHER (R12 §1.5, issue #1298).
 *
 * THE FAILURE THIS EXISTED FOR WAS NOT A BUG IN EITHER HALF. `SetMyPreferencesSchema` accepted
 * twelve fields, every one validated, stored, read back and rendered, with tests on all of it.
 * `finishing_models.dart` sent seven. Nothing was broken; five fields were simply unreachable, so
 * their production population was not "low", it was **structurally zero** — and every report on
 * either side read as though the other were covering it.
 *
 * Two of the five are load-bearing. §4.4 calls expected salary MANDATORY, and the band's upper end
 * (`salary_expected_max`) had no capture surface at all, so the sheet could only ever print a point
 * figure — the anchoring §4.4 exists to prevent. The other three are three of the five segments in
 * the ratified sheet's `ITI — Machinist · NCVT · 2018 · Govt. ITI, Faridabad`.
 *
 * ── CLOSED BY #1298, AND THE ASSERTION IS HOW I FOUND OUT ─────────────────────────────────────
 *
 * `apps/worker-app` is the mobile platform's, not the backend's, and the engineering contract
 * forbids crossing. So the backend asserts its side normally, and the mobile side was written as
 * an `it.fails` — the assertion that fails today and passes the day Rishi's change lands.
 *
 * It landed within the hour, on a branch cut before it. My working copy still had the old Dart
 * file so the suite was green locally; CI tests the merge with `main`, saw the five keys, and
 * reported "Expect test to fail". Nobody had to remember to check. That is the fourth time the
 * pattern has paid on this track, after the fresher branch, the credential split and the
 * reachable verification state — and the first time the gap closed itself.
 *
 * BOTH HALVES STAY ASSERTED. The seven-key case is not redundant now that all twelve are sent:
 * it is what stops a mobile refactor quietly dropping one of the originals.
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
    // The seven the form has always sent. Kept as its own case so a mobile refactor that adds
    // fields cannot quietly drop one of the originals — the assertion below would still pass.
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

  it("sends the five fields the backend has accepted since R9/R10/R11", () => {
    // CLOSED BY #1298, AND THE `it.fails` IS HOW I FOUND OUT.
    //
    // This was written as `it.fails` in the same hour #1298 was merged, on a branch cut before
    // it landed. My working copy still had the old Dart file and the test passed locally; CI
    // tests the merge with `main`, saw the five keys, and reported "Expect test to fail". The
    // gap closed itself and the assertion said so — without anyone remembering to check, which
    // is the entire argument for the pattern. Fourth time it has paid on this track.
    //
    // `salary_expected_max` is the one that mattered most. Without it §4.4's mandatory expected
    // salary was mandatory in name only, and the ruling that closed Q5 asked specifically for
    // completion rate on it — a number that could not exist while the field could not be
    // answered. It can now.
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
