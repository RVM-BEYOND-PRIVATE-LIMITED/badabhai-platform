import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * NO SUSPENSE OR LOADING BOUNDARY ANYWHERE IN ADMIN-WEB — until it is re-measured (final
 * re-sweep O-1, review of #2095).
 *
 * THE RULE. No route `loading.tsx`, no `<Suspense>`, no `React.lazy`, and no `next/dynamic` at all
 * (every call is a React.lazy; `ssr: false` is a Suspense boundary) — in any layout, page or
 * component. A query-only navigation (a chip, a filter, a page cursor) re-renders the SAME page,
 * so any boundary in it is already on screen when the navigation starts, and that is the case
 * that stalled. Not only boundaries "above a page": a boundary inside one is just as visible to
 * the next query-only navigation of it.
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

/**
 * Every boundary a file introduces, read from the TypeScript AST (so comments and strings never
 * count): `Suspense` (imported, a member, or destructured from React), `React.lazy` (the same
 * three ways), and ANY `next/dynamic` — every `dynamic()` wraps its loader in React.lazy, and with
 * `ssr: false` renders it inside a `<Suspense>` (next 15.5.25, shared/lib/lazy-dynamic/loadable.js),
 * `loading` or not.
 */
function boundaryUses(code: string, file = "x.tsx"): string[] {
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: string[] = [];

  const isReact = (spec: string) => spec === "react";
  /** `next/dynamic`, and its file path (`next/dynamic.js`) — every spelling resolves to it. */
  const isDynamic = (spec: string) => /^next\/dynamic(?:\.[cm]?js)?$/.test(spec);
  /** A module specifier written as a string or a substitution-free template literal. */
  const specifier = (e: ts.Node | undefined): string | null =>
    e && (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) ? e.text : null;
  /** `require(m)` or `import(m)`, awaited or parenthesised or not, of a module `test` accepts. */
  const loads = (e: ts.Expression | undefined, test: (spec: string) => boolean): boolean => {
    if (!e) return false;
    if (ts.isAwaitExpression(e) || ts.isParenthesizedExpression(e))
      return loads(e.expression, test);
    if (!ts.isCallExpression(e)) return false;
    const callee = e.expression;
    const isLoader =
      callee.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(callee) && callee.text === "require");
    const spec = specifier(e.arguments[0]);
    return isLoader && spec !== null && test(spec);
  };

  // The local names the file gives React: a default or namespace import, or a name bound to
  // `require("react")` / `await import("react")`.
  const reactNames = new Set(["React"]);
  const collect = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && isReact(specifier(node.moduleSpecifier) ?? "")) {
      const clause = node.importClause;
      if (clause?.name) reactNames.add(clause.name.text);
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        reactNames.add(clause.namedBindings.name.text);
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      loads(node.initializer, isReact)
    ) {
      reactNames.add(node.name.text);
    }
    ts.forEachChild(node, collect);
  };
  collect(sf);

  const BANNED = new Set(["Suspense", "lazy"]);
  const isReactName = (e: ts.Expression) => ts.isIdentifier(e) && reactNames.has(e.text);
  const importedFrom = (node: ts.Node, test: (spec: string) => boolean) => {
    for (let n: ts.Node | undefined = node; n; n = n.parent) {
      if (ts.isImportDeclaration(n)) return test(specifier(n.moduleSpecifier) ?? "");
    }
    return false;
  };
  /** `const { Suspense } = React`, `const { lazy: l } = require("react")`. */
  const fromReact = (e: ts.Expression | undefined) =>
    e !== undefined && (isReactName(e) || loads(e, isReact));

  const visit = (node: ts.Node) => {
    const hit =
      // <Suspense>, under any import name, or as a member (`React.Suspense`).
      (ts.isImportSpecifier(node) && (node.propertyName ?? node.name).text === "Suspense") ||
      (ts.isPropertyAccessExpression(node) && node.name.text === "Suspense") ||
      // React.lazy: suspends until its chunk loads, into the nearest boundary.
      (ts.isImportSpecifier(node) &&
        (node.propertyName ?? node.name).text === "lazy" &&
        importedFrom(node, isReact)) ||
      (ts.isPropertyAccessExpression(node) &&
        node.name.text === "lazy" &&
        isReactName(node.expression)) ||
      // Either as a bracketed member of React: `React["lazy"]`.
      (ts.isElementAccessExpression(node) &&
        isReactName(node.expression) &&
        BANNED.has(specifier(node.argumentExpression) ?? "")) ||
      // Either, destructured from React: `const { Suspense, lazy: l } = React`.
      (ts.isBindingElement(node) &&
        ts.isObjectBindingPattern(node.parent) &&
        ts.isVariableDeclaration(node.parent.parent) &&
        fromReact(node.parent.parent.initializer) &&
        BANNED.has(((node.propertyName ?? node.name) as ts.Identifier).text)) ||
      // next/dynamic, however it is loaded or re-exported.
      ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        isDynamic(specifier(node.moduleSpecifier) ?? "")) ||
      (ts.isCallExpression(node) && loads(node, isDynamic));
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

  it("finds ANY next/dynamic import — every call is a React.lazy, and ssr:false a Suspense boundary", () => {
    // next 15.5.25: `dynamic()` wraps the loader in React.lazy, and `ssr: false` renders it
    // inside a <Suspense> (shared/lib/lazy-dynamic/loadable.js) — with or without `loading`.
    expect(
      boundaryUses(`import dynamic from "next/dynamic";
const X = dynamic(() => import("./x"), { loading: () => null });`),
    ).toHaveLength(1);
    expect(
      boundaryUses(`import load from "next/dynamic";
const X = load(() => import("./x"), { ssr: false });`),
    ).toHaveLength(1);
    expect(boundaryUses('import dynamic from "next/dynamic";')).toHaveLength(1);
    expect(boundaryUses('const { default: d } = await import("next/dynamic");')).toHaveLength(1);
    expect(boundaryUses('const d = require("next/dynamic");')).toHaveLength(1);
  });

  it("finds every other spelling of next/dynamic: a template import(), a re-export, the .js path", () => {
    expect(boundaryUses("const d = await import(`next/dynamic`);")).toHaveLength(1);
    expect(boundaryUses('export { default } from "next/dynamic";')).toHaveLength(1);
    expect(boundaryUses('export { default as load } from "next/dynamic";')).toHaveLength(1);
    expect(boundaryUses('export * from "next/dynamic";')).toHaveLength(1);
    expect(boundaryUses('import dynamic from "next/dynamic.js";')).toHaveLength(1);
    expect(boundaryUses('const d = require("next/dynamic.js");')).toHaveLength(1);
  });

  it("finds React bound by require() or import(), and a bracketed member", () => {
    expect(boundaryUses('const R = require("react");\nconst X = R.lazy(load);')).toHaveLength(1);
    expect(boundaryUses('const R = require("react");\nconst { Suspense } = R;')).toHaveLength(1);
    expect(boundaryUses('const R = await import("react");\nconst X = R.lazy(load);')).toHaveLength(
      1,
    );
    expect(boundaryUses('import React from "react";\nconst X = React["lazy"](load);')).toHaveLength(
      1,
    );
    expect(boundaryUses('const R = require("react");\nconst S = R["Suspense"];')).toHaveLength(1);
  });

  it("leaves look-alikes alone: another module, another object, a string", () => {
    expect(boundaryUses('export { x } from "./next-dynamic";')).toEqual([]);
    expect(boundaryUses('const R = require("./react-utils");\nconst y = R.lazy;')).toEqual([]);
    expect(boundaryUses('const y = cache["lazy"];\nconst s = "next/dynamic.js";')).toEqual([]);
  });

  it("finds Suspense and lazy destructured from React", () => {
    expect(
      boundaryUses(`import React from "react";
const { Suspense } = React;`),
    ).toHaveLength(1);
    expect(boundaryUses("const { lazy: later } = React;")).toHaveLength(1);
    expect(
      boundaryUses(`import * as R from "react";
const { Suspense, lazy } = R;`),
    ).toHaveLength(2);
    expect(boundaryUses('const { Suspense } = require("react");')).toHaveLength(1);
  });

  it("leaves other React imports, a non-React `lazy`, prose, comments and strings alone", () => {
    expect(boundaryUses('import { useState } from "react";')).toEqual([]);
    expect(boundaryUses("// a Suspense boundary held the transition")).toEqual([]);
    expect(
      boundaryUses(`import { lazy } from "./my-utils";
const y = cache.lazy;`),
    ).toEqual([]);
    expect(
      boundaryUses(`const { lazy } = myUtils;
const { Suspense } = layout;`),
    ).toEqual([]);
    expect(
      boundaryUses(`const opts = { loading: true };
fetchIt(opts, { loading: 1 });`),
    ).toEqual([]);
    expect(
      boundaryUses(`// import dynamic from "next/dynamic"
/* const { Suspense } = React; React.lazy(); require("next/dynamic") */
const s = 'import dynamic from "next/dynamic"; const { Suspense } = React';`),
    ).toEqual([]);
    expect(
      boundaryUses("const el = <p>Suspense, lazy and next/dynamic are banned here.</p>;"),
    ).toEqual([]);
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
    "no layout, page or component renders a Suspense, React.lazy or next/dynamic boundary",
    { timeout: 30_000 },
    () => {
      const sources = files(srcRoot).filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f));
      expect(sources.length).toBeGreaterThan(50);
      const uses = sources.flatMap((f) => boundaryUses(readFileSync(f, "utf8"), rel(f)));
      expect(uses).toEqual([]);
    },
  );
});
