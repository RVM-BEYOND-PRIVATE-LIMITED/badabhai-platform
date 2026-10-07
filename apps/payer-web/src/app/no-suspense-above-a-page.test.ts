import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import ts from "typescript";

/**
 * NO SUSPENSE BOUNDARY ABOVE A PAGE — and so no route `loading.tsx` (the admin-web O-1 stall,
 * re-measured on this portal).
 *
 * With `(portal)/loading.tsx` (as shipped until this test), a link to another page in the SAME
 * section often did nothing at all. Measured on a PRODUCTION build (next 15.5.25, React 19.2),
 * clicking only after the router's first commit and the link's own hydration were confirmed,
 * N=10 each:
 *   - Postings -> a posting's title 7/10, Agency postings -> a posting's title 3/10, Agency
 *     postings -> the rail's "Worker activity" 6/10 committed; a same-route query change pushed
 *     through the router (`?reached=` dropped) 8/10;
 *   - a link into ANOTHER section (the rail's brand link / Postings item) 30/30 — a fresh
 *     boundary mounts;
 *   - with no boundary above the page: 320/320 — the same eleven cases after hydration and in
 *     the sweep's own timing (networkidle + 4s), N=20 more on each link that had stalled, and
 *     clicks 250ms / 1s after hydration (the window where Agency postings -> a posting had
 *     committed 5/8 and 3/8).
 * Next keys the `(portal)` loading boundary by the FIRST segment under it (`postings`, `agency`),
 * so it stays mounted — already visible — across /postings -> /postings/<id> and across every
 * /agency/* page. The navigation transition suspended inside that visible boundary on an RSC
 * response that had fully arrived, and was never woken: the URL never moved and the screen never
 * changed. payer-web renders no query-only link today (a crawl of every portal route found none),
 * so the same-section links ARE its trigger.
 *
 * So the portal shows no route-level loading state: a navigation keeps the current page on
 * screen until the next one has rendered. Re-measure before adding one back after a Next or
 * React upgrade: on a production build, click a same-section link once the router has committed
 * (its `__NA` history write) and the link carries React's props, and count how often the URL
 * moves.
 */
const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const rel = (f: string) => relative(srcRoot, f).replace(/\\/g, "/");

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? files(p) : [p];
  });
}

/** Where `code` binds React's `Suspense`: a named import (renamed or not), or `X.Suspense`. */
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

describe("no Suspense boundary above a page in the portal", () => {
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
