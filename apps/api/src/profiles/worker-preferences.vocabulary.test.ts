import { describe, expect, it } from "vitest";

import {
  EDUCATION_COUNCILS,
  EDUCATION_CREDENTIALS,
  EDUCATION_QUALIFICATIONS,
  labelFor,
  labelsFor,
} from "./worker-preferences.vocabulary";

/**
 * THE DROP-THE-UNKNOWN RULE, held in place.
 *
 * `labelFor` and `labelsFor` are the only two ways a stored slug becomes printed English, and the
 * file states their shared contract in terms: an option the dictionary does not know yields
 * nothing and is DROPPED, because a slug like `uan_pf` on a printed sheet is worse than an absent
 * row and an option removed from a dictionary must stop printing rather than start printing raw.
 *
 * These assertions exist because the two functions did not agree. `labelsFor` has always filtered
 * on `typeof l === "string"`; `labelFor` was `vocabulary[slug] ?? null`, which is the same thing
 * for every slug EXCEPT the handful that name an `Object.prototype` member — see below.
 */
describe("labelFor / labelsFor — a slug the dictionary does not know is dropped", () => {
  it("prints a known slug through its dictionary", () => {
    expect(labelFor(EDUCATION_COUNCILS, "ncvt")).toBe("NCVT");
    expect(labelFor(EDUCATION_QUALIFICATIONS, "iti")).toBe("ITI");
    expect(labelsFor(EDUCATION_COUNCILS, ["ncvt", "scvt"])).toEqual(["NCVT", "SCVT"]);
  });

  it("returns null for an ordinary unknown slug", () => {
    // `iti_diploma` is the likeliest arrival of all: it is `qp_universal`'s own stored value for
    // the merged option that `EDUCATION_QUALIFICATIONS` exists to split.
    expect(labelFor(EDUCATION_QUALIFICATIONS, "iti_diploma")).toBeNull();
    expect(labelFor(EDUCATION_COUNCILS, "retired_board")).toBeNull();
    expect(labelsFor(EDUCATION_COUNCILS, ["ncvt", "retired_board"])).toEqual(["NCVT"]);
  });

  it.each(["toString", "constructor", "valueOf", "hasOwnProperty", "__proto__"])(
    "returns null for %s — a prototype member is not a label",
    (slug) => {
      // THE DEFECT THIS PINS, and it is a 500 rather than a wrong string. These dictionaries are
      // plain object literals, so `vocabulary["toString"]` resolves to a FUNCTION rather than to
      // `undefined`, and `?? null` does not catch a function. The old `labelFor` therefore handed
      // a function to a string composer, and `educationLine` threw `p?.trim is not a function`:
      // the render dies instead of dropping the segment, which is the exact inversion of the
      // safety property this file promises.
      //
      // NOT REACHABLE THROUGH AN API WRITE — every caller's slug comes from a `z.enum` built over
      // these same keys. It is reachable through the DATABASE: `worker_education.credential` and
      // `.council` are plain `text` with no format check, so a hand-written row, a backfill or a
      // future writer can put one there.
      for (const dictionary of [
        EDUCATION_COUNCILS,
        EDUCATION_CREDENTIALS,
        EDUCATION_QUALIFICATIONS,
      ]) {
        expect(labelFor(dictionary, slug)).toBeNull();
        expect(labelsFor(dictionary, [slug])).toEqual([]);
      }
    },
  );

  it("keeps the two functions agreeing, which is the property that was broken", () => {
    // A SINGLE-ELEMENT `labelsFor` AND `labelFor` MUST BE THE SAME DECISION. They were not, for
    // exactly the slugs above, and the asymmetry is what made the defect invisible: every list
    // row dropped the unknown correctly while the scalar beside it crashed the render.
    for (const slug of ["ncvt", "iti_diploma", "toString", "valueOf"]) {
      const one = labelFor(EDUCATION_COUNCILS, slug);
      expect(labelsFor(EDUCATION_COUNCILS, [slug])).toEqual(one === null ? [] : [one]);
    }
  });
});

describe("EDUCATION_QUALIFICATIONS — the whole-credential set", () => {
  it("serves the ladder in reading order, lowest rung first", () => {
    // NOT AN AESTHETIC PREFERENCE. `Object.keys` is exactly what the options endpoint serves and
    // what the DTO builds its enum from, and JavaScript HOISTS INTEGER-LIKE KEYS to the front of
    // an object — so slugs of "10" and "12" (which `KNOWN_EDUCATION_LEVELS` uses) would render as
    // "10th pass · 12th pass · Below 10th · ITI …" for every worker, with no fix available at the
    // call site. `class_10` / `class_12` is what keeps the ladder readable.
    expect(Object.keys(EDUCATION_QUALIFICATIONS)).toEqual([
      "below_10",
      "class_10",
      "class_12",
      "iti",
      "diploma",
      "graduate",
    ]);
  });

  it("splits the merged credential rather than collapsing it", () => {
    // §4.5's rule applied one level up: `iti_diploma` is the merged option and printing "ITI /
    // Diploma" on the one line an employer checks hardest says we do not know which. A two-year
    // ITI trade certificate and a three-year polytechnic diploma are different credentials with
    // different entry routes and different pay bands.
    expect(EDUCATION_QUALIFICATIONS.iti).toBe("ITI");
    expect(EDUCATION_QUALIFICATIONS.diploma).toBe("Diploma");
    expect(Object.keys(EDUCATION_QUALIFICATIONS)).not.toContain("iti_diploma");
  });

  it("prints the same English as EDUCATION_CREDENTIALS for the slugs they share", () => {
    // ONE WORKER'S ITI MUST READ ONE WAY. The narrow dictionary is what the preferences form
    // writes and the wide one is what a `worker_education` row writes; a worker who filled both
    // surfaces must not find two spellings of their own credential on one sheet.
    for (const slug of Object.keys(EDUCATION_CREDENTIALS)) {
      expect(EDUCATION_QUALIFICATIONS[slug]).toBe(EDUCATION_CREDENTIALS[slug]);
    }
  });
});
