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

const BOUNDARY_MEMBERS = new Set(["Suspense", "lazy"]);
const DYNAMIC = "next/dynamic";

const moduleName = (node: ts.Node | undefined): string | null =>
  node && ts.isStringLiteralLike(node) ? node.text : null;

/** `require("<mod>")` or `import("<mod>")`. */
function loads(node: ts.Node, mod: string): boolean {
  if (!ts.isCallExpression(node) || node.arguments.length !== 1) return false;
  const callee = node.expression;
  const isLoader =
    callee.kind === ts.SyntaxKind.ImportKeyword ||
    (ts.isIdentifier(callee) && callee.text === "require");
  return isLoader && moduleName(node.arguments[0]) === mod;
}

/**
 * Where `code` can put a Suspense boundary above a page — read from the AST, so a comment or a
 * string never counts:
 *  - React's `Suspense`: a named import (renamed or not), a member (`<React.Suspense>`), or
 *    destructured;
 *  - React's `lazy`: a named import from "react", a member of a React binding (`React.lazy`,
 *    `R.lazy` after `import * as R` / `import R` / `require("react")`), or destructured from one;
 *  - `next/dynamic` loaded in any way (import, re-export, `import()`, `require`): every call
 *    wraps `React.lazy`, and `ssr: false` or a `loading` option adds a `<Suspense>` too.
 * A `lazy` that is not React's (zod's `z.lazy`, a `lazyData` field) is left alone.
 */
function boundaryUses(code: string, file = "x.tsx"): string[] {
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: string[] = [];
  const hit = (node: ts.Node) => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    out.push(`${file}:${line + 1}`);
  };

  // Every local name bound to the "react" module (plus the global `React` namespace).
  const react = new Set(["React"]);
  const bind = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && moduleName(node.moduleSpecifier) === "react") {
      const clause = node.importClause;
      if (clause?.name) react.add(clause.name.text);
      const named = clause?.namedBindings;
      if (named && ts.isNamespaceImport(named)) react.add(named.name.text);
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      loads(node.initializer, "react")
    ) {
      react.add(node.name.text);
    }
    ts.forEachChild(node, bind);
  };
  bind(sf);
  const isReact = (e: ts.Expression) =>
    (ts.isIdentifier(e) && react.has(e.text)) || loads(e, "react");

  const visit = (node: ts.Node) => {
    // next/dynamic, however it is loaded.
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      moduleName(node.moduleSpecifier) === DYNAMIC
    ) {
      hit(node);
    } else if (loads(node, DYNAMIC)) {
      hit(node);
    }
    // Named imports: Suspense from anywhere; lazy from "react".
    if (ts.isImportSpecifier(node)) {
      const name = (node.propertyName ?? node.name).text;
      const from = moduleName(node.parent.parent.parent.moduleSpecifier);
      if (name === "Suspense" || (name === "lazy" && from === "react")) hit(node);
    }
    // Members: `X.Suspense`; `React.lazy` / `React["lazy"]` on a React binding.
    if (ts.isPropertyAccessExpression(node)) {
      const name = node.name.text;
      if (name === "Suspense" || (name === "lazy" && isReact(node.expression))) hit(node);
    }
    if (ts.isElementAccessExpression(node) && isReact(node.expression)) {
      const name = moduleName(node.argumentExpression);
      if (name !== null && BOUNDARY_MEMBERS.has(name)) hit(node);
    }
    // Destructured: `const { Suspense, lazy } = React` (or = require("react")).
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name)) {
      const fromReact = node.initializer !== undefined && isReact(node.initializer);
      for (const el of node.name.elements) {
        const key = el.propertyName ?? el.name;
        const name = ts.isIdentifier(key) ? key.text : null;
        if (name === "Suspense" || (name === "lazy" && fromReact)) hit(el);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
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
      const uses = sources.flatMap((f) => boundaryUses(readFileSync(f, "utf8"), rel(f)));
      expect(uses).toEqual([]);
    },
  );
});
