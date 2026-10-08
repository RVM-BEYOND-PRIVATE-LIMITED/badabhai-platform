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
 *  - Outside the helper a router is used for `.refresh` / `.prefetch` / `.back` / `.forward` and
 *    NOTHING else (an allowlist — review of #2140): no `push` / `replace`, and no handing it on —
 *    an argument, a prop, a return value, an object, an assignment — however it is reached:
 *    `router.push(…)`, `router["replace"]`, `useRouter().push`, `router!.push`, `(router as
 *    T).push`, `(router).push`, `<T>router`, a `const` alias (its uses are checked in turn), `let r;
 *    r = useRouter()`, a destructured `{ push }`, the HOOK aliased (`const useR = useRouter`,
 *    `import { useRouter as useR }`, `nav.useRouter`) or referenced outside a call (`typeof
 *    useRouter`). The pages router's hook counts too. A dependency array (`[router]`) is not a use.
 *  - No module but the helper re-exports a router module's `useRouter` (`export { useRouter as
 *    useNav } from …`, `export *`), loads one with require()/import(), or names a router type
 *    (`AppRouterInstance`, `NextRouter`) — a router typed to be received as a prop. And a hook
 *    imported from another project module (which could wrap the router) is never `push`ed or
 *    `replace`d: `useNav().push(…)`.
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

/** The specifiers that load next/navigation's module (its `redirect`, its `useRouter`). */
const NAVIGATION_MODULES: ReadonlySet<string> = new Set(
  ["next/navigation", "next/dist/client/components/navigation"].flatMap((m) => [m, `${m}.js`]),
);
/** The specifiers whose `useRouter` hands out a router that can push/replace — the pages router's too. */
const ROUTER_MODULES: ReadonlySet<string> = new Set([
  ...NAVIGATION_MODULES,
  ...["next/router", "next/compat/router"].flatMap((m) => [m, `${m}.js`]),
]);
const HELPER = "components/portal-navigation.ts";
/** Modules that may call the router's push/replace themselves — each with WHY. */
const MAY_ROUTE_RAW: ReadonlyMap<string, string> = new Map([
  [HELPER, "the helper itself: it runs push/replace inside its transition, for every other module"],
]);
const NAVIGATING = new Set(["push", "replace"]);
/**
 * ALL a router may be used for outside the helper — none of it opens a destination of its own:
 * `refresh` re-reads this page, `prefetch` loads nothing on screen, `back` / `forward` replay
 * history. Anything else done with a router — a push or replace, handing it on (an alias, an
 * argument, a prop, a return value), destructuring another member — is a finding.
 */
const ROUTER_MAY = new Set(["refresh", "prefetch", "back", "forward"]);
/** Types that are a router: naming one means a router is handed around as a value. */
const ROUTER_TYPES = new Set(["AppRouterInstance", "NextRouter"]);
/** React hooks that take a dependency array — listing the router there is not a use of it. */
const DEPS_HOOKS = new Set([
  "useEffect",
  "useLayoutEffect",
  "useInsertionEffect",
  "useCallback",
  "useMemo",
  "useImperativeHandle",
]);
const REDIRECTS = new Set(["redirect", "permanentRedirect"]);
const HOOK_NAME = /^use[A-Z0-9]/;

const moduleName = (node: ts.Node | undefined): string | null =>
  node && ts.isStringLiteralLike(node) ? node.text : null;
const isNavigationModule = (node: ts.Node | undefined) =>
  NAVIGATION_MODULES.has(moduleName(node) ?? "");
const isRouterModule = (node: ts.Node | undefined) => ROUTER_MODULES.has(moduleName(node) ?? "");
const textOf = (n: ts.PropertyName | ts.ModuleExportName | ts.BindingName) =>
  ts.isIdentifier(n) || ts.isStringLiteralLike(n) ? n.text : null;
/**
 * Could a hook imported from `spec` hand out the router? React's own hooks cannot; next's are
 * matched exactly (its `useRouter`, above); the helper's is the way to navigate. Any other module's
 * hook could wrap `useRouter` and return it.
 */
const mayWrapTheRouter = (spec: string) =>
  !(
    spec === "react" ||
    spec.startsWith("react/") ||
    spec === "react-dom" ||
    spec.startsWith("next/") ||
    specifierStem(spec).split("/").pop() === "portal-navigation"
  );

function parse(code: string, file: string): ts.SourceFile {
  const kind = /\.[cm]?tsx$|\.jsx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, kind);
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
  /** Is `callee` one of those exports — `redirect`, `nav.redirect`, or the local alias? */
  return (callee: ts.Expression): boolean =>
    (ts.isIdentifier(callee) && locals.has(callee.text)) ||
    (ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      namespaces.has(callee.expression.text) &&
      names.has(callee.name.text));
}

type Wrapper =
  | ts.ParenthesizedExpression
  | ts.NonNullExpression
  | ts.AsExpression
  | ts.SatisfiesExpression
  | ts.TypeAssertion;
/** `(x)`, `x!`, `x as T`, `x satisfies T`, `<T>x` — the same value, looked at differently. */
const isWrapper = (n: ts.Node): n is Wrapper =>
  ts.isParenthesizedExpression(n) ||
  ts.isNonNullExpression(n) ||
  ts.isAsExpression(n) ||
  ts.isSatisfiesExpression(n) ||
  ts.isTypeAssertionExpression(n);
/** The outermost wrapper around `node` — where the value is actually used. */
function climb(node: ts.Node): ts.Node {
  let n = node;
  while (n.parent && isWrapper(n.parent) && n.parent.expression === n) n = n.parent;
  return n;
}
/** The value inside every wrapper of `e`. */
function unwrap(e: ts.Expression): ts.Expression {
  let x = e;
  while (isWrapper(x)) x = x.expression;
  return x;
}
/** The member name a use reads, when `use` is `x.name` or `x["name"]` with `x` the used value. */
function memberRead(use: ts.Node): string | null {
  const p = use.parent;
  if (p && ts.isPropertyAccessExpression(p) && p.expression === use) return p.name.text;
  if (
    p &&
    ts.isElementAccessExpression(p) &&
    p.expression === use &&
    ts.isStringLiteralLike(p.argumentExpression)
  ) {
    return p.argumentExpression.text;
  }
  return null;
}
/** Is `use` an element of a React hook's dependency array (`useEffect(…, [router])`)? */
function inDepsArray(use: ts.Node): boolean {
  const arr = use.parent;
  if (!arr || !ts.isArrayLiteralExpression(arr)) return false;
  const call = arr.parent;
  if (!call || !ts.isCallExpression(call) || call.arguments[call.arguments.length - 1] !== arr) {
    return false;
  }
  const callee = call.expression;
  const name = ts.isIdentifier(callee)
    ? callee.text
    : ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : "";
  return DEPS_HOOKS.has(name);
}
/** Is this identifier a NAME being declared or a member/key name — not a read of a value? */
function isNameNotRead(id: ts.Identifier): boolean {
  const p = id.parent;
  if (!p) return true;
  if (
    (ts.isVariableDeclaration(p) ||
      ts.isParameter(p) ||
      ts.isFunctionDeclaration(p) ||
      ts.isFunctionExpression(p) ||
      ts.isClassDeclaration(p) ||
      ts.isPropertyAssignment(p) ||
      ts.isPropertySignature(p) ||
      ts.isPropertyDeclaration(p) ||
      ts.isMethodDeclaration(p) ||
      ts.isJsxAttribute(p) ||
      ts.isImportSpecifier(p) ||
      ts.isImportClause(p) ||
      ts.isNamespaceImport(p) ||
      ts.isTypeAliasDeclaration(p) ||
      ts.isInterfaceDeclaration(p)) &&
    (p as { name?: ts.Node }).name === id
  ) {
    return true;
  }
  if (ts.isBindingElement(p)) return p.name === id || p.propertyName === id;
  if (ts.isPropertyAccessExpression(p) && p.name === id) return true;
  if (ts.isQualifiedName(p) && p.right === id) return true;
  // `r = useRouter()` writes `r` — the value assigned is checked where it is.
  if (
    ts.isBinaryExpression(p) &&
    p.left === id &&
    p.operatorToken.kind === ts.SyntaxKind.EqualsToken
  ) {
    return true;
  }
  return false;
}

/**
 * Where `code` uses a router outside the helper — each finding is `file:line what`. An ALLOWLIST:
 * a router value may only be read for {@link ROUTER_MAY} (or listed in a hook's dependency array);
 * the hook may only be called; a router module's `useRouter` may not be re-exported, required or
 * typed into a prop. Wrappers (`(x)`, `x!`, `as`, `satisfies`, `<T>x`) are looked through.
 */
function routerFindings(code: string, file = "x.tsx"): string[] {
  const sf = parse(code, file);
  const out: string[] = [];
  const hit = (node: ts.Node, what: string) => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    out.push(`${file}:${line + 1} ${what}`);
  };
  const USE_HELPER = "(use usePortalNavigation)";

  // The hook under every name this file gives it, the router modules' namespaces, and the hooks
  // imported from modules that could wrap it.
  const hooks = new Set<string>();
  const namespaces = new Set<string>();
  const wrapperHooks = new Set<string>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !st.importClause) continue;
    const spec = moduleName(st.moduleSpecifier) ?? "";
    const clause = st.importClause;
    const named = clause.namedBindings;
    const fromRouter = isRouterModule(st.moduleSpecifier);
    if (fromRouter && named && ts.isNamespaceImport(named)) namespaces.add(named.name.text);
    const imported: Array<[string, string, boolean]> = [];
    if (clause.name) imported.push(["default", clause.name.text, clause.isTypeOnly]);
    if (named && ts.isNamedImports(named)) {
      for (const el of named.elements) {
        const from = textOf(el.propertyName ?? el.name) ?? "";
        imported.push([from, el.name.text, clause.isTypeOnly || el.isTypeOnly]);
      }
    }
    for (const [from, local, typeOnly] of imported) {
      // Type-only too: `typeof useRouter` types a router to be handed around.
      if (fromRouter && from === "useRouter") hooks.add(local);
      else if (!typeOnly && HOOK_NAME.test(local) && mayWrapTheRouter(spec))
        wrapperHooks.add(local);
    }
  }
  const isNamespaceHook = (e: ts.Node) =>
    (ts.isPropertyAccessExpression(e) &&
      ts.isIdentifier(e.expression) &&
      namespaces.has(e.expression.text) &&
      e.name.text === "useRouter") ||
    (ts.isElementAccessExpression(e) &&
      ts.isIdentifier(e.expression) &&
      namespaces.has(e.expression.text) &&
      ts.isStringLiteralLike(e.argumentExpression) &&
      e.argumentExpression.text === "useRouter");
  const isHook = (e: ts.Expression) => {
    const x = unwrap(e);
    return (ts.isIdentifier(x) && hooks.has(x.text)) || isNamespaceHook(x);
  };
  const isRouterCall = (e: ts.Expression) => {
    const x = unwrap(e);
    return ts.isCallExpression(x) && isHook(x.expression);
  };
  const isWrapperHookCall = (e: ts.Expression) => {
    const x = unwrap(e);
    return (
      ts.isCallExpression(x) &&
      ts.isIdentifier(unwrap(x.expression)) &&
      wrapperHooks.has((unwrap(x.expression) as ts.Identifier).text)
    );
  };

  // Names bound to the hook, to a router, or to a wrapper hook's value — by declaration or by a
  // later assignment, through aliases — to a fixed point.
  const routers = new Set<string>();
  const wrapped = new Set<string>();
  const bindings: Array<[string, ts.Expression]> = [];
  const collect = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      bindings.push([node.name.text, node.initializer]);
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      bindings.push([node.left.text, node.right]);
    }
    ts.forEachChild(node, collect);
  };
  collect(sf);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [name, value] of bindings) {
      const v = unwrap(value);
      const into = isHook(v)
        ? hooks
        : isRouterCall(v) || (ts.isIdentifier(v) && routers.has(v.text))
          ? routers
          : isWrapperHookCall(v) || (ts.isIdentifier(v) && wrapped.has(v.text))
            ? wrapped
            : null;
      if (into && !into.has(name)) {
        into.add(name);
        grew = true;
      }
    }
  }

  /** A router VALUE is used at `use` (the outermost wrapper): allowed, or a finding. */
  const routerUse = (use: ts.Node, at: ts.Node) => {
    const member = memberRead(use);
    if (member !== null && ROUTER_MAY.has(member)) return;
    if (inDepsArray(use)) return;
    const p = use.parent;
    // `const r = useRouter()` binds it — the binding's own uses are checked where they are.
    if (p && ts.isVariableDeclaration(p) && p.initializer === use && ts.isIdentifier(p.name)) {
      return;
    }
    if (
      p &&
      ts.isVariableDeclaration(p) &&
      p.initializer === use &&
      ts.isObjectBindingPattern(p.name)
    ) {
      for (const el of p.name.elements) {
        const key = el.dotDotDotToken ? "...rest" : textOf(el.propertyName ?? el.name);
        if (key === null || !ROUTER_MAY.has(key)) {
          hit(el, `the router's ${key ?? "member"} destructured outside the helper ${USE_HELPER}`);
        }
      }
      return;
    }
    if (member !== null && NAVIGATING.has(member)) {
      hit(at, `router.${member} outside the helper ${USE_HELPER}`);
      return;
    }
    hit(
      at,
      member !== null
        ? `router.${member} outside the helper (only .refresh/.prefetch/.back/.forward)`
        : `the router handed on outside the helper — an alias, argument, prop or return ${USE_HELPER}`,
    );
  };

  const visit = (node: ts.Node) => {
    // A router module's hook re-exported (`export { useRouter as useNav }`, `export *`) or loaded
    // by require()/import() — a way round every rule below.
    if (ts.isExportDeclaration(node) && !node.isTypeOnly && isRouterModule(node.moduleSpecifier)) {
      const clause = node.exportClause;
      if (!clause || ts.isNamespaceExport(clause)) {
        hit(node, `re-exports a router module's useRouter outside the helper ${USE_HELPER}`);
      } else {
        for (const el of clause.elements) {
          if (!el.isTypeOnly && textOf(el.propertyName ?? el.name) === "useRouter") {
            hit(el, `re-exports useRouter outside the helper ${USE_HELPER}`);
          }
        }
      }
    }
    if (ts.isCallExpression(node) && node.arguments.length === 1) {
      const callee = node.expression;
      const loader =
        callee.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(callee) && callee.text === "require");
      if (loader && isRouterModule(node.arguments[0])) {
        hit(node, `loads a router module outside the helper ${USE_HELPER}`);
      }
    }
    // A router TYPE: a router is being typed to be received or handed on.
    if (ts.isIdentifier(node) && ROUTER_TYPES.has(node.text)) {
      hit(node, `${node.text}: a router handed around as a value ${USE_HELPER}`);
    }
    if (ts.isIdentifier(node) && !isNameNotRead(node)) {
      const use = climb(node);
      // The hook (any alias): only ever called.
      if (hooks.has(node.text)) {
        const p = use.parent;
        if (!(p && ts.isCallExpression(p) && p.expression === use)) {
          hit(
            node,
            `useRouter referenced outside a call — the hook handed on or typed ${USE_HELPER}`,
          );
        }
      }
      // A router module's namespace: only ever read from (`nav.x`).
      if (namespaces.has(node.text) && memberRead(use) === null) {
        hit(node, `a router module's namespace handed on ${USE_HELPER}`);
      }
      if (routers.has(node.text)) routerUse(use, node);
      if (wrapped.has(node.text)) {
        const member = memberRead(use);
        if (member !== null && NAVIGATING.has(member)) {
          hit(node, `${member} on a value another module's hook handed out ${USE_HELPER}`);
        }
      }
    }
    // `nav.useRouter` not called.
    if (isNamespaceHook(node)) {
      const use = climb(node);
      const p = use.parent;
      if (!(p && ts.isCallExpression(p) && p.expression === use)) {
        hit(
          node,
          `useRouter referenced outside a call — the hook handed on or typed ${USE_HELPER}`,
        );
      }
    }
    // The hook's result, used where it is called: `useRouter().push(…)`, `go(useRouter())`, …
    if (ts.isCallExpression(node) && isHook(node.expression)) routerUse(climb(node), node);
    if (ts.isCallExpression(node) && isWrapperHookCall(node)) {
      const use = climb(node);
      const member = memberRead(use);
      if (member !== null && NAVIGATING.has(member)) {
        hit(node, `${member} on a value another module's hook handed out ${USE_HELPER}`);
      }
      const p = use.parent;
      if (p && ts.isVariableDeclaration(p) && ts.isObjectBindingPattern(p.name)) {
        for (const el of p.name.elements) {
          const key = textOf(el.propertyName ?? el.name);
          if (key !== null && NAVIGATING.has(key)) {
            hit(el, `${key} destructured from another module's hook ${USE_HELPER}`);
          }
        }
      }
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
      expect(routerFindings(code), code).not.toEqual([]);
    }
  });

  it("finds the router however it is wrapped, aliased, handed on or typed (review of #2140)", () => {
    for (const [code, file] of [
      // An alias of the HOOK itself.
      [withRouter("const useR = useRouter; const r = useR(); r.push('/x');")],
      [withRouter("const useR = useRouter; useR().push('/x');")],
      // A reference wrapped in a non-null assertion, parentheses or a cast.
      [withRouter("const router = useRouter(); router!.push('/x');")],
      [withRouter("const router = useRouter(); (router).push('/x');")],
      [withRouter("const router = useRouter(); (router as any).push('/x');")],
      [withRouter("const router = useRouter(); (router satisfies object).replace('/x');")],
      [withRouter("const router = useRouter(); (<any>router).push('/x');"), "x.ts"],
      [withRouter("useRouter()!.push('/x');")],
      // Bound late, by assignment.
      [withRouter("let r; r = useRouter(); r.push('/x');")],
      // A module that hands the hook on, and one that uses it from there.
      ['export { useRouter as useNav } from "next/navigation";'],
      ['export * from "next/navigation";'],
      ['import { useNav } from "../lib/nav";\nuseNav().push("/x");'],
      ['import { useNav } from "../lib/nav";\nconst r = useNav(); r.replace("/x");'],
      // A router handed to another component (or typed to be received as a prop).
      [withRouter("const router = useRouter(); return <Child router={router} />;")],
      [withRouter("const router = useRouter(); go(router);")],
      [
        'import type { AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";\nfunction C({ router }: { router: AppRouterInstance }) { router.push("/x"); }',
      ],
      [withRouter("const router = useRouter(); (router as AppRouterInstance).push('/x');")],
      [
        'import type { useRouter } from "next/navigation";\nfunction C({ router }: { router: ReturnType<typeof useRouter> }) { router.push("/x"); }',
      ],
      // The pages-router hook navigates too; so may a project hook of the same name.
      ['import { useRouter } from "next/router";\nconst r = useRouter(); r.push("/x");'],
      ['import { useRouter } from "./my-router";\nconst r = useRouter(); r.push("/x");'],
    ] as Array<[string, string?]>) {
      expect(routerFindings(code, file), code).not.toEqual([]);
    }
  });

  it("says what it found, where", () => {
    const what = (code: string) => routerFindings(code).map((f) => f.split(" ").slice(1).join(" "));
    expect(what(withRouter("const router = useRouter(); router.push('/x');"))).toEqual([
      "router.push outside the helper (use usePortalNavigation)",
    ]);
    expect(what(withRouter("const router = useRouter(); (router as any).replace('/x');"))).toEqual([
      "router.replace outside the helper (use usePortalNavigation)",
    ]);
    expect(what(withRouter("const router = useRouter(); router.hmrRefresh();"))).toEqual([
      "router.hmrRefresh outside the helper (only .refresh/.prefetch/.back/.forward)",
    ]);
    expect(what(withRouter("const router = useRouter(); go(router);"))).toEqual([
      "the router handed on outside the helper — an alias, argument, prop or return (use usePortalNavigation)",
    ]);
    // The hook's alias is a finding, and so is the push through it.
    expect(what(withRouter("const useR = useRouter; useR().push('/x');"))).toEqual([
      "useRouter referenced outside a call — the hook handed on or typed (use usePortalNavigation)",
      "router.push outside the helper (use usePortalNavigation)",
    ]);
    // Bound late: the assignment hands the router on, the push through it is found too — and the
    // name WRITTEN (`r =`) is not itself a use.
    expect(what(withRouter("let r; r = useRouter(); r.push('/x');"))).toEqual([
      "the router handed on outside the helper — an alias, argument, prop or return (use usePortalNavigation)",
      "router.push outside the helper (use usePortalNavigation)",
    ]);
    // A router typed into a prop: the type is the finding (it is how a router is received).
    expect(
      what(
        'import type { AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";\nfunction C({ router }: { router: AppRouterInstance }) { router.refresh(); }',
      ),
    ).toEqual([
      "AppRouterInstance: a router handed around as a value (use usePortalNavigation)",
      "AppRouterInstance: a router handed around as a value (use usePortalNavigation)",
    ]);
    expect(routerFindings(withRouter("const router = useRouter();\nrouter.push('/x');"))).toEqual([
      "x.tsx:4 router.push outside the helper (use usePortalNavigation)",
    ]);
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
      // A router listed in a hook's dependency array is not a use of it.
      withRouter("const router = useRouter(); useEffect(() => router.refresh(), [router]);"),
      withRouter(
        "const router = useRouter(); const f = React.useCallback(() => router.refresh(), [router]);",
      ),
      // Another module's hook result may push into whatever it is — unless it is push/replace.
      'import { useList } from "./list";\nconst l = useList(); l.add(1);',
      // React's own hooks hand out no router.
      'import { useRef } from "react";\nconst r = useRef<string[]>([]); r.current.push("x");',
      // The allowlist, however it is reached.
      withRouter("useRouter().refresh();"),
      withRouter("const { refresh, prefetch } = useRouter(); refresh();"),
      withRouter("const router = useRouter(); (router as any).refresh(); router!.back();"),
      withRouter("const router = useRouter(); const r = router; r.forward();"),
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

  it("no module but the helper uses a router beyond refresh/prefetch/back/forward", () => {
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
