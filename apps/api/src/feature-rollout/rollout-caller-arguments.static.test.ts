import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

/**
 * #2819 — WHO MAY BUILD A ROLLOUT CALLER, AND FROM WHAT (the #2820 review; hardened by #2819's L1).
 *
 * A {@link import("./rollout-caller").RolloutCaller} says which login a per-login rollout question
 * is about. Its builders take the auth guard's object, and #2820's runtime seal answers `false` for
 * any caller they did not build, so a copied or spread caller fails closed. What neither the type
 * nor the seal can see is a builder (or the lazy company-login question) handed the WRONG object:
 * the guards' types are plain interfaces, so `rolloutCaller.worker({ id: body.id, sid })` compiles
 * and builds a real caller for whoever the body names. This test closes that, syntactically, across
 * every production file under apps/api/src:
 *
 *   A0  `rolloutCaller` is imported by name only: no renamed, default, namespace or dynamic import
 *       of `rollout-caller`, and no re-export of it.
 *   A1  every `rolloutCaller.<kind>(x)` passes ONE identifier, resolved through EVERY binding form
 *       (parameters, `const` / `let` / `var` incl. hoisting, destructuring, `for…of` / `for…in`,
 *       `catch`). `x` must be
 *        - a parameter taken by exactly that kind's guard decorator, `@CurrentWorker()` /
 *          `@CurrentAdmin()` / `@CurrentTenantScope()` (imported, unrenamed, from its guard file),
 *          typed with the guard's object type, and never reassigned or mutated in its function
 *          (no `x = …`, `x.id = …`, `[x] = …`, `Object.assign(x, …)`, `delete x.id`, `x.n++`); or
 *        - for `payer` only, a `const` initialised by `await this.<tenancy>.resolve(<login>.id)`,
 *          optionally `.catch(h)` where `h` returns only `null` or `false`.
 *       Every `.isThemeOpenForPayer(r)` passes exactly `() => this.<tenancy>.resolve(<login>.id)`
 *       (the same optional `.catch`). `<tenancy>` is a `readonly` constructor parameter typed
 *       `PayerTenantScopeService`; `<login>` is a `@CurrentPayer()` parameter, or ONE HOP away: a
 *       method parameter typed `AuthenticatedPayer` that every production call of that method
 *       fills with a `@CurrentPayer()` parameter (tenancy stays out of controllers, ADR-0053 §5.2
 *       rule 1). Neither may be reassigned or mutated.
 *   A2  `rolloutCaller`, `isThemeOpenFor` and `isThemeOpenForPayer` appear only as called: no
 *       alias, no element access, no destructuring.
 *   A3  every `.isThemeOpenFor(c)` passes a `rolloutCaller.<kind>(…)` call or a parameter typed
 *       `RolloutCaller`, and no `RolloutCaller`-typed value is ever spread.
 *
 * And the call sites are PINNED: adding one is a reviewed edit of {@link EXPECTED_SITES}. The
 * fixture suite at the bottom proves every rejection path fires, so a quiet scan is not a vacuous
 * one. Syntax only (the TypeScript parser, no type checker), like `payer-tenancy.static.test.ts`.
 */

const SRC = join(__dirname, "..");
/** The builders' own file: it declares `rolloutCaller` and is not a call site. */
const BUILDERS = "feature-rollout/rollout-caller.ts";
const CALLER_MODULE = /(^|\/)rollout-caller$/;
const TENANCY_SERVICE = "PayerTenantScopeService";
const QUESTIONS = new Set(["isThemeOpenFor", "isThemeOpenForPayer"]);

/** A guard decorator, the object type it hands over, and the file it must be imported from. */
interface Login {
  readonly decorator: string;
  readonly type: string;
  readonly from: RegExp;
}
const BUILDER_LOGIN: Readonly<Record<string, Login>> = {
  worker: {
    decorator: "CurrentWorker",
    type: "AuthenticatedWorker",
    from: /\/auth\/worker-auth\.guard$/,
  },
  admin: {
    decorator: "CurrentAdmin",
    type: "AuthenticatedAdmin",
    from: /\/admin\/admin-auth\.guard$/,
  },
  payer: {
    decorator: "CurrentTenantScope",
    type: "PayerTenantScope",
    from: /\/payers\/payer-org-role\.guard$/,
  },
};
const PAYER_LOGIN: Login = {
  decorator: "CurrentPayer",
  type: "AuthenticatedPayer",
  from: /\/payers\/payer-auth\.guard$/,
};

/** Every builder call and every lazy company-login question in production code. Sorted. */
const EXPECTED_SITES: readonly string[] = [
  // #2819 — the admin's own theme: GET and PATCH admin/me/display-prefs, from @CurrentAdmin().
  "display-prefs/admin-display-prefs.controller.ts admin(admin)",
  "display-prefs/admin-display-prefs.controller.ts admin(admin)",
  // #2819 — a company login's theme: the lazy resolve, one hop from @CurrentPayer() (review M1).
  "display-prefs/display-prefs.service.ts isThemeOpenForPayer(payer.id)",
  "display-prefs/display-prefs.service.ts isThemeOpenForPayer(payer.id)",
  // #2819 — the worker's own theme: GET and PATCH workers/me/display-prefs, from @CurrentWorker().
  "display-prefs/worker-display-prefs.controller.ts worker(worker)",
  "display-prefs/worker-display-prefs.controller.ts worker(worker)",
];

interface Source {
  readonly file: string;
  readonly sf: ts.SourceFile;
}
interface Scan {
  readonly sites: string[];
  readonly problems: string[];
}

// ── bindings ────────────────────────────────────────────────────────────────────────────────────

function namesIn(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((el) => (ts.isOmittedExpression(el) ? [] : namesIn(el.name)));
}

type Binding =
  | {
      readonly kind: "param";
      readonly node: ts.ParameterDeclaration;
      readonly fn: ts.SignatureDeclaration;
    }
  | { readonly kind: "const"; readonly node: ts.VariableDeclaration; readonly fn: ts.Node }
  | { readonly kind: "other"; readonly why: string }
  | { readonly kind: "none" };

function functionOf(node: ts.Node): ts.Node {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isFunctionLike(n) || ts.isSourceFile(n)) return n;
  }
  return node.getSourceFile();
}

/** A `var` of `name` anywhere in `fn`'s own body (hoisted to the whole function), not in a nested one. */
function hoistedVar(fn: ts.SignatureDeclaration, name: string): boolean {
  const body = (fn as ts.FunctionLikeDeclaration).body;
  let found = false;
  const visit = (n: ts.Node): void => {
    if (n !== body && ts.isFunctionLike(n)) return;
    if (
      ts.isVariableDeclarationList(n) &&
      (n.flags & ts.NodeFlags.BlockScoped) === 0 &&
      n.declarations.some((d) => namesIn(d.name).includes(name))
    ) {
      found = true;
    }
    ts.forEachChild(n, visit);
  };
  if (body) visit(body);
  return found;
}

/** The innermost binding of `name` visible from `from`, through every binding form. */
function bindingOf(name: string, from: ts.Node): Binding {
  for (let scope: ts.Node | undefined = from.parent; scope; scope = scope.parent) {
    if (
      (ts.isForStatement(scope) || ts.isForOfStatement(scope) || ts.isForInStatement(scope)) &&
      scope.initializer &&
      ts.isVariableDeclarationList(scope.initializer) &&
      scope.initializer.declarations.some((d) => namesIn(d.name).includes(name))
    ) {
      return { kind: "other", why: "a loop binding" };
    }
    if (
      ts.isCatchClause(scope) &&
      scope.variableDeclaration &&
      namesIn(scope.variableDeclaration.name).includes(name)
    ) {
      return { kind: "other", why: "a catch binding" };
    }
    if (
      ts.isBlock(scope) ||
      ts.isSourceFile(scope) ||
      ts.isModuleBlock(scope) ||
      ts.isCaseClause(scope) ||
      ts.isDefaultClause(scope)
    ) {
      for (const st of scope.statements) {
        if (ts.isVariableStatement(st)) {
          for (const d of st.declarationList.declarations) {
            if (!namesIn(d.name).includes(name)) continue;
            const isConst = (st.declarationList.flags & ts.NodeFlags.Const) !== 0;
            return isConst && ts.isIdentifier(d.name)
              ? { kind: "const", node: d, fn: functionOf(d) }
              : { kind: "other", why: "a let / var / destructuring binding" };
          }
        }
        if (
          (ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isEnumDeclaration(st)) &&
          st.name?.text === name
        ) {
          return { kind: "other", why: "a declaration" };
        }
      }
    }
    if (ts.isFunctionLike(scope)) {
      if (hoistedVar(scope, name)) return { kind: "other", why: "a hoisted var" };
      for (const p of scope.parameters) {
        if (!namesIn(p.name).includes(name)) continue;
        return ts.isIdentifier(p.name)
          ? { kind: "param", node: p, fn: scope }
          : { kind: "other", why: "a destructured parameter" };
      }
    }
  }
  return { kind: "none" };
}

// ── mutation ────────────────────────────────────────────────────────────────────────────────────

/** The identifiers an assignment target writes through: `x`, `x.a.b`, `x[i]`, `[x]`, `{ a: x }`. */
function roots(e: ts.Expression): string[] {
  if (ts.isIdentifier(e)) return [e.text];
  if (
    ts.isParenthesizedExpression(e) ||
    ts.isNonNullExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isTypeAssertionExpression(e) ||
    ts.isSatisfiesExpression(e) ||
    ts.isPropertyAccessExpression(e) ||
    ts.isElementAccessExpression(e)
  ) {
    return roots(e.expression);
  }
  if (ts.isArrayLiteralExpression(e)) {
    return e.elements.flatMap((el) =>
      ts.isOmittedExpression(el) ? [] : roots(ts.isSpreadElement(el) ? el.expression : el),
    );
  }
  if (ts.isObjectLiteralExpression(e)) {
    return e.properties.flatMap((p) => {
      if (ts.isShorthandPropertyAssignment(p)) return [p.name.text];
      if (ts.isPropertyAssignment(p)) return roots(p.initializer);
      if (ts.isSpreadAssignment(p)) return roots(p.expression);
      return [];
    });
  }
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    return roots(e.left); // a destructuring default, `[x = d] = …`
  }
  return [];
}

const MUTATORS = new Set([
  "Object.assign",
  "Object.defineProperty",
  "Object.defineProperties",
  "Object.setPrototypeOf",
  "Reflect.set",
  "Reflect.defineProperty",
  "Reflect.deleteProperty",
  "Reflect.setPrototypeOf",
]);

/** Is the binding `name` reassigned or written through anywhere inside `fn`? */
function mutated(name: string, fn: ts.Node, sf: ts.SourceFile): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      n.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      roots(n.left).includes(name)
    ) {
      found = true;
    }
    if (
      (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
      (n.operator === ts.SyntaxKind.PlusPlusToken ||
        n.operator === ts.SyntaxKind.MinusMinusToken) &&
      roots(n.operand).includes(name)
    ) {
      found = true;
    }
    if (ts.isDeleteExpression(n) && roots(n.expression).includes(name)) found = true;
    if (
      (ts.isForOfStatement(n) || ts.isForInStatement(n)) &&
      !ts.isVariableDeclarationList(n.initializer) &&
      roots(n.initializer).includes(name)
    ) {
      found = true;
    }
    if (
      ts.isCallExpression(n) &&
      MUTATORS.has(n.expression.getText(sf)) &&
      n.arguments[0] !== undefined &&
      roots(n.arguments[0]).includes(name)
    ) {
      found = true;
    }
    ts.forEachChild(n, visit);
  };
  visit(fn);
  return found;
}

// ── provenance ──────────────────────────────────────────────────────────────────────────────────

/** The module a local name is imported from, unrenamed; undefined when not imported so. */
function importedFrom(sf: ts.SourceFile, local: string): string | undefined {
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const named = st.importClause?.namedBindings;
    if (!named || !ts.isNamedImports(named)) continue;
    const spec = named.elements.find((e) => e.name.text === local);
    if (spec && (spec.propertyName === undefined || spec.propertyName.text === local)) {
      return st.moduleSpecifier.text;
    }
  }
  return undefined;
}

/** Taken by exactly `@<login.decorator>()` (imported from its guard file) and typed as its object. */
function takenBy(param: ts.ParameterDeclaration, login: Login, sf: ts.SourceFile): boolean {
  const decorators = ts.canHaveDecorators(param) ? (ts.getDecorators(param) ?? []) : [];
  if (decorators.length !== 1) return false;
  const call = decorators[0]!.expression;
  if (
    !ts.isCallExpression(call) ||
    call.arguments.length > 0 ||
    !ts.isIdentifier(call.expression)
  ) {
    return false;
  }
  const from = importedFrom(sf, call.expression.text);
  return (
    call.expression.text === login.decorator &&
    from !== undefined &&
    login.from.test(from) &&
    param.type?.getText(sf) === login.type
  );
}

// ── the scan ────────────────────────────────────────────────────────────────────────────────────

function isBuilderCall(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "rolloutCaller"
  );
}

function returnsOnlyNullOrFalse(h: ts.Expression | undefined): boolean {
  if (!h || (!ts.isArrowFunction(h) && !ts.isFunctionExpression(h))) return false;
  const nullOrFalse = (e: ts.Expression | undefined): boolean => {
    while (e && ts.isParenthesizedExpression(e)) e = e.expression;
    return e?.kind === ts.SyntaxKind.NullKeyword || e?.kind === ts.SyntaxKind.FalseKeyword;
  };
  if (!ts.isBlock(h.body)) return nullOrFalse(h.body);
  const returns: ts.ReturnStatement[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isFunctionLike(n)) return;
    if (ts.isReturnStatement(n)) returns.push(n);
    ts.forEachChild(n, visit);
  };
  h.body.statements.forEach(visit);
  const last = h.body.statements[h.body.statements.length - 1];
  return (
    returns.length > 0 &&
    returns.every((r) => nullOrFalse(r.expression)) &&
    last !== undefined &&
    ts.isReturnStatement(last)
  );
}

function scan(inputs: readonly { file: string; text: string }[]): Scan {
  const sources: Source[] = inputs.map(({ file, text }) => ({
    file,
    sf: ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS),
  }));
  const sites: string[] = [];
  const problems: string[] = [];

  // Every `<x>.<name>(…)` call in the scanned files, by name, for the one-hop login rule.
  const callsByName = new Map<string, { call: ts.CallExpression; src: Source }[]>();
  for (const src of sources) {
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
        const list = callsByName.get(n.expression.name.text) ?? [];
        list.push({ call: n, src });
        callsByName.set(n.expression.name.text, list);
      }
      ts.forEachChild(n, visit);
    };
    visit(src.sf);
  }

  for (const src of sources) {
    const { file, sf } = src;
    const at = (node: ts.Node): string =>
      `${file}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`;

    /** Why `id` is not a payer login (a `@CurrentPayer()` param, or one hop from one); null if it is. */
    const payerLoginProblem = (id: ts.Identifier): string | null => {
      const b = bindingOf(id.text, id);
      if (b.kind !== "param") return `${id.text} is not a parameter`;
      if (mutated(id.text, b.fn, sf)) return `${id.text} is reassigned or mutated`;
      if (takenBy(b.node, PAYER_LOGIN, sf)) return null;
      if (b.node.type?.getText(sf) !== PAYER_LOGIN.type)
        return `${id.text} is not ${PAYER_LOGIN.type}`;
      if (!ts.isMethodDeclaration(b.fn) || !ts.isIdentifier(b.fn.name)) {
        return `${id.text} is neither @CurrentPayer() nor a method parameter`;
      }
      const index = b.fn.parameters.indexOf(b.node);
      const calls = callsByName.get(b.fn.name.text) ?? [];
      if (calls.length === 0)
        return `nothing calls ${b.fn.name.text}, so ${id.text} is nobody's login`;
      for (const { call, src: caller } of calls) {
        const arg = call.arguments[index];
        const cb = arg && ts.isIdentifier(arg) ? bindingOf(arg.text, arg) : undefined;
        if (
          !arg ||
          !ts.isIdentifier(arg) ||
          cb?.kind !== "param" ||
          !takenBy(cb.node, PAYER_LOGIN, caller.sf) ||
          mutated(arg.text, cb.fn, caller.sf)
        ) {
          return `${caller.file} calls ${b.fn.name.text} without a @CurrentPayer() parameter`;
        }
      }
      return null;
    };

    /** `this.<tenancy>.resolve(<login>.id)`, optionally `.catch(<null|false>)`; null if it is. */
    const tenancyProblem = (e: ts.Expression): string | null => {
      let call: ts.Expression = e;
      if (
        ts.isCallExpression(call) &&
        ts.isPropertyAccessExpression(call.expression) &&
        call.expression.name.text === "catch"
      ) {
        if (call.arguments.length !== 1 || !returnsOnlyNullOrFalse(call.arguments[0])) {
          return "a .catch handler may return only null or false";
        }
        call = call.expression.expression;
      }
      if (!ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression)) {
        return "not a tenancy resolve call";
      }
      if (call.expression.name.text !== "resolve") {
        return `the tenancy method must be resolve, not ${call.expression.name.text}`;
      }
      const owner = call.expression.expression;
      if (
        !ts.isPropertyAccessExpression(owner) ||
        owner.expression.kind !== ts.SyntaxKind.ThisKeyword
      ) {
        return "the resolver must be this.<field>";
      }
      let cls: ts.Node | undefined = owner.parent;
      while (cls && !ts.isClassLike(cls)) cls = cls.parent;
      const ctor =
        cls && ts.isClassLike(cls) ? cls.members.find(ts.isConstructorDeclaration) : undefined;
      const field = ctor?.parameters.find(
        (p) => ts.isIdentifier(p.name) && p.name.text === owner.name.text,
      );
      const readonly =
        field !== undefined &&
        (ts.getModifiers(field) ?? []).some((m) => m.kind === ts.SyntaxKind.ReadonlyKeyword);
      if (!field || !readonly || field.type?.getText(sf) !== TENANCY_SERVICE) {
        return `this.${owner.name.text} is not a readonly ${TENANCY_SERVICE} constructor parameter`;
      }
      const [arg, ...more] = call.arguments;
      if (
        !arg ||
        more.length > 0 ||
        !ts.isPropertyAccessExpression(arg) ||
        arg.name.text !== "id" ||
        !ts.isIdentifier(arg.expression)
      ) {
        return "the resolve argument must be exactly <@CurrentPayer() login>.id";
      }
      return payerLoginProblem(arg.expression);
    };

    const checkBuilder = (call: ts.CallExpression): void => {
      const kind = (call.expression as ts.PropertyAccessExpression).name.text;
      const [arg, ...rest] = call.arguments;
      if (!arg || rest.length > 0 || !ts.isIdentifier(arg)) {
        problems.push(`${at(call)} A1: rolloutCaller.${kind}(…) must pass ONE identifier`);
        sites.push(`${file} ${kind}(?)`);
        return;
      }
      sites.push(`${file} ${kind}(${arg.text})`);
      const login = BUILDER_LOGIN[kind];
      const b = bindingOf(arg.text, call);
      if (b.kind === "param" && login && takenBy(b.node, login, sf)) {
        if (mutated(arg.text, b.fn, sf)) {
          problems.push(
            `${at(call)} A1: the @${login.decorator}() parameter ${arg.text} is reassigned or mutated`,
          );
        }
        return;
      }
      if (b.kind === "const" && kind === "payer") {
        const init = b.node.initializer;
        const why =
          init && ts.isAwaitExpression(init) ? tenancyProblem(init.expression) : "not awaited";
        if (why === null && !mutated(arg.text, b.fn, sf)) return;
        problems.push(`${at(call)} A1: ${arg.text}: ${why ?? "reassigned or mutated"}`);
        return;
      }
      problems.push(
        `${at(call)} A1: ${arg.text} is ${b.kind === "other" ? b.why : "not the guard decorator's parameter"}`,
      );
    };

    const checkLazy = (call: ts.CallExpression): void => {
      const [arg, ...rest] = call.arguments;
      if (
        !arg ||
        rest.length > 0 ||
        !ts.isArrowFunction(arg) ||
        arg.parameters.length > 0 ||
        ts.isBlock(arg.body)
      ) {
        problems.push(
          `${at(call)} A1: isThemeOpenForPayer takes exactly () => this.<tenancy>.resolve(<login>.id)`,
        );
        sites.push(`${file} isThemeOpenForPayer(?)`);
        return;
      }
      let inner: ts.Expression = arg.body;
      if (
        ts.isCallExpression(inner) &&
        ts.isPropertyAccessExpression(inner.expression) &&
        inner.expression.name.text === "catch"
      ) {
        inner = inner.expression.expression;
      }
      const target =
        ts.isCallExpression(inner) && inner.arguments[0] ? inner.arguments[0].getText(sf) : "?";
      sites.push(`${file} isThemeOpenForPayer(${target})`);
      const why = tenancyProblem(arg.body);
      if (why !== null) problems.push(`${at(call)} A1: ${why}`);
    };

    const visit = (node: ts.Node): void => {
      // A0 — imports and exports of the builders' module.
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        if (CALLER_MODULE.test(node.moduleSpecifier.text)) {
          const clause = node.importClause;
          if (clause?.name) problems.push(`${at(node)} A0: a default import of rollout-caller`);
          const named = clause?.namedBindings;
          if (named && ts.isNamespaceImport(named)) {
            problems.push(`${at(node)} A0: a namespace import of rollout-caller`);
          }
          if (named && ts.isNamedImports(named)) {
            for (const spec of named.elements) {
              if (spec.propertyName && spec.propertyName.text !== spec.name.text) {
                problems.push(`${at(spec)} A0: a renamed import of ${spec.propertyName.text}`);
              }
            }
          }
        }
      }
      if (
        ts.isExportDeclaration(node) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        CALLER_MODULE.test(node.moduleSpecifier.text)
      ) {
        problems.push(`${at(node)} A0: a re-export of rollout-caller`);
      }
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
        node.arguments[0] &&
        ts.isStringLiteralLike(node.arguments[0]) &&
        CALLER_MODULE.test(node.arguments[0].text)
      ) {
        problems.push(`${at(node)} A0: a dynamic import of rollout-caller`);
      }

      // A1 — the builders and the lazy company-login question.
      if (isBuilderCall(node)) checkBuilder(node);
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "isThemeOpenForPayer"
      ) {
        checkLazy(node);
      }

      // A2 — `rolloutCaller` and the two questions only as called.
      if (ts.isIdentifier(node) && node.text === "rolloutCaller") {
        const parent = node.parent;
        const imported = ts.isImportSpecifier(parent) && parent.propertyName === undefined;
        const asReceiver =
          ts.isPropertyAccessExpression(parent) &&
          parent.expression === node &&
          ts.isCallExpression(parent.parent) &&
          parent.parent.expression === parent;
        if (!imported && !asReceiver) {
          problems.push(`${at(node)} A2: rolloutCaller used other than as rolloutCaller.<kind>(…)`);
        }
      }
      if (
        ts.isPropertyAccessExpression(node) &&
        QUESTIONS.has(node.name.text) &&
        !(ts.isCallExpression(node.parent) && node.parent.expression === node)
      ) {
        problems.push(`${at(node)} A2: ${node.name.text} referenced without being called`);
      }
      // (A builder by element access, `rolloutCaller["worker"]`, is the identifier rule above.)
      if (
        ts.isElementAccessExpression(node) &&
        ts.isStringLiteralLike(node.argumentExpression) &&
        QUESTIONS.has(node.argumentExpression.text)
      ) {
        problems.push(`${at(node)} A2: ${node.argumentExpression.text} by element access`);
      }
      if (
        ts.isBindingElement(node) &&
        [node.propertyName, node.name].some(
          (n) => n !== undefined && ts.isIdentifier(n) && QUESTIONS.has(n.text),
        )
      ) {
        problems.push(`${at(node)} A2: a theme question destructured off its service`);
      }

      // A3 — what reaches isThemeOpenFor, and no spread of a caller.
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "isThemeOpenFor"
      ) {
        const [arg] = node.arguments;
        const b = arg && ts.isIdentifier(arg) ? bindingOf(arg.text, node) : undefined;
        const ok =
          arg !== undefined &&
          (isBuilderCall(arg) ||
            (b?.kind === "param" && b.node.type?.getText(sf) === "RolloutCaller"));
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
        const b = bindingOf(node.expression.text, node);
        const typed =
          (b.kind === "param" || b.kind === "const") &&
          b.node.type?.getText(sf) === "RolloutCaller";
        if (typed) problems.push(`${at(node)} A3: a RolloutCaller is never spread`);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
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
  const result = scan(
    prodSources()
      .map((path) => ({ file: relative(SRC, path).replace(/\\/g, "/"), path }))
      .filter(({ file }) => file !== BUILDERS)
      .map(({ file, path }) => ({ file, text: readFileSync(path, "utf8") })),
  );

  it("A0–A3 hold in every production file", () => {
    expect(result.problems).toEqual([]);
  });

  it("the call sites are exactly the reviewed ones", () => {
    expect([...result.sites].sort()).toEqual([...EXPECTED_SITES].sort());
  });
});

describe("the scanner fires on every rejection path (fixtures)", () => {
  const IMPORTS = `
    import { rolloutCaller, type RolloutCaller } from "../feature-rollout/rollout-caller";
    import { CurrentWorker, type AuthenticatedWorker } from "../auth/worker-auth.guard";
    import { CurrentAdmin, type AuthenticatedAdmin } from "../admin/admin-auth.guard";
    import { CurrentPayer, type AuthenticatedPayer } from "../payers/payer-auth.guard";
    import { CurrentTenantScope } from "../payers/payer-org-role.guard";
  `;
  const wrap = (body: string, imports = IMPORTS): string => `${imports}
    class C {
      constructor(
        private readonly tenancy: PayerTenantScopeService,
        private readonly other: OtherService,
        private readonly rollout: FeatureRolloutService,
        private mutableTenancy: PayerTenantScopeService,
      ) {}
      ${body}
    }`;
  const problemsOf = (body: string, extra: { file: string; text: string }[] = []): string[] =>
    scan([{ file: "fixture.ts", text: wrap(body) }, ...extra]).problems;

  /** A controller that hands its @CurrentPayer() login to `svc.<method>`, for the one-hop rule. */
  const controller = (call: string): { file: string; text: string } => ({
    file: "fixture.controller.ts",
    text: `${IMPORTS}
      class Ctrl {
        get(@CurrentPayer() payer: AuthenticatedPayer, @Body() body: X) { return ${call}; }
      }`,
  });

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
      `async m(@CurrentPayer() payer: AuthenticatedPayer) { const scope = await this.tenancy.resolve(payer.id); return rolloutCaller.payer(scope); }`,
    ],
    [
      "the resolver's value with .catch(() => null)",
      `async m(@CurrentPayer() payer: AuthenticatedPayer) { const scope = await this.tenancy.resolve(payer.id).catch(() => null); if (scope === null) return; return rolloutCaller.payer(scope); }`,
    ],
    [
      "a .catch block that logs and returns false",
      `async m(@CurrentPayer() payer: AuthenticatedPayer) { const scope = await this.tenancy.resolve(payer.id).catch((e: unknown) => { log(e); return false; }); return rolloutCaller.payer(scope); }`,
    ],
    [
      "the lazy question in a controller",
      `m(@CurrentPayer() payer: AuthenticatedPayer) { return this.rollout.isThemeOpenForPayer(() => this.tenancy.resolve(payer.id)); }`,
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

  it("accepts the lazy question ONE HOP from @CurrentPayer() (a service method its controller fills)", () => {
    const service = `ask(payer: AuthenticatedPayer) { return this.rollout.isThemeOpenForPayer(() => this.tenancy.resolve(payer.id)); }`;
    expect(problemsOf(service, [controller("this.svc.ask(payer)")])).toEqual([]);
  });

  it.each([
    ["a call site that passes something else", "this.svc.ask(body.payer)"],
    ["a call site that passes a copy", "this.svc.ask({ ...payer, id: body.id })"],
  ])("rejects one hop when %s (A1)", (_name, call) => {
    const service = `ask(payer: AuthenticatedPayer) { return this.rollout.isThemeOpenForPayer(() => this.tenancy.resolve(payer.id)); }`;
    const problems = problemsOf(service, [controller(call)]);
    expect(
      problems.some((p) => p.includes(" A1:")),
      problems.join("\n"),
    ).toBe(true);
  });

  it.each([
    // A0 — how `rolloutCaller` arrives.
    [
      "a renamed import (the reviewer's `rc`)",
      `m(@CurrentWorker() worker: AuthenticatedWorker) { return rc.worker(worker); }`,
      "A0",
      `import { rolloutCaller as rc } from "../feature-rollout/rollout-caller"; import { CurrentWorker, type AuthenticatedWorker } from "../auth/worker-auth.guard";`,
    ],
    [
      "a namespace import",
      `m(@CurrentWorker() worker: AuthenticatedWorker) { return callers.rolloutCaller.worker(worker); }`,
      "A0",
      `import * as callers from "./rollout-caller"; import { CurrentWorker, type AuthenticatedWorker } from "../auth/worker-auth.guard";`,
    ],
    ["a re-export", `m() {}`, "A0", `export { rolloutCaller } from "./rollout-caller";`],
    [
      "a dynamic import",
      `async m() { const mod = await import("../feature-rollout/rollout-caller"); return mod; }`,
      "A0",
      IMPORTS,
    ],
    // A1 — what reaches a builder.
    [
      "an object literal from a body",
      `m(@Body() body: X) { return rolloutCaller.worker({ id: body.id, sid: "s" }); }`,
      "A1",
      IMPORTS,
    ],
    [
      "a plain, undecorated parameter",
      `m(worker: AuthenticatedWorker) { return rolloutCaller.worker(worker); }`,
      "A1",
      IMPORTS,
    ],
    [
      "the wrong realm's decorator",
      `m(@CurrentWorker() worker: AuthenticatedWorker) { return rolloutCaller.admin(worker); }`,
      "A1",
      IMPORTS,
    ],
    [
      "a decorator renamed in from elsewhere",
      `m(@CurrentWorker() worker: AuthenticatedWorker) { return rolloutCaller.worker(worker); }`,
      "A1",
      `import { rolloutCaller } from "../feature-rollout/rollout-caller"; import { Body as CurrentWorker } from "@nestjs/common";`,
    ],
    [
      "a decorator with an argument",
      `m(@CurrentWorker("x") worker: AuthenticatedWorker) { return rolloutCaller.worker(worker); }`,
      "A1",
      IMPORTS,
    ],
    [
      "a second decorator on the parameter",
      `m(@CurrentWorker() @Body() worker: AuthenticatedWorker) { return rolloutCaller.worker(worker); }`,
      "A1",
      IMPORTS,
    ],
    [
      "a parameter of another type",
      `m(@CurrentWorker() worker: X) { return rolloutCaller.worker(worker); }`,
      "A1",
      IMPORTS,
    ],
    [
      "a for…of shadow",
      `m(@CurrentWorker() worker: AuthenticatedWorker, list: AuthenticatedWorker[]) { for (const worker of list) rolloutCaller.worker(worker); }`,
      "A1",
      IMPORTS,
    ],
    [
      "a destructuring const shadow",
      `m(@CurrentWorker() worker: AuthenticatedWorker, body: X) { { const { worker } = body; return rolloutCaller.worker(worker); } }`,
      "A1",
      IMPORTS,
    ],
    [
      "a catch-binding shadow",
      `m(@CurrentWorker() worker: AuthenticatedWorker) { try { f(); } catch (worker) { return rolloutCaller.worker(worker); } }`,
      "A1",
      IMPORTS,
    ],
    [
      "a hoisted var shadow",
      `m(@CurrentWorker() worker: AuthenticatedWorker, body: X) { if (body) { var worker = body.w; } return rolloutCaller.worker(worker); }`,
      "A1",
      IMPORTS,
    ],
    [
      "a destructured parameter",
      `m({ worker }: X) { return rolloutCaller.worker(worker); }`,
      "A1",
      IMPORTS,
    ],
    [
      "a reassigned decorated parameter",
      `m(@CurrentWorker() worker: AuthenticatedWorker, other: AuthenticatedWorker) { worker = other; return rolloutCaller.worker(worker); }`,
      "A1",
      IMPORTS,
    ],
    [
      "a property write to the parameter",
      `m(@CurrentWorker() worker: AuthenticatedWorker, @Body() body: X) { worker.id = body.id; return rolloutCaller.worker(worker); }`,
      "A1",
      IMPORTS,
    ],
    [
      "a destructuring assignment to the parameter",
      `m(@CurrentWorker() worker: AuthenticatedWorker, other: AuthenticatedWorker) { [worker] = [other]; return rolloutCaller.worker(worker); }`,
      "A1",
      IMPORTS,
    ],
    [
      "Object.assign onto the parameter",
      `m(@CurrentWorker() worker: AuthenticatedWorker, @Body() body: X) { Object.assign(worker, body); return rolloutCaller.worker(worker); }`,
      "A1",
      IMPORTS,
    ],
    [
      "a hand-built scope",
      `m(k: TenantKey) { const scope = { tenantKey: k }; return rolloutCaller.payer(scope); }`,
      "A1",
      IMPORTS,
    ],
    [
      "a value from another service",
      `async m(@CurrentPayer() payer: AuthenticatedPayer) { const scope = await this.other.resolve(payer.id); return rolloutCaller.payer(scope); }`,
      "A1",
      IMPORTS,
    ],
    [
      "a non-readonly tenancy field",
      `async m(@CurrentPayer() payer: AuthenticatedPayer) { const scope = await this.mutableTenancy.resolve(payer.id); return rolloutCaller.payer(scope); }`,
      "A1",
      IMPORTS,
    ],
    [
      "resolve(body.payer_id)",
      `async m(@Body() body: X) { const scope = await this.tenancy.resolve(body.payer_id); return rolloutCaller.payer(scope); }`,
      "A1",
      IMPORTS,
    ],
    [
      "resolve of an undecorated payer",
      `async m(payer: AuthenticatedPayer) { const scope = await this.tenancy.resolve(payer.id); return rolloutCaller.payer(scope); }`,
      "A1",
      IMPORTS,
    ],
    [
      "resolveReadOnly(…)",
      `async m(@CurrentPayer() payer: AuthenticatedPayer) { const scope = await this.tenancy.resolveReadOnly(payer.id); return rolloutCaller.payer(scope); }`,
      "A1",
      IMPORTS,
    ],
    [
      "resolveSelfView(…)",
      `async m(@CurrentPayer() payer: AuthenticatedPayer) { const scope = await this.tenancy.resolveSelfView(payer.id); return rolloutCaller.payer(scope); }`,
      "A1",
      IMPORTS,
    ],
    [
      "a .catch that forges a scope",
      `async m(@CurrentPayer() payer: AuthenticatedPayer, @Body() body: X) { const scope = await this.tenancy.resolve(payer.id).catch(() => ({ tenantKey: body.k })); return rolloutCaller.payer(scope); }`,
      "A1",
      IMPORTS,
    ],
    [
      "a .catch block that falls through",
      `async m(@CurrentPayer() payer: AuthenticatedPayer) { const scope = await this.tenancy.resolve(payer.id).catch((e: unknown) => { log(e); }); return rolloutCaller.payer(scope); }`,
      "A1",
      IMPORTS,
    ],
    [
      "a resolver value bound with let",
      `async m(@CurrentPayer() payer: AuthenticatedPayer) { let scope = await this.tenancy.resolve(payer.id); return rolloutCaller.payer(scope); }`,
      "A1",
      IMPORTS,
    ],
    [
      "the resolver's value for a worker caller",
      `async m(@CurrentPayer() payer: AuthenticatedPayer) { const w = await this.tenancy.resolve(payer.id); return rolloutCaller.worker(w); }`,
      "A1",
      IMPORTS,
    ],
    [
      "two arguments",
      `m(@CurrentWorker() worker: AuthenticatedWorker) { return rolloutCaller.worker(worker, worker); }`,
      "A1",
      IMPORTS,
    ],
    // A1 — the lazy company-login question.
    [
      "a lazy resolve of a body id",
      `m(@Body() body: X) { return this.rollout.isThemeOpenForPayer(() => this.tenancy.resolve(body.payer_id)); }`,
      "A1",
      IMPORTS,
    ],
    [
      "a lazy resolve with a forging .catch",
      `m(@CurrentPayer() payer: AuthenticatedPayer, @Body() body: X) { return this.rollout.isThemeOpenForPayer(() => this.tenancy.resolve(payer.id).catch(() => ({ tenantKey: body.k }))); }`,
      "A1",
      IMPORTS,
    ],
    [
      "a lazy resolveReadOnly",
      `m(@CurrentPayer() payer: AuthenticatedPayer) { return this.rollout.isThemeOpenForPayer(() => this.tenancy.resolveReadOnly(payer.id)); }`,
      "A1",
      IMPORTS,
    ],
    [
      "a lazy block body",
      `m(@CurrentPayer() payer: AuthenticatedPayer) { return this.rollout.isThemeOpenForPayer(() => { return this.tenancy.resolve(payer.id); }); }`,
      "A1",
      IMPORTS,
    ],
    [
      "a lazy function with a parameter",
      `m(@CurrentPayer() payer: AuthenticatedPayer) { return this.rollout.isThemeOpenForPayer((id: string) => this.tenancy.resolve(payer.id)); }`,
      "A1",
      IMPORTS,
    ],
    [
      "a resolver passed by name",
      `m(r: () => Promise<PayerTenantScope>) { return this.rollout.isThemeOpenForPayer(r); }`,
      "A1",
      IMPORTS,
    ],
    [
      "a lazy resolve of a mutated login",
      `m(@CurrentPayer() payer: AuthenticatedPayer, @Body() body: X) { payer.id = body.id; return this.rollout.isThemeOpenForPayer(() => this.tenancy.resolve(payer.id)); }`,
      "A1",
      IMPORTS,
    ],
    [
      "a lazy resolve of a parameter nobody calls with a login",
      `orphan(payer: AuthenticatedPayer) { return this.rollout.isThemeOpenForPayer(() => this.tenancy.resolve(payer.id)); }`,
      "A1",
      IMPORTS,
    ],
    // A2 — only as called.
    [
      "an alias of a builder",
      `m() { const build = rolloutCaller.worker; return build; }`,
      "A2",
      IMPORTS,
    ],
    [
      "an element access on the builders",
      `m(@CurrentWorker() worker: AuthenticatedWorker) { return rolloutCaller["worker"](worker); }`,
      "A2",
      IMPORTS,
    ],
    [
      "an alias of isThemeOpenForPayer",
      `m() { const ask = this.rollout.isThemeOpenForPayer; return ask; }`,
      "A2",
      IMPORTS,
    ],
    [
      "isThemeOpenFor destructured",
      `m() { const { isThemeOpenFor } = this.rollout; return isThemeOpenFor; }`,
      "A2",
      IMPORTS,
    ],
    [
      "isThemeOpenForPayer by element access",
      `m() { return this.rollout["isThemeOpenForPayer"](() => null); }`,
      "A2",
      IMPORTS,
    ],
    // A3 — what reaches isThemeOpenFor.
    [
      "a spread caller into isThemeOpenFor",
      `m(caller: RolloutCaller) { return this.rollout.isThemeOpenFor({ ...caller }); }`,
      "A3",
      IMPORTS,
    ],
    [
      "a local into isThemeOpenFor",
      `m(x: unknown) { const c = x as never; return this.rollout.isThemeOpenFor(c); }`,
      "A3",
      IMPORTS,
    ],
  ])("rejects %s (%s)", (_name, body, rule, imports) => {
    const { problems } = scan([{ file: "fixture.ts", text: wrap(body, imports) }]);
    expect(problems.length, problems.join("\n")).toBeGreaterThan(0);
    expect(
      problems.some((p) => p.includes(` ${rule}:`)),
      problems.join("\n"),
    ).toBe(true);
  });
});
