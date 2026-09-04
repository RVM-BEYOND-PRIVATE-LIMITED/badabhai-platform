import { describe, expect, it } from "vitest";
import { canonicalCity } from "@badabhai/profiling-lexicon";

import { SHEET_SHAPES } from "./__fixtures__/sheet-shapes";

/**
 * THE RATIFIED SHEETS AND THE WRITE PATH MUST AGREE ABOUT WHAT A CITY IS (#1409).
 *
 * WHAT THIS CAUGHT. `sheet-shapes.ts` — the fourteen-shape matrix whose numbering is quoted in the
 * journal and in CI evidence — printed `preferred_locations: [… "Bawal", "Neemrana"]` on shapes 8
 * and 9, while `PUT /workers/me/work-preferences` answered `unrecognised city: Neemrana` for the
 * same string. Faridabad, Gurugram, Manesar and Bawal all resolve; Neemrana was the only
 * non-resolving member of an otherwise fully-resolving NCR-belt list. So the product's own
 * ratified output named a preferred location the product refused to accept, and nothing anywhere
 * compared the two.
 *
 * WHY THIS TEST RATHER THAN JUST ADDING THE CITY. Adding Neemrana fixes today. This fixes the
 * CLASS: the gazetteer is a hand-maintained list of manufacturing hubs, it will keep growing, and
 * the next divergence is otherwise found the way this one was — by a worker on a real device, via
 * a 400 he cannot act on. After this, a ratified fixture carrying a city the write path rejects is
 * a red CI job.
 *
 * ROUND-TRIP TO ITSELF, not merely non-null. `canonicalCity("Gurgaon")` resolves — to "Gurugram" —
 * so a fixture spelling a city the way the sheet would NOT print it is also a defect, and
 * `=== value` is what catches it. This is the same guarantee `worker-cities.catalogue.test.ts`
 * asserts from the other end, pointed at the fixtures instead of at the option list.
 *
 * SCOPED TO `current_city` AND `preferred_locations`, DELIBERATELY. Those are the two fields the
 * write path gates. Employer cities are NOT included: `worker-employment.dto.ts` takes them as
 * free text on purpose — there is no register of employer locations to validate against — and
 * shape 11 legitimately carries Dubai and Dammam, which a gazetteer scoped to "Indian
 * manufacturing-hub cities" should not resolve. Widening this test to employers would force that
 * scope question to a red build instead of leaving it the owner ruling it is (#1409).
 */

/** Every gated city string in the matrix, tagged with the shape it came from. */
function gatedCities(): ReadonlyArray<{ shape: number; field: string; value: string }> {
  const found: Array<{ shape: number; field: string; value: string }> = [];

  for (const shape of SHEET_SHAPES) {
    // Shape 14 carries `snapshot: {}` — a profile with no resume_profile at all, which is a real
    // shape (the empty sheet) and simply has no city to check.
    const profile = shape.snapshot["resume_profile"];
    if (typeof profile !== "object" || profile === null) continue;
    const fields = profile as Record<string, unknown>;

    const current = fields["current_city"];
    if (typeof current === "string") {
      found.push({ shape: shape.n, field: "current_city", value: current });
    }

    const preferred = fields["preferred_locations"];
    if (Array.isArray(preferred)) {
      for (const value of preferred) {
        if (typeof value === "string") {
          found.push({ shape: shape.n, field: "preferred_locations", value });
        }
      }
    }
  }

  return found;
}

describe("the ratified sheet shapes' cities", () => {
  it("only name cities the write path accepts, spelled the way it stores them", () => {
    for (const { shape, field, value } of gatedCities()) {
      expect(
        canonicalCity(value)?.value,
        `ratified sheet shape ${shape} ships ${field} "${value}", which the write path 400s on`,
      ).toBe(value);
    }
  });

  it("actually checked the matrix — a renamed fixture field must not pass silently", () => {
    // WITHOUT THIS the suite above is green when `preferred_locations` is renamed, when
    // `resumeProfile()` stops spreading its defaults, or when `SHEET_SHAPES` is emptied — every
    // one of which is a change that should be noticed. Thirteen of the fourteen shapes carry a
    // profile, each with one current_city and at least two preferred locations.
    const checked = gatedCities();
    expect(checked.length).toBeGreaterThanOrEqual(13);
    expect(new Set(checked.map((c) => c.shape)).size).toBeGreaterThanOrEqual(13);
    expect(checked.some((c) => c.field === "current_city")).toBe(true);
    expect(checked.some((c) => c.field === "preferred_locations")).toBe(true);
  });
});
