import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { specifierStem } from "../../test/portal-link-usage";

/**
 * EVERY NAVIGATING BUTTON SHOWS THE NAVIGATION PENDING CUE (the button-side twin of
 * every-link-shows-the-cue.test.ts).
 *
 * The portal has no loading boundary (no-suspense-above-a-page.test.ts), so a navigation keeps the
 * current page on screen until the next one has rendered. #2115/#2125 gave every LINK the cue; a
 * BUTTON that navigates programmatically — `router.push` / `router.replace` after a save, or a
 * server action that ends in `redirect()` — still answered with nothing while the next page
 * rendered (a form's publish, the agency form's Cancel, the verified sign-in code, sign-out).
 *
 * So a navigation from code goes through components/portal-navigation.ts (`usePortalNavigation`),
 * which runs the router call in its own transition and feeds the shell's bar and ONE status line
 * ("Opening {pendingLabel}…") while it is pending. This suite makes the other way impossible:
 *  - NO module but the helper calls `push` / `replace` on next/navigation's router — however it is
 *    reached: `router.push(…)`, `router["replace"]`, `useRouter().push`, an alias (`const r =
 *    router`), a destructured `{ push }`, `useRouter` imported under another name or through a
 *    namespace (`nav.useRouter()`). `refresh` (an in-place re-read, no destination), `prefetch`,
 *    `back` / `forward` are not flagged.
 *  - EVERY caller of a server action that calls `redirect()` / `permanentRedirect()` (a `"use
 *    server"` module) feeds the cue from the action's own transition — it imports AND calls
 *    `useNavigationCue` (or navigates through `usePortalNavigation`). Session-expiry redirects
 *    inside the shared auth gate (`requirePayer`, lib/auth) are not a designed navigation and are
 *    not counted: they are not in a `"use server"` module.
 * Read from the syntax tree, so a comment or a string never counts. Whole `src/`, generically.
 */
const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const rel = (f: string) => relative(srcRoot, f).replace(/\\/g, "/");

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? files(p) : [p];
  });
}

/** The specifiers that load next/navigation's module. */
const NAVIGATION_MODULES: ReadonlySet<string> = new Set(
  ["next/navigation", "next/dist/client/components/navigation"].flatMap((m) => [m, `${m}.js`]),
);
const HELPER = "components/portal-navigation.ts";
/** Modules that may call the router's push/replace themselves — each with WHY. */
const MAY_ROUTE_RAW: ReadonlyMap<string, string> = new Map([
  [HELPER, "the helper itself: it runs push/replace inside its transition, for every other module"],
]);
const NAVIGATING = new Set(["push", "replace"]);
const REDIRECTS = new Set(["redirect", "permanentRedirect"]);

const moduleName = (node: ts.Node | undefined): string | null =>
  node && ts.isStringLiteralLike(node) ? node.text : null;
const isNavigationModule = (node: ts.Node | undefined) =>
  NAVIGATION_MODULES.has(moduleName(node) ?? "");
const textOf = (n: ts.PropertyName | ts.ModuleExportName | ts.BindingName) =>
  ts.isIdentifier(n) || ts.isStringLiteralLike(n) ? n.text : null;

function parse(code: string, file: string): ts.SourceFile {
  return ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

/** The local names a file gives next/navigation's exports `names`, and its namespace imports. */
function navigationImports(sf: ts.SourceFile, names: ReadonlySet<string>) {
  const locals = new Set<string>();
  const namespaces = new Set<string>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || st.importClause?.isTypeOnly) continue;
    if (!isNavigationModule(st.moduleSpecifier)) continue;
    const named = st.importClause?.namedBindings;
    if (named && ts.isNamespaceImport(named)) namespaces.add(named.name.text);
    if (named && ts.isNamedImports(named)) {
      for (const el of named.elements) {
        if (!el.isTypeOnly && names.has(textOf(el.propertyName ?? el.name) ?? "")) {
          locals.add(el.name.text);
        }
      }
    }
  }
  /** Is `callee` one of those exports — `useRouter`, `nav.useRouter`, or the local alias? */
  return (callee: ts.Expression, name?: string): boolean =>
    (ts.isIdentifier(callee) && locals.has(callee.text)) ||
    (ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      namespaces.has(callee.expression.text) &&
      (name === undefined ? names.has(callee.name.text) : callee.name.text === name));
}

/** Where `code` calls the router's push/replace outside the helper: each is `file:line what`. */
function routerFindings(code: string, file = "x.tsx"): string[] {
  const sf = parse(code, file);
  const out: string[] = [];
  const hit = (node: ts.Node, what: string) => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    out.push(`${file}:${line + 1} ${what}`);
  };
  const isUseRouter = navigationImports(sf, new Set(["useRouter"]));
  const isRouterCall = (e: ts.Expression) => ts.isCallExpression(e) && isUseRouter(e.expression);

  // The names bound to the router: `const router = useRouter()`, and aliases of those.
  const routers = new Set<string>();
  const bind = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const init = node.initializer;
      const fromRouter = isRouterCall(init) || (ts.isIdentifier(init) && routers.has(init.text));
      if (fromRouter && ts.isIdentifier(node.name)) routers.add(node.name.text);
      if (fromRouter && ts.isObjectBindingPattern(node.name)) {
        for (const el of node.name.elements) {
          const key = textOf(el.propertyName ?? el.name);
          if (key !== null && NAVIGATING.has(key)) {
            hit(
              el,
              `the router's ${key} destructured outside the helper (use usePortalNavigation)`,
            );
          }
        }
      }
    }
    ts.forEachChild(node, bind);
  };
  bind(sf);

  const isRouter = (e: ts.Expression) =>
    (ts.isIdentifier(e) && routers.has(e.text)) || isRouterCall(e);
  const visit = (node: ts.Node) => {
    if (
      ts.isPropertyAccessExpression(node) &&
      NAVIGATING.has(node.name.text) &&
      isRouter(node.expression)
    ) {
      hit(node, `router.${node.name.text} outside the helper (use usePortalNavigation)`);
    }
    if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      NAVIGATING.has(node.argumentExpression.text) &&
      isRouter(node.expression)
    ) {
      hit(
        node,
        `router["${node.argumentExpression.text}"] outside the helper (use usePortalNavigation)`,
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Does a `"use server"` module call next/navigation's `redirect` / `permanentRedirect`? */
function serverActionRedirects(code: string, file = "x.ts"): boolean {
  const sf = parse(code, file);
  const first = sf.statements[0];
  const isServer =
    first !== undefined &&
    ts.isExpressionStatement(first) &&
    ts.isStringLiteral(first.expression) &&
    first.expression.text === "use server";
  if (!isServer) return false;
  const isRedirect = navigationImports(sf, REDIRECTS);
  let found = false;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && isRedirect(node.expression)) found = true;
    if (!found) ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** The cue hooks a navigating caller may feed the bar and status line with — and their modules. */
const CUE_HOOKS: ReadonlyArray<readonly [string, string]> = [
  ["useNavigationCue", "nav-pending"],
  ["usePortalNavigation", "portal-navigation"],
];

/** Does `code` import one of the cue hooks AND call it? */
function feedsTheCue(code: string, file = "x.tsx"): boolean {
  const sf = parse(code, file);
  const locals = new Set<string>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || st.importClause?.isTypeOnly) continue;
    const spec = moduleName(st.moduleSpecifier);
    const named = st.importClause?.namedBindings;
    if (spec === null || !named || !ts.isNamedImports(named)) continue;
    for (const el of named.elements) {
      const imported = textOf(el.propertyName ?? el.name);
      const ok = CUE_HOOKS.some(
        ([hook, mod]) => imported === hook && specifierStem(spec).split("/").pop() === mod,
      );
      if (ok && !el.isTypeOnly) locals.add(el.name.text);
    }
  }
  let called = false;
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      locals.has(node.expression.text)
    ) {
      called = true;
    }
    if (!called) ts.forEachChild(node, visit);
  };
  visit(sf);
  return called;
}

/** The src-relative module (no extension) a relative specifier in `importer` resolves to. */
function resolveRelative(importer: string, specifier: string): string | null {
  if (specifier.startsWith("@/")) return specifierStem(specifier.slice(2));
  if (!specifier.startsWith(".")) return null;
  return specifierStem(rel(join(srcRoot, dirname(importer), specifier)));
}

describe("the detector", () => {
  const withRouter = (body: string) =>
    `import { useRouter } from "next/navigation";\nfunction C() {\n${body}\n}`;

  it("finds the router's push/replace however a module reaches it", () => {
    for (const code of [
      withRouter("const router = useRouter(); router.push('/postings');"),
      withRouter("const router = useRouter(); router.replace('/dashboard');"),
      withRouter('const router = useRouter(); router["push"]("/x");'),
      withRouter("const router = useRouter(); const go = router.push; go('/x');"),
      withRouter("const router = useRouter(); const r = router; r.push('/x');"),
      withRouter("const { push } = useRouter(); push('/x');"),
      withRouter("const { replace: go } = useRouter(); go('/x');"),
      withRouter("useRouter().push('/x');"),
      withRouter("const router = useRouter(); const onClick = () => router.push(`/p/${id}`);"),
      'import { useRouter as useR } from "next/navigation";\nconst r = useR(); r.push("/x");',
      'import * as nav from "next/navigation";\nconst r = nav.useRouter(); r.replace("/x");',
      'import { useRouter } from "next/dist/client/components/navigation.js";\nconst r = useRouter(); r.push("/x");',
    ]) {
      expect(routerFindings(code), code).toHaveLength(1);
    }
  });

  it("leaves refresh, prefetch, back/forward, other objects' push/replace, comments and strings alone", () => {
    for (const code of [
      withRouter("const router = useRouter(); router.refresh();"),
      withRouter(
        "const router = useRouter(); router.prefetch('/x'); router.back(); router.forward();",
      ),
      withRouter("const router = useRouter(); const out = []; out.push(1); 'a'.replace('a', 'b');"),
      withRouter(
        "const router = useRouter(); // router.push('/x')\nconst s = 'router.push(\"/x\")';",
      ),
      // Another module's useRouter is not next/navigation's.
      'import { useRouter } from "./my-router";\nconst r = useRouter(); r.push("/x");',
      // A type-only import loads nothing.
      'import type { useRouter } from "next/navigation";\nconst r = {} as ReturnType<typeof useRouter>;',
      // The helper's own API is the way to navigate.
      'import { usePortalNavigation } from "../components/portal-navigation";\nconst { navigate } = usePortalNavigation(); navigate("/x", { pendingLabel: "X" });',
    ]) {
      expect(routerFindings(code), code).toEqual([]);
    }
  });

  it("knows a redirecting server action — and only a server action's redirect", () => {
    const action = (body: string, directive = '"use server";') =>
      `${directive}\nimport { redirect, permanentRedirect as pr } from "next/navigation";\nexport async function a() {\n${body}\n}`;
    expect(serverActionRedirects(action('redirect("/login");'))).toBe(true);
    expect(serverActionRedirects(action('pr("/login");'))).toBe(true);
    expect(
      serverActionRedirects(
        '"use server";\nimport * as nav from "next/navigation";\nexport async function a() { nav.redirect("/x"); }',
      ),
    ).toBe(true);
    // A server component's redirect is part of a navigation already under way (a link's cue).
    expect(serverActionRedirects(action('redirect("/login");', ""))).toBe(false);
    // An action that never redirects, or names it only in a comment/string.
    expect(serverActionRedirects(action("return 1;"))).toBe(false);
    expect(serverActionRedirects(action('// redirect("/x")\nconst s = "redirect(1)";'))).toBe(
      false,
    );
  });

  it("knows a caller that feeds the cue — imported AND called", () => {
    expect(
      feedsTheCue(
        'import { useNavigationCue } from "../../components/nav-pending";\nuseNavigationCue(p, "Sign in");',
      ),
    ).toBe(true);
    expect(
      feedsTheCue(
        'import { usePortalNavigation as nav } from "@/components/portal-navigation";\nnav();',
      ),
    ).toBe(true);
    expect(feedsTheCue('import { useNavigationCue } from "../../components/nav-pending";')).toBe(
      false,
    );
    expect(
      feedsTheCue('import { useNavigationCue } from "./elsewhere";\nuseNavigationCue(p, "X");'),
    ).toBe(false);
    expect(feedsTheCue("// useNavigationCue(p, 'X')")).toBe(false);
  });
});

describe("every navigating button in the portal shows the pending cue", () => {
  const sources = files(srcRoot)
    .filter((f) => /\.(tsx?|jsx?|mjs|cjs)$/.test(f) && !/\.test\.[jt]sx?$/.test(f))
    .map((f) => [rel(f), readFileSync(f, "utf8")] as const);

  it("no module but the helper calls the router's push/replace", () => {
    expect(sources.length).toBeGreaterThan(50);
    const findings = sources
      .filter(([f]) => !MAY_ROUTE_RAW.has(f))
      .flatMap(([f, code]) => routerFindings(code, f));
    expect(findings).toEqual([]);
  });

  it("every caller of a redirecting server action feeds the cue from the action's transition", () => {
    const actions = sources.filter(([f, code]) => serverActionRedirects(code, f)).map(([f]) => f);
    // Not vacuous: sign-out is one (its menu closes as it starts — nothing else would show).
    expect(actions).toContain("app/(portal)/logout-action.ts");
    const missing: string[] = [];
    for (const action of actions) {
      const stem = specifierStem(action);
      const callers = sources.filter(([f, code]) =>
        parse(code, f).statements.some(
          (st) =>
            ts.isImportDeclaration(st) &&
            !st.importClause?.isTypeOnly &&
            resolveRelative(f, moduleName(st.moduleSpecifier) ?? "") === stem,
        ),
      );
      expect(callers.length, `${action} has no caller in src/`).toBeGreaterThan(0);
      for (const [f, code] of callers) {
        if (!feedsTheCue(code, f)) missing.push(`${f} calls ${action} without useNavigationCue`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("the scan reads the real tree: the helper's own push and replace are seen (and still needed)", () => {
    for (const [allowed, why] of MAY_ROUTE_RAW) {
      const code = sources.find(([f]) => f === allowed)?.[1];
      expect(code, `${allowed} (${why})`).toBeDefined();
      expect(routerFindings(code!, allowed).map((x) => x.split(" ")[1])).toEqual([
        "router.replace",
        "router.push",
      ]);
    }
  });

  it("and the portal's navigating buttons DO go through it (the scan is not vacuous)", () => {
    const using = sources.filter(([f, code]) => feedsTheCue(code, f)).map(([f]) => f);
    for (const f of [
      "app/(portal)/postings/new/posting-form.tsx",
      "app/(portal)/postings/[id]/edit/edit-posting-form.tsx",
      "app/(portal)/postings/ai/new/job-posting-chat.tsx",
      "app/(portal)/agency/jobs/new/new-agency-posting.tsx",
      "app/(portal)/agency/jobs/[jobId]/edit/edit-agency-posting.tsx",
      "app/(portal)/account-menu.tsx",
      "app/login/login-form.tsx",
    ]) {
      expect(using, f).toContain(f);
    }
  });
});
