import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

/**
 * #2819 — WHO MAY BUILD A ROLLOUT CALLER, AND FROM WHAT (the #2820 review).
 *
 * A {@link import("./rollout-caller").RolloutCaller} says which login a per-login rollout question
 * is about. Its builders take the auth guard's object, and from #2820's runtime seal the service
 * answers `false` for any caller it did not build, so a copied or spread caller fails closed. What
 * neither the type nor the seal can see is a builder handed the WRONG object: the guards' types are
 * plain interfaces, so `rolloutCaller.worker({ id: body.id, sid })` compiles and builds a real
 * caller for whoever the body names. This test closes that, syntactically, across every production
 * file under apps/api/src:
 *
 *   A1  every `rolloutCaller.<kind>(x)` passes ONE identifier, and `x` is either
 *        - a parameter decorated with that kind's guard decorator — `@CurrentWorker()` for
 *          `worker`, `@CurrentAdmin()` for `admin`, `@CurrentTenantScope()` for `payer` — never
 *          reassigned in its function; or
 *        - for `payer` only, a `const` initialised by `await this.<field>.<method>(…)` (optionally
 *          `.catch(…)`), where `<field>` is a constructor parameter typed `PayerTenantScopeService`:
 *          a value the tenancy resolver returned, passed straight in;
 *   A2  `rolloutCaller` is never referenced except as `rolloutCaller.<kind>(…)` (no alias, no
 *        element access, no passing the builder table around);
 *   A3  every `.isThemeOpenFor(c)` passes a `rolloutCaller.<kind>(…)` call or a parameter typed
 *        `RolloutCaller`, and no `RolloutCaller`-typed value is ever spread.
 *
 * And the call sites are PINNED: adding one is a reviewed edit of {@link EXPECTED_SITES}. The
 * fixture suite at the bottom proves every rejection path fires, so a quiet scan is not a vacuous
 * one. Syntax only (the TypeScript parser, no type checker), like `payer-tenancy.static.test.ts`.
 */

const SRC = join(__dirname, "..");
/** The builders' own file: it declares `rolloutCaller` and is not a call site. */
const BUILDERS = "feature-rollout/rollout-caller.ts";

const DECORATOR_FOR: Readonly<Record<string, string>> = {
  worker: "CurrentWorker",
  admin: "CurrentAdmin",
  payer: "CurrentTenantScope",
};
const TENANCY_SERVICE = "PayerTenantScopeService";

/** Every builder call in production code, as `file kind(argument)`. Sorted. */
const EXPECTED_SITES: readonly string[] = [
  // #2819 — the admin's own theme: GET and PATCH admin/me/display-prefs, from @CurrentAdmin().
  "display-prefs/admin-display-prefs.controller.ts admin(admin)",
  "display-prefs/admin-display-prefs.controller.ts admin(admin)",
  // #2819 — a company login's theme: the tenancy resolver's own scope (`resolve`).
  "display-prefs/display-prefs.service.ts payer(scope)",
  // #2819 — the worker's own theme: GET and PATCH workers/me/display-prefs, from @CurrentWorker().
  "display-prefs/worker-display-prefs.controller.ts worker(worker)",
  "display-prefs/worker-display-prefs.controller.ts worker(worker)",
];

interface Scan {
  readonly sites: string[];
  readonly problems: string[];
}

function decoratorNames(node: ts.Node): string[] {
  const decorators = ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : [];
  return decorators.map((d) => {
    const callee = ts.isCallExpression(d.expression) ? d.expression.expression : d.expression;
    return ts.isIdentifier(callee) ? callee.text : "?";
  });
}

type Declaration =
  | {
      readonly kind: "parameter";
      readonly node: ts.ParameterDeclaration;
      readonly fn: ts.SignatureDeclaration;
    }
  | { readonly kind: "const"; readonly node: ts.VariableDeclaration }
  | { readonly kind: "other" }
  | { readonly kind: "none" };

/** The innermost declaration of `name` visible from `from`: a parameter, a local, or none. */
function declarationOf(name: string, from: ts.Node): Declaration {
  for (let scope: ts.Node | undefined = from.parent; scope; scope = scope.parent) {
    if (ts.isFunctionLike(scope)) {
      const param = scope.parameters.find((p) => ts.isIdentifier(p.name) && p.name.text === name);
      if (param) return { kind: "parameter", node: param, fn: scope };
    }
    if (ts.isBlock(scope) || ts.isSourceFile(scope)) {
      for (const statement of scope.statements) {
        if (!ts.isVariableStatement(statement)) continue;
        const decl = statement.declarationList.declarations.find(
          (d) => ts.isIdentifier(d.name) && d.name.text === name,
        );
        if (!decl) continue;
        const isConst = (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
        return isConst ? { kind: "const", node: decl } : { kind: "other" };
      }
    }
  }
  return { kind: "none" };
}

/** Is `name` assigned anywhere inside `fn`'s body? */
function reassigned(name: string, fn: ts.SignatureDeclaration): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      ts.isIdentifier(node.left) &&
      node.left.text === name
    ) {
      found = true;
    }
    ts.forEachChild(node, visit);
  };
  const body = (fn as ts.FunctionLikeDeclaration).body;
  if (body) visit(body);
  return found;
}

/** The type annotation's text of a constructor parameter (or property) named `field`. */
function fieldType(field: string, from: ts.Node, source: ts.SourceFile): string | undefined {
  let cls: ts.Node | undefined = from.parent;
  while (cls && !ts.isClassLike(cls)) cls = cls.parent;
  if (!cls || !ts.isClassLike(cls)) return undefined;
  for (const member of cls.members) {
    if (ts.isConstructorDeclaration(member)) {
      const param = member.parameters.find((p) => ts.isIdentifier(p.name) && p.name.text === field);
      if (param?.type) return param.type.getText(source);
    }
    if (
      ts.isPropertyDeclaration(member) &&
      ts.isIdentifier(member.name) &&
      member.name.text === field &&
      member.type
    ) {
      return member.type.getText(source);
    }
  }
  return undefined;
}

/** `await this.<field>.<method>(…)`, optionally `.catch(…)`, with `<field>` the tenancy service. */
function isTenancyValue(init: ts.Expression | undefined, source: ts.SourceFile): boolean {
  if (!init || !ts.isAwaitExpression(init)) return false;
  let call: ts.Expression = init.expression;
  if (
    ts.isCallExpression(call) &&
    ts.isPropertyAccessExpression(call.expression) &&
    call.expression.name.text === "catch"
  ) {
    call = call.expression.expression;
  }
  if (!ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression)) return false;
  const owner = call.expression.expression;
  if (
    !ts.isPropertyAccessExpression(owner) ||
    owner.expression.kind !== ts.SyntaxKind.ThisKeyword
  ) {
    return false;
  }
  return fieldType(owner.name.text, owner, source) === TENANCY_SERVICE;
}

/** Is this expression a `rolloutCaller.<kind>(…)` call? */
function isBuilderCall(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "rolloutCaller"
  );
}

/** A1–A3 over one file's text. Exported to the fixtures below through the same function. */
function scan(file: string, text: string): Scan {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const sites: string[] = [];
  const problems: string[] = [];
  const at = (node: ts.Node): string =>
    `${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;

  const checkBuilder = (call: ts.CallExpression): void => {
    const kind = (call.expression as ts.PropertyAccessExpression).name.text;
    const [arg, ...rest] = call.arguments;
    if (!arg || rest.length > 0 || !ts.isIdentifier(arg)) {
      problems.push(`${at(call)} A1: rolloutCaller.${kind}(…) must pass ONE identifier`);
      sites.push(`${file} ${kind}(?)`);
      return;
    }
    sites.push(`${file} ${kind}(${arg.text})`);
    const decl = declarationOf(arg.text, call);
    if (decl.kind === "parameter") {
      const wanted = DECORATOR_FOR[kind];
      if (!wanted || !decoratorNames(decl.node).includes(wanted)) {
        problems.push(`${at(call)} A1: ${arg.text} is not a @${wanted ?? "?"}() parameter`);
      } else if (reassigned(arg.text, decl.fn)) {
        problems.push(`${at(call)} A1: the @${wanted}() parameter ${arg.text} is reassigned`);
      }
      return;
    }
    if (
      decl.kind === "const" &&
      kind === "payer" &&
      isTenancyValue(decl.node.initializer, source)
    ) {
      return;
    }
    problems.push(
      `${at(call)} A1: ${arg.text} is neither the guard decorator's parameter nor a ${TENANCY_SERVICE} value`,
    );
  };

  const visit = (node: ts.Node): void => {
    if (isBuilderCall(node)) checkBuilder(node);

    // A2 — `rolloutCaller` only as the receiver of a builder call (or in its import).
    if (ts.isIdentifier(node) && node.text === "rolloutCaller") {
      const parent = node.parent;
      const imported = ts.isImportSpecifier(parent);
      const asReceiver =
        ts.isPropertyAccessExpression(parent) &&
        parent.expression === node &&
        ts.isCallExpression(parent.parent) &&
        parent.parent.expression === parent;
      if (!imported && !asReceiver) {
        problems.push(`${at(node)} A2: rolloutCaller used other than as rolloutCaller.<kind>(…)`);
      }
    }

    // A3 — what reaches isThemeOpenFor, and no spread of a caller.
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "isThemeOpenFor"
    ) {
      const [arg] = node.arguments;
      const ok =
        arg !== undefined &&
        (isBuilderCall(arg) ||
          (ts.isIdentifier(arg) &&
            ((d) => d.kind === "parameter" && d.node.type?.getText(source) === "RolloutCaller")(
              declarationOf(arg.text, node),
            )));
      if (!ok) {
        problems.push(
          `${at(node)} A3: isThemeOpenFor takes a rolloutCaller.<kind>(…) call or a RolloutCaller parameter`,
        );
      }
    }
    if (
      (ts.isSpreadAssignment(node) || ts.isSpreadElement(node)) &&
      ts.isIdentifier(node.expression)
    ) {
      const d = declarationOf(node.expression.text, node);
      const typed =
        (d.kind === "parameter" || d.kind === "const") &&
        d.node.type?.getText(source) === "RolloutCaller";
      if (typed) problems.push(`${at(node)} A3: a RolloutCaller is never spread`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { sites, problems };
}

function prodSources(dir: string = SRC): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return prodSources(path);
    return name.endsWith(".ts") &&
      !name.endsWith(".test.ts") &&
      !name.endsWith(".test-support.ts") &&
      !name.endsWith(".d.ts")
      ? [path]
      : [];
  });
}

describe("rollout callers are built from the guard's object or the tenancy resolver's (#2819)", () => {
  const scans = prodSources()
    .map((path) => ({ rel: relative(SRC, path).replace(/\\/g, "/"), path }))
    .filter(({ rel }) => rel !== BUILDERS)
    .map(({ rel, path }) => scan(rel, readFileSync(path, "utf8")));

  it("A1–A3 hold in every production file", () => {
    expect(scans.flatMap((s) => s.problems)).toEqual([]);
  });

  it("the call sites are exactly the reviewed ones", () => {
    expect(scans.flatMap((s) => s.sites).sort()).toEqual([...EXPECTED_SITES].sort());
  });
});

describe("the scanner fires on every rejection path (fixtures)", () => {
  const wrap = (body: string): string => `
    class C {
      constructor(private readonly tenancy: PayerTenantScopeService, private readonly other: OtherService) {}
      ${body}
    }`;
  const problemsOf = (body: string): string[] => scan("fixture.ts", wrap(body)).problems;

  it.each([
    [
      "@CurrentWorker() → worker",
      `m(@CurrentWorker() worker: AuthenticatedWorker) { return rolloutCaller.worker(worker); }`,
    ],
    [
      "@CurrentAdmin() → admin",
      `m(@CurrentAdmin() admin: AuthenticatedAdmin) { return rolloutCaller.admin(admin); }`,
    ],
    [
      "@CurrentTenantScope() → payer",
      `m(@CurrentTenantScope() scope: PayerTenantScope) { return rolloutCaller.payer(scope); }`,
    ],
    [
      "the resolver's value → payer",
      `async m(id: string) { const scope = await this.tenancy.resolve(id); return rolloutCaller.payer(scope); }`,
    ],
    [
      "the resolver's value with .catch → payer",
      `async m(id: string) { const scope = await this.tenancy.resolve(id).catch(() => null); if (scope === null) return; return rolloutCaller.payer(scope); }`,
    ],
    [
      "a RolloutCaller parameter → isThemeOpenFor",
      `m(caller: RolloutCaller) { return this.rollout.isThemeOpenFor(caller); }`,
    ],
    [
      "a builder call → isThemeOpenFor",
      `m(@CurrentWorker() worker: AuthenticatedWorker) { return this.rollout.isThemeOpenFor(rolloutCaller.worker(worker)); }`,
    ],
  ])("accepts %s", (_name, body) => {
    expect(problemsOf(body)).toEqual([]);
  });

  it.each([
    [
      "an object literal from a body",
      `m(@Body() body: X) { return rolloutCaller.worker({ id: body.id, sid: "s" }); }`,
      "A1",
    ],
    [
      "a plain, undecorated parameter",
      `m(worker: AuthenticatedWorker) { return rolloutCaller.worker(worker); }`,
      "A1",
    ],
    [
      "the wrong realm's decorator",
      `m(@CurrentWorker() worker: AuthenticatedWorker) { return rolloutCaller.admin(worker); }`,
      "A1",
    ],
    [
      "a reassigned decorated parameter",
      `m(@CurrentWorker() worker: AuthenticatedWorker, other: AuthenticatedWorker) { worker = other; return rolloutCaller.worker(worker); }`,
      "A1",
    ],
    [
      "a hand-built scope",
      `m(k: TenantKey) { const scope = { tenantKey: k }; return rolloutCaller.payer(scope); }`,
      "A1",
    ],
    [
      "a value from another service",
      `async m(id: string) { const scope = await this.other.resolve(id); return rolloutCaller.payer(scope); }`,
      "A1",
    ],
    [
      "a resolver value bound with let",
      `async m(id: string) { let scope = await this.tenancy.resolve(id); return rolloutCaller.payer(scope); }`,
      "A1",
    ],
    [
      "the resolver's value for a worker caller",
      `async m(id: string) { const w = await this.tenancy.resolve(id); return rolloutCaller.worker(w); }`,
      "A1",
    ],
    [
      "two arguments",
      `m(@CurrentWorker() worker: AuthenticatedWorker) { return rolloutCaller.worker(worker, worker); }`,
      "A1",
    ],
    ["an alias of a builder", `m() { const build = rolloutCaller.worker; return build; }`, "A2"],
    [
      "an element access",
      `m(@CurrentWorker() worker: AuthenticatedWorker) { return rolloutCaller["worker"](worker); }`,
      "A2",
    ],
    [
      "a spread caller into isThemeOpenFor",
      `m(caller: RolloutCaller) { return this.rollout.isThemeOpenFor({ ...caller }); }`,
      "A3",
    ],
    [
      "a local into isThemeOpenFor",
      `m(x: unknown) { const c = x as never; return this.rollout.isThemeOpenFor(c); }`,
      "A3",
    ],
  ])("rejects %s (%s)", (_name, body, rule) => {
    const problems = problemsOf(body);
    expect(problems.length, problems.join("\n")).toBeGreaterThan(0);
    expect(
      problems.some((p) => p.includes(` ${rule}:`)),
      problems.join("\n"),
    ).toBe(true);
  });
});
