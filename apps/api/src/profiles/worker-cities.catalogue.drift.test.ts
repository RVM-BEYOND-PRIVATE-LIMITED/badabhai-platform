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

  it("boots when the two agree", async () => {
    // The control. Without it the two cases above would still pass against a module that threw
    // unconditionally, and this file would be asserting nothing about the real code path.
    vi.mocked(canonicalCity).mockImplementation((text: string) =>
      normalized(text.slice(0, 1).toUpperCase() + text.slice(1).toLowerCase()),
    );

    const { CITY_CATALOGUE } = await import("./worker-cities.catalogue");
    expect(CITY_CATALOGUE.length).toBeGreaterThan(0);
  });
});
