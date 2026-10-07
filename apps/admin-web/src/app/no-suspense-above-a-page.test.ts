import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * NO SUSPENSE BOUNDARY ABOVE A PAGE — and so no route `loading.tsx` (final re-sweep O-1).
 *
 * A link that changes only the query (/credits "90d", an events correlation id, a status chip)
 * often did nothing at all. Measured on a PRODUCTION build (next 15.5.25 and the React 19.2
 * canary it vendors), clicking only after the router's first commit and the link's own
 * hydration were both confirmed:
 *   - with `(portal)/loading.tsx` (as shipped): credits 90d 1/6, events correlation 2/6,
 *     Payment orders status 2/6 committed (the workers pager and a sidebar link 6/6); the Skill
 *     discovery chips 12/20 with that route's own loading.tsx;
 *   - with a `<Suspense>` in the layouts instead of loading.tsx: 77/80 — fewer, never none;
 *   - with no boundary above the page: 100/100, then 400/400 on the final build (ten cases, the
 *     Engine view's picker and tabs included, in the sweep's own timing and after hydration).
 * In a stall the router's own state already held the new page, fully loaded. React had the
 * navigation transition suspended inside the already-visible boundary, on an RSC chunk that had
 * since resolved — no ping, no work scheduled — so the screen never changed and the URL never
 * moved. A route loading.tsx also sends every same-route navigation down Next's aliased-prefetch
 * path (the page fetched lazily inside the transition, then a second transition to patch it in),
 * which is what made the stall the common case rather than the rare one.
 *
 * So the portal shows no route-level loading state: a navigation keeps the current page on
 * screen until the next one has rendered. Re-measure before adding one back after a Next or
 * React upgrade: on a production build, click a query-only link once the router has committed
 * and the link carries React's props, and count how often the URL moves (a stub React DevTools
 * hook exposes the root's suspended, unpinged transition lanes when it does not).
 */
const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const rel = (f: string) => relative(srcRoot, f).replace(/\\/g, "/");

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? files(p) : [p];
  });
}

/** Names bound to React's `Suspense` in `code`: a named import, or `React.Suspense` / `X.Suspense`. */
function suspenseUses(code: string, file = "x.tsx"): string[] {
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    const hit =
      (ts.isImportSpecifier(node) && (node.propertyName ?? node.name).text === "Suspense") ||
      (ts.isPropertyAccessExpression(node) && node.name.text === "Suspense");
    if (hit) {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      out.push(`${file}:${line + 1}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

describe("the detector", () => {
  it("finds a named import, a renamed one and a namespace member", () => {
    expect(suspenseUses('import { Suspense } from "react";')).toHaveLength(1);
    expect(suspenseUses('import { Suspense as S } from "react";')).toHaveLength(1);
    expect(
      suspenseUses("const x = <React.Suspense fallback={null}>a</React.Suspense>;"),
    ).toHaveLength(2);
  });

  it("leaves other React imports and the word in prose alone", () => {
    expect(suspenseUses('import { useState } from "react";')).toEqual([]);
    expect(suspenseUses("// a Suspense boundary held the transition")).toEqual([]);
  });
});

describe("no Suspense boundary above a page in the console", () => {
  it("no route segment ships a loading.tsx — Next would wrap every page below it in one", () => {
    const loading = files(join(srcRoot, "app")).filter((f) =>
      /^loading\.(tsx|ts|jsx|js)$/.test(f.split(/[\\/]/).pop()!),
    );
    expect(loading.map(rel)).toEqual([]);
  });

  it("no layout, page or component renders a <Suspense> of its own", { timeout: 30_000 }, () => {
    const sources = files(srcRoot).filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f));
    expect(sources.length).toBeGreaterThan(50);
    const uses = sources.flatMap((f) => suspenseUses(readFileSync(f, "utf8"), rel(f)));
    expect(uses).toEqual([]);
  });
});
