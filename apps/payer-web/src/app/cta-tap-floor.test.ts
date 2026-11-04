import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { decl, parseRules, stripComments, tokenValue } from "../../test/css-rules";

/**
 * #2588 (W8) — a CTA never ships under the 44px tap floor, hand-rolled or not.
 *
 * The DS `Button` refuses `size="sm"` on a primary / success / danger action (components/ds/
 * forms.tsx: `sm` draws the 36px --control-sm, under the --control-md floor a real action must
 * clear). A class string written by hand — a `PortalLink` dressed as a button, a bare `<button>` —
 * never meets that guard, and five shipped primary at `sm`: both posting forms' "Next" steps, the
 * accepted invite's dashboard link and the agency funnel's "Invite workers" (36px on a desktop
 * pointer). They are `md` now; this fence keeps every hand-written class string that way.
 *
 * Source-level, over every non-test `.ts`/`.tsx` under `src/`: no string literal names a CTA
 * variant beside `bb-btn--sm`. (A class composed from separate pieces is the DS Button's job —
 * use the component.)
 */
const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "..");

const CTA = /(?<![\w-])bb-btn--(primary|success|danger)(?![\w-])/;
const SMALL = /(?<![\w-])bb-btn--sm(?![\w-])/;
/** A single-line string literal, or a template literal (which may span lines). */
const LITERAL = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(ent.name) && !/\.test\.tsx?$/.test(ent.name)) out.push(full);
  }
  return out;
}

/** The class strings in `source` that put a CTA variant at the small size. */
function smallCtaClasses(source: string): string[] {
  return Array.from(source.matchAll(LITERAL), (m) => m[0]).filter(
    (lit) => CTA.test(lit) && SMALL.test(lit),
  );
}

const FILES = sourceFiles(SRC).map((file) => ({
  file: relative(SRC, file),
  source: readFileSync(file, "utf8"),
}));

describe("#2588 · no hand-rolled CTA below the tap floor", () => {
  it("scans the sources it guards, and the hand-rolled CTAs are in them (vacuity check)", () => {
    expect(FILES.length).toBeGreaterThan(100);
    const handRolledCtas = FILES.flatMap(({ source }) =>
      Array.from(source.matchAll(LITERAL), (m) => m[0]).filter((lit) => CTA.test(lit)),
    );
    expect(handRolledCtas.length).toBeGreaterThan(10);
  });

  it("the checker flags a CTA at sm in any quoting, and passes md CTAs and small secondaries", () => {
    expect(smallCtaClasses(`<a className="bb-btn bb-btn--primary bb-btn--sm">`)).toHaveLength(1);
    expect(smallCtaClasses(`cls = 'bb-btn bb-btn--sm bb-btn--danger'`)).toHaveLength(1);
    expect(smallCtaClasses("className={`bb-btn bb-btn--success bb-btn--sm ${x}`}")).toHaveLength(1);
    expect(smallCtaClasses(`<a className="bb-btn bb-btn--primary">`)).toEqual([]);
    expect(smallCtaClasses(`<a className="bb-btn bb-btn--secondary bb-btn--sm">`)).toEqual([]);
    expect(smallCtaClasses(`<a className="bb-btn bb-btn--primary bb-btn--small-print">`)).toEqual(
      [],
    );
  });

  it("no source pairs bb-btn--primary / --success / --danger with bb-btn--sm", () => {
    const bad = FILES.flatMap(({ file, source }) =>
      smallCtaClasses(source).map((lit) => `${file}: ${lit}`),
    );
    expect(bad).toEqual([]);
  });

  it("the size every one of them now takes is the 44px floor (md), and sm is not", () => {
    const tokens = stripComments(
      readFileSync(
        join(here, "..", "..", "..", "..", "packages", "design-tokens", "tokens.css"),
        "utf8",
      ),
    );
    const ds = parseRules(
      stripComments(readFileSync(join(here, "..", "styles", "ds-components.css"), "utf8")),
    );
    const base = ds.find((r) => r.at === "" && r.selector === ".bb-btn")!;
    const small = ds.find(
      (r) => r.at === "" && r.selector.includes(".bb-btn--sm") && decl(r, "height"),
    )!;
    expect(decl(base, "height")).toBe("var(--control-md)");
    expect(decl(base, "min-height")).toBe("var(--control-md)");
    expect(tokenValue(tokens, "--control-md")).toBe("44px");
    expect(decl(small, "height")).toBe("var(--control-sm)");
    expect(tokenValue(tokens, "--control-sm")).toBe("36px");
  });
});
