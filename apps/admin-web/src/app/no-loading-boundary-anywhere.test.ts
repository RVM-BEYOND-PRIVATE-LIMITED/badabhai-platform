import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * NO SUSPENSE OR LOADING BOUNDARY ANYWHERE IN ADMIN-WEB — until it is re-measured (final
 * re-sweep O-1, review of #2095).
 *
 * THE RULE. No route `loading.tsx`, no `<Suspense>`, no `React.lazy`, and no `next/dynamic` with a
 * `loading` component — in any layout, page or component. A query-only navigation (a chip, a
 * filter, a page cursor) re-renders the SAME page, so any boundary in it is already on screen
 * when the navigation starts, and that is the case that stalled. Not only boundaries "above a
 * page": a boundary inside one is just as visible to the next query-only navigation of it.
 *
 * WHY. A link that changes only the query often did nothing at all. Measured on a PRODUCTION
 * build (next 15.5.25 and the React 19.2 canary it vendors), clicking only after the router's
 * first commit and the link's own hydration were both confirmed:
 *   - with `(portal)/loading.tsx` (as shipped): credits 90d 1/6, events correlation 2/6,
 *     Payment orders status 2/6 committed (the workers pager and a sidebar link 6/6); the Skill
 *     discovery chips 12/20 with that route's own loading.tsx;
 *   - with a `<Suspense>` in the layouts instead of loading.tsx: 77/80 — fewer, never none;
 *   - with no boundary: 100/100, then 400/400 on the final build (ten cases, the Engine view's
 *     picker and tabs included, in the sweep's own timing and after hydration).
 * In a stall the router's own state already held the new page, fully loaded. React had the
 * navigation transition suspended inside the already-visible boundary, on an RSC chunk that had
 * since resolved — no ping, no work scheduled — so the screen never changed and the URL never
 * moved. A route loading.tsx also sends every same-route navigation down Next's aliased-prefetch
 * path (the page fetched lazily inside the transition, then a second transition to patch it in),
 * which is what made the stall the common case rather than the rare one.
 *
 * So a navigation keeps the current page on screen until the next one has rendered, and the
 * clicked nav link shows that it is pending (`components/nav-pending.tsx`, `useLinkStatus` — no
 * boundary). Re-measure before relaxing this after a Next or React upgrade: on a production
 * build, click a query-only link once the router has committed and the link carries React's
 * props, and count how often the URL moves (a stub React DevTools hook exposes the root's
 * suspended, unpinged transition lanes when it does not).
 */
const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const rel = (f: string) => relative(srcRoot, f).replace(/\\/g, "/");

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? files(p) : [p];
  });
}

/** Every boundary a file introduces: `Suspense` (named or a member), `React.lazy` / `lazy`, and a `next/dynamic` call with `loading`. */
function boundaryUses(code: string, file = "x.tsx"): string[] {
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: string[] = [];

  // The local names the file gives React (default / namespace import) and next/dynamic.
  const reactNames = new Set(["React"]);
  const dynamicNames = new Set<string>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const clause = st.importClause;
    const from = st.moduleSpecifier.text;
    if (!clause) continue;
    if (from === "react") {
      if (clause.name) reactNames.add(clause.name.text);
      if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        reactNames.add(clause.namedBindings.name.text);
      }
    }
    if (from === "next/dynamic" && clause.name) dynamicNames.add(clause.name.text);
  }
  const importedFrom = (node: ts.Node, module: string) => {
    for (let n: ts.Node | undefined = node; n; n = n.parent) {
      if (ts.isImportDeclaration(n)) {
        return ts.isStringLiteral(n.moduleSpecifier) && n.moduleSpecifier.text === module;
      }
    }
    return false;
  };
  const hasLoadingOption = (call: ts.CallExpression) =>
    call.arguments.some(
      (a) =>
        ts.isObjectLiteralExpression(a) &&
        a.properties.some(
          (p) => p.name !== undefined && ts.isIdentifier(p.name) && p.name.text === "loading",
        ),
    );

  const visit = (node: ts.Node) => {
    const hit =
      // <Suspense>, under any import name, or as a member (`React.Suspense`).
      (ts.isImportSpecifier(node) && (node.propertyName ?? node.name).text === "Suspense") ||
      (ts.isPropertyAccessExpression(node) && node.name.text === "Suspense") ||
      // React.lazy: suspends until its chunk loads, into the nearest boundary.
      (ts.isImportSpecifier(node) &&
        (node.propertyName ?? node.name).text === "lazy" &&
        importedFrom(node, "react")) ||
      (ts.isPropertyAccessExpression(node) &&
        node.name.text === "lazy" &&
        ts.isIdentifier(node.expression) &&
        reactNames.has(node.expression.text)) ||
      // next/dynamic with a loading component: a Suspense boundary with a visible fallback.
      (ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        dynamicNames.has(node.expression.text) &&
        hasLoadingOption(node));
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
  it("finds Suspense: a named import, a renamed one and a namespace member", () => {
    expect(boundaryUses('import { Suspense } from "react";')).toHaveLength(1);
    expect(boundaryUses('import { Suspense as S } from "react";')).toHaveLength(1);
    expect(
      boundaryUses("const x = <React.Suspense fallback={null}>a</React.Suspense>;"),
    ).toHaveLength(2);
  });

  it("finds React.lazy, as a named import (renamed or not) and as a member of the React import", () => {
    expect(boundaryUses('import { lazy } from "react";')).toHaveLength(1);
    expect(boundaryUses('import { lazy as later } from "react";')).toHaveLength(1);
    expect(
      boundaryUses('import React from "react";\nconst X = React.lazy(() => import("./x"));'),
    ).toHaveLength(1);
    expect(
      boundaryUses('import * as R from "react";\nconst X = R.lazy(() => import("./x"));'),
    ).toHaveLength(1);
  });

  it("finds next/dynamic with a loading component, under any local name", () => {
    expect(
      boundaryUses(
        'import dynamic from "next/dynamic";\nconst X = dynamic(() => import("./x"), { loading: () => null });',
      ),
    ).toHaveLength(1);
    expect(
      boundaryUses(
        'import load from "next/dynamic";\nconst X = load(() => import("./x"), { ssr: false, loading: Spinner });',
      ),
    ).toHaveLength(1);
  });

  it("leaves other React imports, a non-React `lazy`, next/dynamic without loading and prose alone", () => {
    expect(boundaryUses('import { useState } from "react";')).toEqual([]);
    expect(boundaryUses("// a Suspense boundary held the transition")).toEqual([]);
    expect(boundaryUses('import { lazy } from "./my-utils";\nconst y = cache.lazy;')).toEqual([]);
    expect(
      boundaryUses(
        'import dynamic from "next/dynamic";\nconst X = dynamic(() => import("./x"), { ssr: false });',
      ),
    ).toEqual([]);
    expect(boundaryUses("const opts = { loading: true };\nfetchIt(opts, { loading: 1 });")).toEqual(
      [],
    );
  });
});

describe("no Suspense or loading boundary anywhere in admin-web", () => {
  it("no route segment ships a loading.tsx — Next would wrap every page below it in one", () => {
    const loading = files(join(srcRoot, "app")).filter((f) =>
      /^loading\.(tsx|ts|jsx|js)$/.test(f.split(/[\\/]/).pop()!),
    );
    expect(loading.map(rel)).toEqual([]);
  });

  it(
    "no layout, page or component renders a Suspense, React.lazy or next/dynamic loading boundary",
    { timeout: 30_000 },
    () => {
      const sources = files(srcRoot).filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f));
      expect(sources.length).toBeGreaterThan(50);
      const uses = sources.flatMap((f) => boundaryUses(readFileSync(f, "utf8"), rel(f)));
      expect(uses).toEqual([]);
    },
  );
});
