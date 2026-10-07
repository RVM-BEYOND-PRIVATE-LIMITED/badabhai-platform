import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import ts from "typescript";

/**
 * EVERY IN-APP LINK SHOWS THE NAVIGATION PENDING CUE (follow-up to #2115).
 *
 * The portal has no loading boundary (no-suspense-above-a-page.test.ts): a navigation keeps the
 * current page on screen until the next one has rendered, and only the link's own pending cue
 * (components/nav-pending.tsx — Next's `useLinkStatus`) says anything happened. #2115 put the cue
 * on the rail, the crumb, page-header actions and a few row links by hand, which left ~20 links
 * with none: on a slow backend (1.5s per read) a dashboard quick card, the panel's "Postings", an
 * account-menu item, a plans link, a row's "Edit posting" or a dashboard card answered a click
 * with ~3s of nothing — where the old skeleton had shown at ~0.1–0.25s.
 *
 * So the cue is not placed by hand any more: every in-app link is a `PortalLink`
 * (components/portal-link.tsx), which renders next/link's `Link` with the cue inside, and cannot be
 * written without a `pendingLabel` (the type requires it). This suite makes the other way
 * impossible:
 *  - NO module but the wrapper obtains next/link's `Link` — a default, namespace or
 *    `{ default as … }` import, `import … = require`, a re-export of it (`export { default } from`,
 *    `export * as`), `require("next/link")` or `import("next/link")`, under any of the specifiers
 *    that load it. A type-only import and the named `useLinkStatus` are fine.
 *  - NO module but the wrapper places `NavPendingCue` itself (one way to cue a link).
 *  - A `PortalLink` is for a pending IN-APP navigation only: a literal `href` must be an app path
 *    ("/…", not "//…"), and it takes no `download` or `target`. An external URL, `mailto:` / `tel:`,
 *    a hash-only `#id`, a download or a new tab is a plain `<a>` — none of those leaves a
 *    navigation pending here. And its `pendingLabel` is never blank.
 * Read from the syntax tree, so a comment or a string never counts. Whole `src/`, generically: a
 * route added later (the Candidates inbox, #2121) is covered the day it lands.
 *
 * The only exception is the wrapper itself; any other entry needs a reason a cue would be WRONG
 * there (not merely absent).
 */
const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const rel = (f: string) => relative(srcRoot, f).replace(/\\/g, "/");

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? files(p) : [p];
  });
}

/** The specifiers that load next/link's module. */
const LINK_MODULES: ReadonlySet<string> = new Set(
  ["next/link", "next/dist/client/link", "next/dist/client/app-dir/link"].flatMap((m) => [
    m,
    `${m}.js`,
  ]),
);
const WRAPPER = "components/portal-link.tsx";
/** Modules that may render next/link's `Link` or place the cue by hand — each with WHY. */
const MAY_LINK_RAW: ReadonlyMap<string, string> = new Map([
  [WRAPPER, "the wrapper itself: it renders Link with the cue inside, for every other module"],
]);

const moduleName = (node: ts.Node | undefined): string | null =>
  node && ts.isStringLiteralLike(node) ? node.text : null;
const isLinkModule = (node: ts.Node | undefined) => LINK_MODULES.has(moduleName(node) ?? "");
/** `./nav-pending`, `../../components/nav-pending`, `@/components/nav-pending` … */
const isCueModule = (node: ts.Node | undefined) => {
  const m = moduleName(node);
  return m !== null && (m === "nav-pending" || m.endsWith("/nav-pending"));
};
const isWrapperModule = (node: ts.Node | undefined) => {
  const m = moduleName(node);
  return m !== null && (m === "portal-link" || m.endsWith("/portal-link"));
};
const textOf = (n: ts.PropertyName | ts.ModuleExportName) =>
  ts.isIdentifier(n) || ts.isStringLiteralLike(n) ? n.text : null;

/** The static text a literal `href` starts with, or null when it is not knowable. */
function hrefPrefix(init: ts.JsxAttributeValue | undefined): string | null {
  if (!init) return null;
  let e: ts.Node = init;
  if (ts.isJsxExpression(e)) {
    if (!e.expression) return null;
    e = e.expression;
  }
  if (ts.isStringLiteralLike(e)) return e.text;
  if (ts.isTemplateExpression(e)) return e.head.text || null;
  return null;
}

/**
 * Where `code` gets a link around the cue: each finding is `file:line what`.
 */
function linkFindings(code: string, file = "x.tsx"): string[] {
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: string[] = [];
  const hit = (node: ts.Node, what: string) => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    out.push(`${file}:${line + 1} ${what}`);
  };
  const RAW = "next/link's Link outside the wrapper";
  const CUE = "NavPendingCue placed by hand";
  /** Local names bound to the wrapper (`import { PortalLink as L }`). */
  const wrappers = new Set<string>();

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) {
      const clause = node.importClause;
      const named = clause?.namedBindings;
      if (isLinkModule(node.moduleSpecifier)) {
        if (clause?.name) hit(node, RAW);
        if (named && ts.isNamespaceImport(named)) hit(node, RAW);
        if (named && ts.isNamedImports(named)) {
          for (const el of named.elements) {
            if (!el.isTypeOnly && textOf(el.propertyName ?? el.name) === "default") hit(el, RAW);
          }
        }
      }
      if (isCueModule(node.moduleSpecifier) && named && ts.isNamedImports(named)) {
        for (const el of named.elements) {
          if (!el.isTypeOnly && textOf(el.propertyName ?? el.name) === "NavPendingCue")
            hit(el, CUE);
        }
      }
      if (isCueModule(node.moduleSpecifier) && named && ts.isNamespaceImport(named)) hit(node, CUE);
      if (isWrapperModule(node.moduleSpecifier) && named && ts.isNamedImports(named)) {
        for (const el of named.elements) {
          if (textOf(el.propertyName ?? el.name) === "PortalLink") wrappers.add(el.name.text);
        }
      }
    }
    if (
      ts.isImportEqualsDeclaration(node) &&
      !node.isTypeOnly &&
      ts.isExternalModuleReference(node.moduleReference) &&
      isLinkModule(node.moduleReference.expression)
    ) {
      hit(node, RAW);
    }
    // A re-export of it: a barrel would hand it to every module that imports the barrel.
    if (ts.isExportDeclaration(node) && !node.isTypeOnly && isLinkModule(node.moduleSpecifier)) {
      const clause = node.exportClause;
      if (clause && ts.isNamespaceExport(clause)) hit(node, RAW);
      if (clause && ts.isNamedExports(clause)) {
        for (const el of clause.elements) {
          if (!el.isTypeOnly && textOf(el.propertyName ?? el.name) === "default") hit(el, RAW);
        }
      }
    }
    if (ts.isExportDeclaration(node) && !node.isTypeOnly && isCueModule(node.moduleSpecifier)) {
      hit(node, CUE);
    }
    // require("next/link") / import("next/link") — loaded at all.
    if (ts.isCallExpression(node) && node.arguments.length === 1) {
      const callee = node.expression;
      const loader =
        callee.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(callee) && callee.text === "require");
      if (loader && isLinkModule(node.arguments[0])) hit(node, RAW);
    }
    // How a PortalLink is used.
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      ts.isIdentifier(node.tagName) &&
      wrappers.has(node.tagName.text)
    ) {
      for (const attr of node.attributes.properties) {
        if (!ts.isJsxAttribute(attr)) continue;
        const name = ts.isIdentifier(attr.name) ? attr.name.text : null;
        if (name === "download" || name === "target") {
          hit(attr, `a PortalLink with \`${name}\` (not a pending in-app navigation: use <a>)`);
        }
        if (name === "href") {
          const prefix = hrefPrefix(attr.initializer);
          if (prefix !== null && (!prefix.startsWith("/") || prefix.startsWith("//"))) {
            hit(attr, `a PortalLink to "${prefix}" (not an app path: use <a>)`);
          }
        }
        if (name === "pendingLabel") {
          const label = hrefPrefix(attr.initializer);
          const literal =
            attr.initializer !== undefined &&
            (ts.isStringLiteral(attr.initializer) ||
              (ts.isJsxExpression(attr.initializer) &&
                attr.initializer.expression !== undefined &&
                ts.isStringLiteralLike(attr.initializer.expression)));
          if (literal && (label ?? "").trim() === "") hit(attr, "a blank pendingLabel");
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

describe("the detector", () => {
  it("finds next/link's Link however a module gets it", () => {
    for (const code of [
      'import Link from "next/link";',
      'import AppLink from "next/link";',
      'import * as L from "next/link";',
      'import { default as L } from "next/link";',
      'import Link, { useLinkStatus } from "next/link";',
      'import Link from "next/dist/client/app-dir/link";',
      'import Link from "next/dist/client/link.js";',
      'import Link = require("next/link");',
      'export { default } from "next/link";',
      'export { default as AppLink } from "next/link";',
      'export * as L from "next/link";',
      'const L = require("next/link");',
      'const { default: L } = await import("next/link");',
    ]) {
      expect(linkFindings(code), code).toHaveLength(1);
    }
  });

  it("leaves a type-only import, useLinkStatus and other modules alone", () => {
    for (const code of [
      'import type Link from "next/link";',
      'import type { LinkProps } from "next/link";',
      'import { type LinkProps } from "next/link";',
      'import { useLinkStatus } from "next/link";',
      'export * from "next/link";', // never re-exports a default
      'import Link from "./link";',
      'import { usePathname } from "next/navigation";',
      'import { PortalLink } from "../components/portal-link";',
    ]) {
      expect(linkFindings(code), code).toEqual([]);
    }
  });

  it("never reads a comment or a string", () => {
    expect(linkFindings('// import Link from "next/link";')).toEqual([]);
    expect(linkFindings('const s = "next/link"; const t = `<Link href="/x">`;')).toEqual([]);
  });

  it("finds the cue placed by hand — or handed on by a barrel", () => {
    expect(
      linkFindings('import { NavPendingCue } from "../../components/nav-pending";'),
    ).toHaveLength(1);
    expect(linkFindings('import { NavPendingCue as Dot } from "./nav-pending";')).toHaveLength(1);
    expect(linkFindings('import * as Cue from "@/components/nav-pending";')).toHaveLength(1);
    expect(linkFindings('export { NavPendingCue } from "./nav-pending";')).toHaveLength(1);
    // The shell's bar and status line are not a link's cue.
    expect(
      linkFindings('import { NavPendingStatus } from "../../components/nav-pending";'),
    ).toEqual([]);
  });

  it("finds a PortalLink that is not a pending in-app navigation, or names nothing", () => {
    const use = (jsx: string) =>
      linkFindings(
        `import { PortalLink as L } from "../components/portal-link";\nconst x = ${jsx};`,
      );
    for (const jsx of [
      '<L href="https://badabhai.ai" pendingLabel="Site">Site</L>',
      '<L href="mailto:help@badabhai.ai" pendingLabel="Mail">Mail</L>',
      '<L href="tel:+910000000000" pendingLabel="Call">Call</L>',
      '<L href="#invite-email" pendingLabel="Invite">Invite</L>',
      '<L href="//cdn.example/x" pendingLabel="X">X</L>',
      '<L href={`https://${host}/x`} pendingLabel="X">X</L>',
      '<L href="/resume.pdf" download pendingLabel="Resume">Resume</L>',
      '<L href="/postings" target="_blank" pendingLabel="Postings">Postings</L>',
      '<L href="/postings" pendingLabel="">Postings</L>',
      '<L href="/postings" pendingLabel={"  "}>Postings</L>',
    ]) {
      expect(use(jsx), jsx).toHaveLength(1);
    }
  });

  it("leaves an in-app PortalLink alone, literal or not", () => {
    const use = (jsx: string) =>
      linkFindings(`import { PortalLink } from "@/components/portal-link";\nconst x = ${jsx};`);
    for (const jsx of [
      '<PortalLink href="/postings" pendingLabel="Postings">Postings</PortalLink>',
      '<PortalLink href="/agency/referrals#batch-invites" pendingLabel="Referrals" />',
      "<PortalLink href={`/postings/${id}`} pendingLabel={p.roleTitle}>x</PortalLink>",
      "<PortalLink href={item.href} pendingLabel={item.label}>x</PortalLink>",
      "<PortalLink href={`${base}/x`} pendingLabel={label}>x</PortalLink>",
    ]) {
      expect(use(jsx), jsx).toEqual([]);
    }
    // A raw anchor to an external URL is exactly what such a link should be.
    expect(linkFindings('const a = <a href="https://wa.me/x" target="_blank">Share</a>;')).toEqual(
      [],
    );
  });
});

describe("every in-app link in the portal shows the pending cue", () => {
  const sources = files(srcRoot)
    .filter((f) => /\.(tsx?|jsx?|mjs|cjs)$/.test(f) && !/\.test\.[jt]sx?$/.test(f))
    .map((f) => [rel(f), readFileSync(f, "utf8")] as const);

  it("no module but the wrapper renders next/link's Link or places the cue by hand", () => {
    expect(sources.length).toBeGreaterThan(50);
    const findings = sources
      .filter(([f]) => !MAY_LINK_RAW.has(f))
      .flatMap(([f, code]) => linkFindings(code, f));
    expect(findings).toEqual([]);
  });

  it("the scan reads the real tree: the wrapper's own Link and cue imports are seen (and still needed)", () => {
    for (const [allowed, why] of MAY_LINK_RAW) {
      const code = sources.find(([f]) => f === allowed)?.[1];
      expect(code, `${allowed} (${why})`).toBeDefined();
      expect(linkFindings(code!, allowed).map((x) => x.split(" ").slice(1).join(" "))).toEqual([
        "next/link's Link outside the wrapper",
        "NavPendingCue placed by hand",
      ]);
    }
  });

  it("and the portal's links ARE PortalLinks (the scan is not vacuous)", () => {
    const using = sources.filter(([, code]) => code.includes("<PortalLink")).map(([f]) => f);
    // The shell, the DS surfaces, the header, and the portal's pages and rows.
    for (const f of [
      "app/(portal)/layout.tsx",
      "app/(portal)/sidebar-nav.tsx",
      "app/(portal)/account-menu.tsx",
      "app/(portal)/dashboard/page.tsx",
      "components/ds/display.tsx",
      "components/page-header.tsx",
    ]) {
      expect(using, f).toContain(f);
    }
    expect(using.length).toBeGreaterThan(20);
  });
});
