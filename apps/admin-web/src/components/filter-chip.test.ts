import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { filterChipClass } from "./filter-chip";

/**
 * A SELECTED filter chip is a state, not an action (final sweep AW-11). Selected chips reused
 * `.btn--primary`, so /skills/discovery showed five Safety-Yellow-filled controls at once
 * (Grouped, Awaiting decision, Direct (default), Biggest batch first, Apply) and /credits put
 * one inside its header's filter row — the one fill that marks THE action of a screen marked
 * five things. A chip's selected state is `.btn--selected` (fenced in
 * a11y-foundations.css.test.ts); `.btn--primary` is left to the one action.
 */
describe("filterChipClass", () => {
  it("a selected chip takes the selected state, never the primary fill", () => {
    expect(filterChipClass(true)).toBe("btn btn--sm btn--selected");
    expect(filterChipClass(true)).not.toContain("btn--primary");
  });

  it("an unselected chip is the quiet ghost it always was", () => {
    expect(filterChipClass(false)).toBe("btn btn--sm btn--ghost");
  });

  it("a full-size chip row (the credits window) drops only the size modifier", () => {
    expect(filterChipClass(true, "md")).toBe("btn btn--selected");
    expect(filterChipClass(false, "md")).toBe("btn btn--ghost");
  });
});

// ---- the source fence ---------------------------------------------------------------------

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return /\.tsx$/.test(e.name) && !/\.test\.tsx$/.test(e.name) ? [p] : [];
  });
}

/**
 * Elements that carry a SELECTION state (`aria-current` or `aria-pressed`) and can render
 * `btn--primary` in their className — in any branch of it, a literal, a template or a ternary.
 */
function primarySelections(code: string, file = "x.tsx"): string[] {
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const attrs = node.attributes.properties.filter(ts.isJsxAttribute);
      const name = (a: ts.JsxAttribute) => a.name.getText(sf);
      const selects = attrs.some((a) => name(a) === "aria-current" || name(a) === "aria-pressed");
      const cls = attrs.find((a) => name(a) === "className");
      if (selects && cls?.initializer && cls.initializer.getText(sf).includes("btn--primary")) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        out.push(`${file}:${line + 1}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

describe("the detector", () => {
  it("catches a selected chip drawn primary, in a literal or any branch", () => {
    expect(
      primarySelections(
        '<Link aria-current="true" className="btn btn--sm btn--primary" href="/" />',
      ),
    ).toHaveLength(1);
    expect(
      primarySelections(
        '<Link aria-current={on ? "true" : undefined} className={`btn ${on ? "btn--primary" : "btn--ghost"}`}>x</Link>',
      ),
    ).toHaveLength(1);
    expect(
      primarySelections(
        '<button aria-pressed={on} className={on ? "btn btn--primary" : "btn"}>x</button>',
      ),
    ).toHaveLength(1);
  });

  it("leaves the one real primary action alone, and a selected chip in its own state", () => {
    expect(
      primarySelections('<button className="btn btn--primary" type="submit">Apply</button>'),
    ).toEqual([]);
    expect(
      primarySelections('<Link aria-current="true" className={filterChipClass(true)} href="/" />'),
    ).toEqual([]);
  });
});

describe("no selected chip anywhere in the console is drawn as a primary action", () => {
  // Parses every TSX file in the console with the TypeScript compiler: well under a second alone,
  // but past vitest's 5 s default on a shared CI runner under turbo's parallel `test --coverage`
  // (5,204 ms on #2039). Same explicit budget as the other whole-tree sweeps (#2023, #2026).
  it("walks every component", { timeout: 30_000 }, () => {
    const files = sources(srcRoot);
    expect(files.length).toBeGreaterThan(50);
    const offenders = files.flatMap((f) =>
      primarySelections(readFileSync(f, "utf8"), relative(srcRoot, f).replace(/\\/g, "/")),
    );
    expect(offenders).toEqual([]);
  });
});
