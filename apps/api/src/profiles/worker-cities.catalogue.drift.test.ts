import { describe, it, expect, vi, beforeEach } from "vitest";
import { canonicalCity } from "@badabhai/profiling-lexicon";
// The subpath import is NOT intercepted by the mock below, which targets the bare specifier — so
// this is the real gazetteer, and the first token it lists is the one the catalogue trips over
// first. Derived rather than spelled, because spelling it would make this suite fail the day
// somebody adds a city sorting before it.
import CITIES_FILE from "@badabhai/profiling-lexicon/data/cities.json";

/**
 * The catalogue's FAIL-CLOSED paths (#1406).
 *
 * Its own file because it mocks `@badabhai/profiling-lexicon`, and the sibling suite asserts the
 * round trip against the REAL normalizer — a mock leaking into that would turn the one test that
 * matters into a test of itself. Vitest isolates the module registry per file, so the two coexist.
 *
 * WHY MOCK AT ALL, rather than leave these lines uncovered as "unreachable". They are not
 * unreachable, they are unreachable-today: `canonicalCity` matches the copy of `cities.json`
 * embedded in the lexicon's generated reader, while the catalogue imports the canonical file, and
 * the guard that keeps those two in step (`pnpm lexicon:verify`) runs in a different package than
 * the one that would break. Drift is exactly the scenario these throws exist for, and a
 * fail-closed path nobody has ever executed is a guess about what happens in the one situation it
 * was written for.
 */
vi.mock("@badabhai/profiling-lexicon", () => ({ canonicalCity: vi.fn() }));

function normalized(value: string) {
  return { value, span: { start: 0, end: value.length }, negationVetoed: false };
}

describe("the city catalogue when the gazetteer and its matcher disagree", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.mocked(canonicalCity).mockReset();
  });

  it("refuses to boot when a gazetteer token no longer resolves", async () => {
    // The realistic drift: a city is added to data/cities.json and the generated reader is stale,
    // so the file offers a token the matcher has never heard of. Serving it would advertise a
    // value the write endpoint 400s on — the precise failure #1406 is about, caused by us.
    vi.mocked(canonicalCity).mockReturnValue(null);

    const firstToken = CITIES_FILE.canonical[0]!;
    await expect(import("./worker-cities.catalogue")).rejects.toThrow(
      new RegExp(`city gazetteer drift: "${firstToken}"`),
    );
    // And it names the remedy, because the reader of a boot crash is on-call, not in this file.
    await expect(import("./worker-cities.catalogue")).rejects.toThrow(/pnpm lexicon:verify/);
  });

  it("refuses to boot when a resolved value does not resolve to itself", async () => {
    // The subtler drift: every token resolves, so the loop above passes, but the resulting display
    // value is rewritten when fed back. A worker would pick "Mumbai" and have "Delhi" stored.
    vi.mocked(canonicalCity).mockImplementation((text: string) =>
      normalized(text === "Mumbai" ? "Delhi" : "Mumbai"),
    );

    await expect(import("./worker-cities.catalogue")).rejects.toThrow(
      /does not round-trip: "Mumbai"/,
    );
  });

  it("refuses to boot when a canonical city carries no state tag (#1429)", async () => {
    // The state-dimension drift: a city is added to `canonical` and nobody adds its `states` row.
    // Serving it would put a city in the flat list that no state filter can reach — the #1406 dead
    // end one layer in, and invisible to the round-trip check above because the value is fine.
    //
    // FORCED ON EXACTLY ONE CITY, not all of them. Resolving every token to one value would fold
    // 38 differently-tagged canonical entries together and trip the CONFLICT branch instead — a
    // different guard, and the test would pass while asserting nothing about this one. So only
    // "banglore" (an alias key, and therefore untagged by design — aliases inherit their canonical
    // member's state) is diverted to a value nothing tags, and every other token resolves
    // faithfully.
    vi.mocked(canonicalCity).mockImplementation((text: string) => {
      const token = text.trim().toLowerCase();
      if (token === "banglore" || token === "atlantis") return normalized("Atlantis");
      const canonical = (CITIES_FILE.aliases as Record<string, string>)[token] ?? token;
      return normalized(canonical.replace(/(^|\s)\S/g, (c) => c.toUpperCase()));
    });

    await expect(import("./worker-cities.catalogue")).rejects.toThrow(
      /city gazetteer gap: "Atlantis" has no entry in data\/cities\.json/,
    );
    // It names the obligation, because the reader of a boot crash is on-call, not in this file.
    await expect(import("./worker-cities.catalogue")).rejects.toThrow(/must carry a state/);
  });

  it("boots when the two agree", async () => {
    // The control. Without it the cases above would still pass against a module that threw
    // unconditionally, and this file would be asserting nothing about the real code path.
    //
    // THE MOCK IS FAITHFUL RATHER THAN CONVENIENT, and #1429 is why it had to become so. It used
    // to upper-case the first character only, which resolved "banglore" to "Banglore" — a value
    // the real matcher never produces. That was harmless while the catalogue only grouped
    // aliases; once every city must also carry a state, an invented city has no tag and the
    // control started failing on a condition the product cannot reach. Mirroring the real alias
    // fold keeps this a test of the happy path rather than of the mock.
    vi.mocked(canonicalCity).mockImplementation((text: string) => {
      const token = text.trim().toLowerCase();
      const canonical = (CITIES_FILE.aliases as Record<string, string>)[token] ?? token;
      return normalized(canonical.replace(/(^|\s)\S/g, (c) => c.toUpperCase()));
    });

    const { CITY_CATALOGUE } = await import("./worker-cities.catalogue");
    expect(CITY_CATALOGUE.length).toBeGreaterThan(0);
    // And the happy path really did tag every one of them — otherwise "boots" would be satisfied
    // by a catalogue that silently dropped the field this test exists to protect.
    for (const city of CITY_CATALOGUE) expect(city.state).toBeTruthy();
  });
});
