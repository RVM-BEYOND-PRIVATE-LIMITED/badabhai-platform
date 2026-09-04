import { describe, it, expect } from "vitest";
import { canonicalCity } from "@badabhai/profiling-lexicon";
import CITIES_FILE from "@badabhai/profiling-lexicon/data/cities.json";

import { CITY_CATALOGUE } from "./worker-cities.catalogue";
import { SetMyPreferencesSchema } from "./worker-preferences.dto";

/**
 * The city option list (#1406).
 *
 * THE CENTRAL TEST IS THE ROUND TRIP, and it is written against the REAL DTO rather than against
 * `canonicalCity` alone. The endpoint's only promise is "everything here is a value you may
 * submit", and the thing that decides what may be submitted is `SetMyPreferencesSchema` — so
 * asserting against the schema is asserting the promise, while asserting against the normalizer
 * would only assert that two callers of the same function agree.
 *
 * These are property tests over the whole gazetteer, not spot checks, because the list is derived:
 * a hand-picked sample would keep passing while a newly added city broke. The few literal
 * assertions below are for the two traps a property test cannot describe.
 */

const ALL_TOKENS = [...CITIES_FILE.canonical, ...Object.keys(CITIES_FILE.aliases)];

describe("the preferred-city catalogue", () => {
  it("offers only values the write endpoint accepts", () => {
    // The whole point of #1406. A suggestion the validator then 400s on is worse than no
    // suggestion at all — the worker has no reason left to trust his own typing.
    for (const city of CITY_CATALOGUE) {
      const result = SetMyPreferencesSchema.safeParse({ preferred_cities: [city.value] });
      expect(result.success, `catalogue offers "${city.value}" but the DTO rejects it`).toBe(true);
    }
  });

  it("offers values the write endpoint stores UNCHANGED", () => {
    // Stricter than "accepted", and the difference is what the worker sees. The DTO canonicalises
    // what it is given, so a catalogue entry that were merely *accepted* could still be rewritten
    // to a different string — the chip would say one city and the résumé print another.
    for (const city of CITY_CATALOGUE) {
      const parsed = SetMyPreferencesSchema.parse({ preferred_cities: [city.value] });
      expect(parsed.preferred_cities, `"${city.value}" is rewritten on write`).toEqual([
        city.value,
      ]);
    }
  });

  it("resolves every alias to the city it is listed under", () => {
    // Aliases are the reason the list is objects and not strings: a worker typing "dilli" or
    // "bombay" is the exact dead end #1406 reports. If an alias resolved somewhere else, the
    // client would filter him to a chip that stores a different city than the one he searched for.
    for (const city of CITY_CATALOGUE) {
      for (const alias of city.aliases) {
        expect(
          canonicalCity(alias)?.value,
          `alias "${alias}" does not resolve to ${city.value}`,
        ).toBe(city.value);
      }
    }
  });

  it("covers the gazetteer exactly — every token reachable, nothing invented", () => {
    // Both directions. A token the worker could type but cannot find is the miss this issue is
    // about; a catalogue entry with no gazetteer token behind it would be a city we invented.
    const reachable = new Set(CITY_CATALOGUE.flatMap((c) => [c.value.toLowerCase(), ...c.aliases]));
    for (const token of ALL_TOKENS) {
      expect(reachable.has(token.toLowerCase()), `gazetteer token "${token}" is unreachable`).toBe(
        true,
      );
    }

    const fromGazetteer = new Set(ALL_TOKENS.map((t) => canonicalCity(t)?.value));
    expect(new Set(CITY_CATALOGUE.map((c) => c.value))).toEqual(fromGazetteer);
  });

  it("lists each city once, alphabetically", () => {
    const values = CITY_CATALOGUE.map((c) => c.value);
    expect(new Set(values).size, "a city appears twice").toBe(values.length);
    expect(values).toEqual([...values].sort((a, b) => a.localeCompare(b)));
  });

  it("never lists a city's own spelling as one of its aliases", () => {
    // Aliases are search keys the client adds to its filter; the display spelling is already
    // matched. Listing it twice would rank that city above the rest for no stated reason.
    for (const city of CITY_CATALOGUE) {
      expect(city.aliases).not.toContain(city.value.toLowerCase());
      for (const alias of city.aliases) expect(alias).toBe(alias.toLowerCase());
    }
  });

  // ── The two traps a property test cannot describe ────────────────────────────────
  //
  // "bengaluru" and "gurgaon" are members of `canonical` AND keys of `aliases`, and the alias map
  // wins. A list built naively from `canonical` would therefore offer the worker two chips that
  // store the same value. These are pinned literally because the failure is silent — both chips
  // "work", and only the printed sheet disagrees.

  it("folds a token that is BOTH canonical and an alias into one chip", () => {
    const bangalore = CITY_CATALOGUE.filter((c) => c.value === "Bangalore");
    expect(bangalore).toHaveLength(1);
    expect(bangalore[0]!.aliases).toContain("bengaluru");
    expect(CITY_CATALOGUE.map((c) => c.value)).not.toContain("Bengaluru");

    const gurugram = CITY_CATALOGUE.filter((c) => c.value === "Gurugram");
    expect(gurugram).toHaveLength(1);
    expect(gurugram[0]!.aliases).toContain("gurgaon");
    expect(CITY_CATALOGUE.map((c) => c.value)).not.toContain("Gurgaon");
  });

  it("keeps a city that merely CONTAINS another as its own chip", () => {
    // The longest-first alternation in `canonicalCity` is what makes these distinct answers rather
    // than "Delhi" and "Mumbai" with extra words. If that ever regressed, three real cities would
    // silently collapse into two others.
    for (const value of ["New Delhi", "Navi Mumbai", "Greater Noida", "Delhi", "Mumbai", "Noida"]) {
      expect(
        CITY_CATALOGUE.map((c) => c.value),
        `${value} is missing`,
      ).toContain(value);
    }
  });
});

/**
 * THE GAZETTEER FILE'S OWN HYGIENE (#1409).
 *
 * The suites above test what the catalogue DERIVES. These test the source it derives from, and
 * they exist because #1409 was not a bug in any code — it was a hand-maintained JSON file that
 * had quietly fallen out of step with the product's own ratified output. The file will keep being
 * edited by hand, so the edit itself is what needs a gate.
 *
 * EACH ASSERTION BELOW IS A WAY THE NEXT EDIT FAILS SILENTLY. None of them throws today; all four
 * are invisible until something downstream misbehaves for a reason nobody connects to this file.
 * Python asserts the lowercase rule from its side; nothing asserted any of it from the side an
 * engineer is actually typing on.
 */
describe("the gazetteer file itself", () => {
  it("holds only lowercase, pre-trimmed tokens", () => {
    // A capitalised entry SILENTLY DISARMS two things at once: the pseudonymizer's carve-out
    // (which stops a city being masked as a person's name) and the detector's own matching. It
    // throws nowhere — the city simply stops being recognised, and a worker's city starts
    // arriving at the model as [PERSON_n].
    for (const token of [...ALL_TOKENS, ...Object.values(CITIES_FILE.aliases)]) {
      expect(token, `"${token}" must be lowercase`).toBe(token.toLowerCase());
      expect(token, `"${token}" must be pre-trimmed`).toBe(token.trim());
    }
  });

  it("keeps canonical and aliases in sorted order", () => {
    // Not cosmetic. An out-of-order insert makes every future diff of this file unreviewable —
    // and this is a file whose review IS the privacy gate, because no test can tell you that the
    // city you just added is also somebody's surname.
    const canonical = [...CITIES_FILE.canonical];
    expect(canonical).toEqual([...canonical].sort());
    const aliasKeys = Object.keys(CITIES_FILE.aliases);
    expect(aliasKeys).toEqual([...aliasKeys].sort());
  });

  it("points every alias at a canonical member", () => {
    // An alias whose target is not canonical does not fail here in the lexicon — it fails at
    // apps/api BOOT, through the catalogue's round-trip guard, as a crash loop. A unit test is a
    // better place to learn it than a container that will not start.
    const canonical = new Set(CITIES_FILE.canonical);
    for (const [alias, target] of Object.entries(CITIES_FILE.aliases)) {
      expect(
        canonical.has(target),
        `alias "${alias}" points at "${target}", not a canonical city`,
      ).toBe(true);
    }
  });

  it("resolves every token it lists", () => {
    // The file and the matcher built from it, checked against each other directly. This is the
    // same drift the catalogue turns into a boot failure — asserted here so it is a red test on
    // the PR that causes it rather than a red deploy afterwards.
    for (const token of ALL_TOKENS) {
      expect(canonicalCity(token), `"${token}" is listed but does not resolve`).not.toBeNull();
    }
  });
});
