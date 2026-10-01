import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * ONE "Clear filters" per list screen (owner brief 2026-10-01). Ten screens rendered it twice —
 * in the results head and again inside the empty or error state, often both on screen at once —
 * and Feedback could show three links to /feedback. The results head now owns it, shown
 * whenever a filter is set; a state offers only a recovery nothing else on screen does.
 *
 * Read from source, where the claim is structural: each screen writes the words exactly once.
 * The render tests (feedback, ai-calls) check the on-screen count for the worst offenders.
 */
const here = dirname(fileURLToPath(import.meta.url));
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const code = (rel: string) => stripComments(readFileSync(join(here, rel), "utf8"));

/** Visible "Clear filter(s)" labels in a component's code: JSX text or a string literal. */
const clearLabels = (src: string): number =>
  (src.match(/(>\s*|")Clear filters?(\s*<|")/g) ?? []).length;

const LIST_SCREENS = [
  "workers/page.tsx",
  "jobs/page.tsx",
  "events/page.tsx",
  "companies/page.tsx",
  "agencies/page.tsx",
  "ai-calls/page.tsx",
  "feedback/page.tsx",
  "credits/page.tsx",
  "transactions/page.tsx",
  "admins/page.tsx",
];

describe("the detector", () => {
  it("counts JSX text and string literals, singular and plural, and nothing else", () => {
    expect(clearLabels("<Link>\n  Clear filters\n</Link>")).toBe(1);
    expect(clearLabels('{x ? "Clear filters" : "Clear filter"}')).toBe(2);
    expect(clearLabels("<button>Clear these fields</button>")).toBe(0);
    expect(clearLabels("<p>clear the filters above</p>")).toBe(0);
  });
});

describe("one Clear filters per list screen", () => {
  for (const screen of LIST_SCREENS) {
    it(screen, () => {
      expect(clearLabels(code(screen))).toBe(1);
    });
  }

  it("and it is always the plural — one label, whatever the number of filters", () => {
    for (const screen of LIST_SCREENS) {
      expect(code(screen), screen).not.toMatch(/(>\s*|")Clear filter(\s*<|")/);
    }
  });
});
