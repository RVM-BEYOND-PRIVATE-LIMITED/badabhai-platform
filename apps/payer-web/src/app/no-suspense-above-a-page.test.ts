import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, posix, relative } from "node:path";
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
 *   - a link into ANOTHER section (the rail's brand link from Postings and from Agency postings,
 *     the rail's Postings item) 30/30 — a fresh boundary mounts;
 *   - with no boundary above the page: 320/320 — the same eleven cases after hydration and in
 *     the sweep's own timing (networkidle + 4s), N=20 more on each link that had stalled, and
 *     clicks 250ms / 1s after hydration (the window where Agency postings -> a posting had
 *     committed 5/8 and 3/8). Re-run once the pending cue landed: 220/220 (the eleven cases
 *     × 10, both timings).
 * Next keys the `(portal)` loading boundary by the FIRST segment under it (`postings`, `agency`),
 * so it stays mounted — already visible — across /postings -> /postings/<id> and across every
 * /agency/* page. The navigation transition suspended inside that visible boundary on an RSC
 * response that had fully arrived, and was never woken: the URL never moved and the screen never
 * changed. When this fence landed payer-web rendered no query-only link (a crawl of every portal
 * route found none), so the same-section links were its trigger. Candidates (`/candidates`) now
 * renders them — its pager and "All postings" change only the query — which is admin-web's O-1
 * trigger exactly, and one more reason no boundary may come back.
 *
 * So the portal shows no route-level loading state: a navigation keeps the current page on
 * screen until the next one has rendered, and the link that started it shows the pending cue
 * (components/nav-pending.tsx — Next's `useLinkStatus`, no boundary). The same goes for every
 * other way to put a boundary above a page: no `<Suspense>`, no `React.lazy` (a lazy component
 * suspends into the nearest boundary), no `next/dynamic` (every call wraps `React.lazy`; with
 * `ssr: false` or a `loading` option it adds a `<Suspense>` of its own — next 15.5.25's
 * shared/lib/lazy-dynamic/loadable.js). Re-measure before adding one back
 * after a Next or React upgrade: on a production build, click a same-section link once the router
 * has committed (its `__NA` history write) and the link carries React's props, and count how often
 * the URL moves.
 */
const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const rel = (f: string) => relative(srcRoot, f).replace(/\\/g, "/");

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? files(p) : [p];
  });
}

const DYNAMIC = "next/dynamic";
/** React's own boundary members: a lazy component suspends into the nearest `<Suspense>`. */
const REACT_BOUNDARIES: ReadonlySet<string> = new Set(["Suspense", "lazy"]);

/**
 * For a module specifier, the names it exports that ARE React's `Suspense` / `lazy` — or null.
 * "react" itself by default; the source scan adds every BARREL that re-exports them, under
 * whatever name it gives them (`export { lazy as defer } from "react"`).
 */
type Boundaries = (specifier: string) => ReadonlySet<string> | null;
const reactOnly: Boundaries = (m) => (m === "react" ? REACT_BOUNDARIES : null);

const moduleName = (node: ts.Node | undefined): string | null =>
  node && ts.isStringLiteralLike(node) ? node.text : null;

/** `e` without the parentheses, `await`, `as` / `satisfies` and `!` wrapped around it. */
function unwrap(e: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isAwaitExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isSatisfiesExpression(e) ||
    ts.isNonNullExpression(e)
  ) {
    e = e.expression;
  }
  return e;
}

/** The specifier `node` loads with `require("…")` or `import("…")`, or null. */
function loaded(node: ts.Node): string | null {
  if (!ts.isCallExpression(node) || node.arguments.length !== 1) return null;
  const callee = node.expression;
  const isLoader =
    callee.kind === ts.SyntaxKind.ImportKeyword ||
    (ts.isIdentifier(callee) && callee.text === "require");
  return isLoader ? moduleName(node.arguments[0]) : null;
}

const parse = (code: string, file: string) =>
  ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

/**
 * Where `code` can put a Suspense boundary above a page — read from the AST, so a comment or a
 * string never counts:
 *  - React's `Suspense`: a named import or re-export (renamed or not) from anywhere, a member
 *    (`<React.Suspense>`), or destructured;
 *  - React's `lazy` (or a barrel's name for it): a named import or re-export, a member of a binding
 *    to React or the barrel (`React.lazy`, `R.lazy` after `import * as R` / `import R` /
 *    `require("react")` / `await import("react")`), or destructured from one — `await`,
 *    parentheses and type assertions unwrapped;
 *  - `export * from "react"` (it re-exports both);
 *  - `next/dynamic` loaded in any way (import, re-export, `import()`, `require`): every call
 *    wraps `React.lazy`, and `ssr: false` or a `loading` option adds a `<Suspense>` too.
 * A `lazy` that is not React's (zod's `z.lazy`, a `lazyData` field) is left alone.
 */
function boundaryUses(
  code: string,
  file = "x.tsx",
  boundariesOf: Boundaries = reactOnly,
): string[] {
  const sf = parse(code, file);
  const out: string[] = [];
  const hit = (node: ts.Node) => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    out.push(`${file}:${line + 1}`);
  };

  // Every local name bound to React or a barrel (plus the global `React` namespace), with the
  // boundary members reachable through it.
  const bound = new Map<string, ReadonlySet<string>>([["React", REACT_BOUNDARIES]]);
  const through = (e: ts.Expression): ReadonlySet<string> | null => {
    const inner = unwrap(e);
    if (ts.isIdentifier(inner)) return bound.get(inner.text) ?? null;
    const spec = loaded(inner);
    return spec === null ? null : boundariesOf(spec);
  };
  const bind = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      const names = boundariesOf(moduleName(node.moduleSpecifier) ?? "");
      const clause = node.importClause;
      if (names && clause?.name) bound.set(clause.name.text, names);
      const named = clause?.namedBindings;
      if (names && named && ts.isNamespaceImport(named)) bound.set(named.name.text, names);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const names = through(node.initializer);
      if (names) bound.set(node.name.text, names);
    }
    ts.forEachChild(node, bind);
  };
  bind(sf);
  const isBoundary = (name: string | null, names: ReadonlySet<string> | null) =>
    name === "Suspense" || (name !== null && names !== null && names.has(name));

  const visit = (node: ts.Node) => {
    // next/dynamic, however it is loaded.
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      moduleName(node.moduleSpecifier) === DYNAMIC
    ) {
      hit(node);
    } else if (loaded(node) === DYNAMIC) {
      hit(node);
    }
    // Named imports.
    if (ts.isImportSpecifier(node)) {
      const from = moduleName(node.parent.parent.parent.moduleSpecifier) ?? "";
      if (isBoundary((node.propertyName ?? node.name).text, boundariesOf(from))) hit(node);
    }
    // Re-exports: a barrel. `export *` (or `* as X`) from React re-exports both.
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const names = boundariesOf(moduleName(node.moduleSpecifier) ?? "");
      const clause = node.exportClause;
      if (names && (!clause || ts.isNamespaceExport(clause))) hit(node);
      if (clause && ts.isNamedExports(clause)) {
        for (const el of clause.elements) {
          if (isBoundary((el.propertyName ?? el.name).text, names)) hit(el);
        }
      }
    }
    // Members: `X.Suspense`; `React.lazy` / `React["lazy"]` / `(await import("react")).lazy`.
    if (ts.isPropertyAccessExpression(node)) {
      if (isBoundary(node.name.text, through(node.expression))) hit(node);
    }
    if (ts.isElementAccessExpression(node)) {
      const names = through(node.expression);
      if (names !== null && isBoundary(moduleName(node.argumentExpression), names)) hit(node);
    }
    // Destructured: `const { Suspense, lazy } = React` (= require("react"), = await import(…)).
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name)) {
      const names = node.initializer ? through(node.initializer) : null;
      for (const el of node.name.elements) {
        const key = el.propertyName ?? el.name;
        if (isBoundary(ts.isIdentifier(key) ? key.text : null, names)) hit(el);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** The names `code` re-exports that are boundary members (per `boundariesOf`) — a barrel's. */
function boundaryExports(code: string, boundariesOf: Boundaries): Set<string> {
  const out = new Set<string>();
  for (const st of parse(code, "x.tsx").statements) {
    if (!ts.isExportDeclaration(st) || !st.moduleSpecifier) continue;
    const names = boundariesOf(moduleName(st.moduleSpecifier) ?? "");
    if (!names) continue;
    if (!st.exportClause) names.forEach((n) => out.add(n));
    else if (ts.isNamedExports(st.exportClause)) {
      for (const el of st.exportClause.elements) {
        if (names.has((el.propertyName ?? el.name).text)) out.add(el.name.text);
      }
    }
  }
  return out;
}

/**
 * Every boundary use across `sources` (path -> code), each named relative to `root` (also the
 * `@/` alias root). A local module that re-exports React's `lazy` / `Suspense` is a BARREL: it is
 * flagged itself, and a consumer importing those names from it is flagged too — to a fixed point,
 * so a barrel of a barrel counts.
 */
function scanSources(sources: Map<string, string>, root: string): string[] {
  const slash = (p: string) => p.replace(/\\/g, "/");
  const base = slash(root);
  const files = new Map([...sources].map(([f, code]) => [slash(f), code] as const));
  const resolve = (from: string, spec: string): string | null => {
    const target = spec.startsWith("@/")
      ? posix.join(base, spec.slice(2))
      : spec.startsWith(".")
        ? posix.join(posix.dirname(from), spec)
        : null;
    if (target === null) return null;
    for (const ext of ["", ".ts", ".tsx", "/index.ts", "/index.tsx"]) {
      if (files.has(target + ext)) return target + ext;
    }
    return null;
  };
  const barrels = new Map<string, Set<string>>();
  const boundariesFor =
    (from: string): Boundaries =>
    (spec) => {
      if (spec === "react") return REACT_BOUNDARIES;
      const target = resolve(from, spec);
      return target === null ? null : (barrels.get(target) ?? null);
    };
  for (let changed = true; changed; ) {
    changed = false;
    for (const [f, code] of files) {
      const names = boundaryExports(code, boundariesFor(f));
      if (names.size > (barrels.get(f)?.size ?? 0)) {
        barrels.set(f, names);
        changed = true;
      }
    }
  }
  return [...files].flatMap(([f, code]) =>
    boundaryUses(code, posix.relative(base, f), boundariesFor(f)),
  );
}

describe("the detector", () => {
  it("finds a named import, a renamed one and a namespace member", () => {
    expect(boundaryUses('import { Suspense } from "react";')).toHaveLength(1);
    expect(boundaryUses('import { Suspense as S } from "react";')).toHaveLength(1);
    expect(
      boundaryUses("const x = <React.Suspense fallback={null}>a</React.Suspense>;"),
    ).toHaveLength(2);
  });

  it("finds next/dynamic however it is loaded (every call wraps React.lazy)", () => {
    expect(boundaryUses('import dynamic from "next/dynamic";')).toHaveLength(1);
    expect(boundaryUses('import load from "next/dynamic";')).toHaveLength(1);
    expect(boundaryUses('export { default } from "next/dynamic";')).toHaveLength(1);
    expect(boundaryUses('const m = await import("next/dynamic");')).toHaveLength(1);
    expect(boundaryUses('const dynamic = require("next/dynamic");')).toHaveLength(1);
  });

  it("finds React.lazy as a member, a named import (renamed or not) and through any React binding", () => {
    expect(boundaryUses('const C = React.lazy(() => import("./c"));')).toHaveLength(1);
    expect(boundaryUses('import * as R from "react"; R.lazy(() => import("./c"));')).toHaveLength(
      1,
    );
    expect(boundaryUses('import Re from "react"; Re.lazy(() => import("./c"));')).toHaveLength(1);
    expect(boundaryUses('import { lazy } from "react";')).toHaveLength(1);
    expect(boundaryUses('import { lazy as load } from "react";')).toHaveLength(1);
    expect(boundaryUses('const C = React["lazy"](() => import("./c"));')).toHaveLength(1);
  });

  it("finds Suspense and lazy destructured from React or require('react')", () => {
    expect(boundaryUses("const { Suspense } = React;")).toHaveLength(1);
    expect(boundaryUses("const { lazy } = React;")).toHaveLength(1);
    expect(boundaryUses('import R from "react"; const { lazy: load } = R;')).toHaveLength(1);
    expect(boundaryUses('const { Suspense, lazy } = require("react");')).toHaveLength(2);
  });

  it("leaves other React imports and the word in prose alone", () => {
    expect(boundaryUses('import { useState } from "react";')).toEqual([]);
    expect(boundaryUses("// a Suspense boundary held the transition")).toEqual([]);
  });

  it("never reads a comment or a string", () => {
    expect(boundaryUses('// import dynamic from "next/dynamic"; React.lazy(x)')).toEqual([]);
    expect(boundaryUses("/* const { lazy } = React; */ const a = 1;")).toEqual([]);
    expect(
      boundaryUses('const s = "next/dynamic"; const t = "React.lazy"; const u = `Suspense ${s}`;'),
    ).toEqual([]);
  });

  it("leaves a lazy that is not React's alone (zod's schema, a cache field, another module)", () => {
    expect(boundaryUses('import { z } from "zod"; const S = z.lazy(() => T);')).toEqual([]);
    expect(boundaryUses('import { lazy } from "zod";')).toEqual([]);
    expect(boundaryUses("const { lazyData } = node; node.lazy = 1;")).toEqual([]);
    expect(boundaryUses('const m = await import("./next/dynamic-ish");')).toEqual([]);
  });
});

describe("the detector — re-exports, barrels and an awaited import (review of #2115)", () => {
  it("finds a re-export of React's lazy or Suspense, however it is named — a barrel", () => {
    expect(boundaryUses('export { lazy } from "react";')).toHaveLength(1);
    expect(boundaryUses('export { Suspense as Boundary } from "react";')).toHaveLength(1);
    expect(boundaryUses('export { lazy, Suspense } from "react";')).toHaveLength(2);
    expect(boundaryUses('export * from "react";')).toHaveLength(1);
    expect(boundaryUses('export * as R from "react";')).toHaveLength(1);
  });

  it("leaves a re-export that is not React's lazy or Suspense alone", () => {
    expect(boundaryUses('export { useState } from "react";')).toEqual([]);
    expect(boundaryUses('export { lazy } from "zod";')).toEqual([]);
    expect(boundaryUses('export * from "./format";')).toEqual([]);
  });

  it("treats a module the caller names as React (a barrel) as React for its consumers", () => {
    const barrel = (m: string) =>
      m === "react" || m === "./ui" ? new Set(["lazy", "Suspense"]) : null;
    expect(boundaryUses('import { lazy } from "./ui";', "x.tsx", barrel)).toHaveLength(1);
    expect(boundaryUses('import * as UI from "./ui"; UI.lazy(f);', "x.tsx", barrel)).toHaveLength(
      1,
    );
    expect(
      boundaryUses('import UI from "./ui"; const { lazy } = UI;', "x.tsx", barrel),
    ).toHaveLength(1);
    expect(boundaryUses('import { lazy } from "./ui";')).toEqual([]);
  });

  it("unwraps await and parentheses: React loaded with import() and used in place", () => {
    // Inside an async function, as in a module: in a bare script `await (x)` is a call to `await`.
    const inAsync = (body: string) => boundaryUses(`async function load() { ${body} }`);
    expect(inAsync('const { lazy } = await import("react");')).toHaveLength(1);
    expect(inAsync('const { Suspense: S } = (await import("react"));')).toHaveLength(1);
    expect(inAsync('(await import("react")).lazy(() => x);')).toHaveLength(1);
    expect(inAsync('const R = await import("react"); R.lazy(f);')).toHaveLength(1);
    expect(inAsync('const R = (await (import("react"))); const { lazy } = R;')).toHaveLength(1);
    expect(inAsync('const R = (await import("react")) as typeof X; R.lazy(f);')).toHaveLength(1);
    expect(inAsync('const z = await import("zod"); z.lazy(f);')).toEqual([]);
  });

  it("the scan follows a barrel across files: the barrel AND each consumer of it", () => {
    const sources = new Map([
      // The barrel of a barrel comes FIRST, so one pass would miss it: the scan runs to a fixed point.
      ["/s/components/kit/index.ts", 'export { lazy as defer } from "../ui";'],
      ["/s/components/ui.ts", 'export { lazy, Suspense } from "react";'],
      ["/s/app/page.tsx", 'import { lazy } from "../components/ui";\nexport const P = lazy(f);'],
      ["/s/app/deep.tsx", 'import { defer } from "@/components/kit";'],
      ["/s/app/ns.tsx", 'import * as UI from "../components/ui";\nUI.lazy(f);'],
      [
        "/s/app/clean.tsx",
        'import { useState } from "react";\nimport { format } from "../lib/format";',
      ],
      ["/s/lib/format.ts", "export const format = (n: number) => String(n);"],
    ]);
    expect(scanSources(sources, "/s").sort()).toEqual([
      "app/deep.tsx:1",
      "app/ns.tsx:2",
      "app/page.tsx:1",
      "components/kit/index.ts:1",
      "components/ui.ts:1",
      "components/ui.ts:1",
    ]);
  });
});

describe("no Suspense boundary above a page in the portal", () => {
  it("no route segment ships a loading.tsx — Next would wrap every page below it in one", () => {
    const loading = files(join(srcRoot, "app")).filter((f) =>
      /^loading\.(tsx|ts|jsx|js)$/.test(f.split(/[\\/]/).pop()!),
    );
    expect(loading.map(rel)).toEqual([]);
  });

  it(
    "no layout, page or component uses Suspense, React.lazy or next/dynamic",
    { timeout: 30_000 },
    () => {
      const sources = files(srcRoot).filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f));
      expect(sources.length).toBeGreaterThan(50);
      const uses = scanSources(new Map(sources.map((f) => [f, readFileSync(f, "utf8")])), srcRoot);
      expect(uses).toEqual([]);
    },
  );
});
