import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";

/**
 * #3054 step 6 — EVERY ROUTE A COMPANY CLIENT CALLS MUST HAVE A HANDLER IN THIS API.
 *
 * On 24 Nov 2026 the company web's posting pages started reading
 * `GET /payer/posting-trades/catalogue` and `GET /payer/posting-trades/:roleKind` (#3038) before
 * the API had them (#3006). Every CI job stayed green, the change auto-deployed, and companies
 * could not post a job. Nothing compared what the clients call with what the API serves.
 *
 * This test does, statically:
 *   - API side: every `*.controller.ts` under apps/api/src; a route is the `@Controller(prefix)`
 *     joined with the method decorator's path (`@Get`, `@Post`, `@Put`, `@Patch`, `@Delete`,
 *     `@All`). A prefix or path given as a constant is resolved through the exported string
 *     constants under apps/api/src.
 *   - Company web: every `payerFetch(path, opts)` call in apps/payer-web/src (tests excluded).
 *     The method is `opts.method`, `GET` when absent. A path may be a string, a template or a
 *     local `const`; a `${…}` filling a whole segment is a parameter, one glued to a segment's end
 *     is a query suffix (`due${query ? `?${query}` : ""}`) and is dropped with the `?…` tail.
 *   - Company app: every `_http.send(PayerMethod.<m>, path)` in
 *     apps/payer-app/lib/core/data/http_payer_api_client.dart, `$x` / `${…}` read the same way.
 *     A path held in a local variable is read from the string literals of its initialiser
 *     (a ternary yields both arms; `Uri(path: '…')` yields the path).
 *
 * Matching is per segment: equal text, or either side a parameter (Express would route a literal
 * `catalogue` to `:roleKind`, and the app fills `/job-postings/:id/:action` with pause/resume/close).
 *
 * A call site the scanner cannot read FAILS the test rather than being skipped, so the check
 * cannot go quiet. Keep client paths as literals or templates (or a `const` holding one).
 *
 * Runs in the Node CI job via `turbo run test`. apps/api/turbo.json lists apps/payer-web/src and
 * the Dart client as inputs of this package's test task, so a client-only change re-runs it
 * instead of replaying a cached pass.
 */

const API_SRC = join(__dirname, "..");
const REPO_ROOT = join(API_SRC, "..", "..", "..");
const PAYER_WEB_SRC = join(REPO_ROOT, "apps", "payer-web", "src");
const PAYER_APP_CLIENT = join(
  REPO_ROOT,
  "apps",
  "payer-app",
  "lib",
  "core",
  "data",
  "http_payer_api_client.dart",
);

const PARAM = ":param";
const HOLE = "\u0000";

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "ALL";
const HTTP_DECORATORS: Record<string, Method> = {
  Get: "GET",
  Post: "POST",
  Put: "PUT",
  Patch: "PATCH",
  Delete: "DELETE",
  All: "ALL",
};

interface ApiRoute {
  method: Method;
  segments: string[];
  where: string;
}

interface ClientCall {
  method: string;
  segments: string[];
  where: string;
}

interface Scan<T> {
  items: T[];
  unreadable: string[];
}

// ─── shared ──────────────────────────────────────────────────────────────────

function walk(dir: string, keep: (file: string) => boolean): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full, keep));
    else if (keep(full)) out.push(full);
  }
  return out;
}

const rel = (file: string) => relative(REPO_ROOT, file).split(sep).join("/");

/** Nest/Express path -> segments; `:name` (and `*`) become generic. */
export function routeSegments(path: string): string[] {
  return path
    .split("/")
    .filter((s) => s.length > 0)
    .map((s) => (s.startsWith(":") ? PARAM : s));
}

/**
 * A client path in which every `${…}` / `$x` was replaced by {@link HOLE}. Drops the query string
 * and a hole glued to the end of a segment (an optional `?query` suffix). Returns null when a hole
 * sits inside a segment in a way that names no route.
 */
export function clientSegments(withHoles: string): string[] | null {
  const noQuery = withHoles.split("?")[0] ?? "";
  const out: string[] = [];
  for (const raw of noQuery.split("/")) {
    if (raw.length === 0) continue;
    if (raw === HOLE) {
      out.push(PARAM);
      continue;
    }
    // `due${suffix}`: a hole only at the end of a literal segment is a query suffix.
    const trimmed = raw.replace(new RegExp(`${HOLE}+$`), "");
    if (trimmed.includes(HOLE)) return null;
    out.push(trimmed);
  }
  return out;
}

export function segmentsMatch(client: string[], api: string[]): boolean {
  if (api.includes("*")) {
    const star = api.indexOf("*");
    if (client.length < star) return false;
    return api.slice(0, star).every((s, i) => s === PARAM || client[i] === PARAM || s === client[i]);
  }
  if (client.length !== api.length) return false;
  return api.every((s, i) => s === PARAM || client[i] === PARAM || s === client[i]);
}

export function hasHandler(call: ClientCall, routes: ApiRoute[]): boolean {
  return routes.some(
    (r) => (r.method === "ALL" || r.method === call.method) && segmentsMatch(call.segments, r.segments),
  );
}

const show = (c: { method: string; segments: string[]; where: string }) =>
  `${c.method} /${c.segments.join("/")}  (${c.where})`;

// ─── API side ────────────────────────────────────────────────────────────────

/** `export const NAME = "…"` across apps/api/src, for `@Controller(NAME)`. */
function exportedStringConstants(files: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    if (!text.includes("export const")) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    for (const stmt of sf.statements) {
      if (!ts.isVariableStatement(stmt)) continue;
      if (!stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
      for (const d of stmt.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer && ts.isStringLiteralLike(d.initializer)) {
          out.set(d.name.text, d.initializer.text);
        }
      }
    }
  }
  return out;
}

/** The path strings a decorator argument names; null when it cannot be read. */
function decoratorPaths(
  arg: ts.Expression | undefined,
  constants: Map<string, string>,
): string[] | null {
  if (arg === undefined) return [""];
  if (ts.isStringLiteralLike(arg)) return [arg.text];
  if (ts.isIdentifier(arg)) {
    const v = constants.get(arg.text);
    return v === undefined ? null : [v];
  }
  if (ts.isArrayLiteralExpression(arg)) {
    const all: string[] = [];
    for (const el of arg.elements) {
      const p = decoratorPaths(el, constants);
      if (p === null) return null;
      all.push(...p);
    }
    return all;
  }
  if (ts.isObjectLiteralExpression(arg)) {
    const path = arg.properties.find(
      (p): p is ts.PropertyAssignment =>
        ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "path",
    );
    return path ? decoratorPaths(path.initializer, constants) : [""];
  }
  return null;
}

function decoratorCall(d: ts.Decorator): { name: string; arg: ts.Expression | undefined } | null {
  const e = d.expression;
  if (!ts.isCallExpression(e) || !ts.isIdentifier(e.expression)) return null;
  return { name: e.expression.text, arg: e.arguments[0] };
}

function collectApiRoutes(): Scan<ApiRoute> {
  const tsFiles = walk(API_SRC, (f) => f.endsWith(".ts") && !/\.(test|spec)\.ts$/.test(f));
  const constants = exportedStringConstants(tsFiles);
  const items: ApiRoute[] = [];
  const unreadable: string[] = [];

  for (const file of tsFiles.filter((f) => f.endsWith(".controller.ts"))) {
    const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isClassDeclaration(node)) {
        const ctrl = (ts.getDecorators(node) ?? [])
          .map(decoratorCall)
          .find((c) => c?.name === "Controller");
        if (ctrl) {
          const prefixes = decoratorPaths(ctrl.arg, constants);
          const at = `${rel(file)}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
          if (prefixes === null) {
            unreadable.push(`@Controller prefix at ${at}`);
          } else {
            for (const member of node.members) {
              if (!ts.isMethodDeclaration(member)) continue;
              for (const dec of ts.getDecorators(member) ?? []) {
                const call = decoratorCall(dec);
                const method = call ? HTTP_DECORATORS[call.name] : undefined;
                if (!call || !method) continue;
                const line = sf.getLineAndCharacterOfPosition(dec.getStart()).line + 1;
                const where = `${rel(file)}:${line}`;
                const paths = decoratorPaths(call.arg, constants);
                if (paths === null) {
                  unreadable.push(`@${call.name} path at ${where}`);
                  continue;
                }
                for (const prefix of prefixes) {
                  for (const path of paths) {
                    items.push({ method, segments: routeSegments(`${prefix}/${path}`), where });
                  }
                }
              }
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { items, unreadable };
}

// ─── company web (payer-web) ─────────────────────────────────────────────────

/** A path expression with every interpolation replaced by {@link HOLE}; null when unreadable. */
function pathWithHoles(expr: ts.Expression, checker: ts.TypeChecker, depth = 0): string | null {
  if (depth > 4) return null;
  if (ts.isStringLiteralLike(expr)) return expr.text;
  if (ts.isTemplateExpression(expr)) {
    return expr.head.text + expr.templateSpans.map((s) => HOLE + s.literal.text).join("");
  }
  if (ts.isParenthesizedExpression(expr)) return pathWithHoles(expr.expression, checker, depth + 1);
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = pathWithHoles(expr.left, checker, depth + 1);
    if (left === null) return null;
    const right = pathWithHoles(expr.right, checker, depth + 1);
    return left + (right ?? HOLE);
  }
  if (ts.isIdentifier(expr)) {
    const decl = checker.getSymbolAtLocation(expr)?.valueDeclaration;
    if (
      decl &&
      ts.isVariableDeclaration(decl) &&
      decl.initializer &&
      ts.isVariableDeclarationList(decl.parent) &&
      (decl.parent.flags & ts.NodeFlags.Const) !== 0
    ) {
      return pathWithHoles(decl.initializer, checker, depth + 1);
    }
    return null;
  }
  return null;
}

function callMethod(opts: ts.Expression | undefined): string | null {
  if (opts === undefined) return "GET";
  if (!ts.isObjectLiteralExpression(opts)) return null;
  let method: string | null = "GET";
  for (const p of opts.properties) {
    if (ts.isSpreadAssignment(p)) return null;
    const name = p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : null;
    if (name !== "method") continue;
    if (ts.isPropertyAssignment(p) && ts.isStringLiteralLike(p.initializer)) {
      method = p.initializer.text.toUpperCase();
    } else {
      return null;
    }
  }
  return method;
}

export function scanPayerFetchCalls(fileName: string, text: string): Scan<ClientCall> {
  // A one-file program under a virtual name (a Windows path would be normalised by TypeScript and
  // re-read from disk, so the checker would not know this tree's nodes). Same extension, same parse.
  const virtual = fileName.endsWith(".tsx") ? "/scan.tsx" : "/scan.ts";
  const sf = ts.createSourceFile(virtual, text, ts.ScriptTarget.Latest, true);
  const host = ts.createCompilerHost({ noResolve: true, noLib: true });
  const realGet = host.getSourceFile.bind(host);
  host.getSourceFile = (name, lang) => (name === virtual ? sf : realGet(name, lang));
  const program = ts.createProgram({
    rootNames: [virtual],
    options: { noResolve: true, noLib: true, jsx: ts.JsxEmit.Preserve },
    host,
  });
  const checker = program.getTypeChecker();
  const items: ClientCall[] = [];
  const unreadable: string[] = [];
  const shown = fileName.startsWith(REPO_ROOT) ? rel(fileName) : fileName;

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "payerFetch"
    ) {
      const where = `${shown}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
      const [pathArg, optsArg] = node.arguments;
      const withHoles = pathArg ? pathWithHoles(pathArg, checker) : null;
      const segments = withHoles === null ? null : clientSegments(withHoles);
      const method = callMethod(optsArg);
      if (segments === null || method === null) unreadable.push(`payerFetch at ${where}`);
      else items.push({ method, segments, where });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { items, unreadable };
}

function collectWebCalls(): Scan<ClientCall> {
  const files = walk(
    PAYER_WEB_SRC,
    (f) => /\.(ts|tsx)$/.test(f) && !/\.(test|spec)\.tsx?$/.test(f) && !/\.d\.ts$/.test(f),
  );
  const out: Scan<ClientCall> = { items: [], unreadable: [] };
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    if (!text.includes("payerFetch(")) continue;
    const s = scanPayerFetchCalls(file, text);
    out.items.push(...s.items);
    out.unreadable.push(...s.unreadable);
  }
  return out;
}

// ─── company app (payer-app, Dart) ───────────────────────────────────────────

/** Replace Dart `${…}` (balanced) and `$ident` interpolations with {@link HOLE}. */
export function dartHoles(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\") {
      out += s[i + 1] ?? "";
      i++;
      continue;
    }
    if (s[i] === "$" && s[i + 1] === "{") {
      let depth = 0;
      let j = i + 1;
      for (; j < s.length; j++) {
        if (s[j] === "{") depth++;
        else if (s[j] === "}" && --depth === 0) break;
      }
      out += HOLE;
      i = j;
      continue;
    }
    if (s[i] === "$" && /[A-Za-z_]/.test(s[i + 1] ?? "")) {
      let j = i + 1;
      while (j < s.length && /\w/.test(s[j] ?? "")) j++;
      out += HOLE;
      i = j - 1;
      continue;
    }
    out += s[i];
  }
  return out;
}

const DART_STRING = /'((?:[^'\\]|\\.)*)'/g;

export function scanDartClient(fileName: string, text: string): Scan<ClientCall> {
  const items: ClientCall[] = [];
  const unreadable: string[] = [];
  const lineAt = (i: number) => text.slice(0, i).split("\n").length;
  // `.send(` inside a `//` or `///` doc comment is prose, not a call.
  const sends = [...text.matchAll(/\.send\(/g)].filter((m) => {
    const lineStart = text.lastIndexOf("\n", m.index) + 1;
    return !text.slice(lineStart, m.index).includes("//");
  });
  const read = /\.send\(\s*PayerMethod\.(\w+)\s*,\s*('(?:[^'\\]|\\.)*'|[A-Za-z_]\w*)/y;

  for (const m of sends) {
    const where = `${fileName}:${lineAt(m.index)}`;
    read.lastIndex = m.index;
    const hit = read.exec(text);
    if (!hit) {
      unreadable.push(`send at ${where}`);
      continue;
    }
    const method = (hit[1] ?? "").toUpperCase();
    const arg = hit[2] ?? "";
    let literals: string[];
    if (arg.startsWith("'")) {
      literals = [arg.slice(1, -1)];
    } else {
      // The nearest `<Type> arg =` before the call; its initialiser runs to the next `;`.
      const decl = [...text.slice(0, m.index).matchAll(new RegExp(`\\b${arg}\\s*=(?!=)`, "g"))].pop();
      if (!decl) {
        unreadable.push(`send(${arg}) at ${where}`);
        continue;
      }
      const start = decl.index + decl[0].length;
      const init = text.slice(start, text.indexOf(";", start));
      literals = [...init.matchAll(DART_STRING)].map((x) => x[1] ?? "").filter((s) => s.startsWith("/"));
    }
    if (literals.length === 0) {
      unreadable.push(`send at ${where}`);
      continue;
    }
    for (const lit of literals) {
      const segments = clientSegments(dartHoles(lit));
      if (segments === null) unreadable.push(`send at ${where}`);
      else items.push({ method, segments, where });
    }
  }
  return { items, unreadable };
}

// ─── the checks ──────────────────────────────────────────────────────────────

describe("payer client routes (#3054): every path a company client calls has an API handler", () => {
  const api = collectApiRoutes();

  it("reads every API controller route", () => {
    expect(api.unreadable).toEqual([]);
    expect(api.items.length).toBeGreaterThan(150);
    // Spot-check the reader against a route it must see.
    expect(api.items.some((r) => r.method === "GET" && r.segments.join("/") === "payer/posting-trades")).toBe(true);
  });

  it("company web: every payerFetch call is readable and has a handler", () => {
    const web = collectWebCalls();
    expect(web.unreadable).toEqual([]);
    expect(web.items.length).toBeGreaterThan(80);
    const missing = web.items.filter((c) => !hasHandler(c, api.items)).map(show);
    expect(missing, "company web calls with no API handler").toEqual([]);
  });

  it("company app: every PayerHttp.send call is readable and has a handler", () => {
    const app = scanDartClient(rel(PAYER_APP_CLIENT), readFileSync(PAYER_APP_CLIENT, "utf8"));
    expect(app.unreadable).toEqual([]);
    expect(app.items.length).toBeGreaterThan(40);
    const missing = app.items.filter((c) => !hasHandler(c, api.items)).map(show);
    expect(missing, "company app calls with no API handler").toEqual([]);
  });
});

describe("payer client routes: the reader and matcher themselves", () => {
  const route = (method: Method, path: string): ApiRoute => ({
    method,
    segments: routeSegments(path),
    where: "fixture",
  });
  const routes = [
    route("GET", "payer/posting-trades"),
    route("GET", "payer/unlocks/:id/contact"),
    route("POST", "payer/job-postings/:id/pause"),
    route("GET", "payer/unlock-outcomes/due"),
  ];

  it("reads literals, templates, query suffixes and const paths from payerFetch", () => {
    const src = `
      const a = await payerFetch("/payer/posting-trades", { schema });
      const b = await payerFetch(\`/payer/unlocks/\${id}/contact\`, { schema });
      const c = await payerFetch(\`/payer/unlock-outcomes/due\${q ? \`?\${q}\` : ""}\`, { schema });
      const path = \`/payer/job-postings/\${id}/pause\`;
      const d = await payerFetch(path, { method: "POST", schema });
      const e = await payerFetch("/payer/posting-trades/catalogue", { schema });
    `;
    const s = scanPayerFetchCalls("fixture.ts", src);
    expect(s.unreadable).toEqual([]);
    expect(s.items.map((c) => `${c.method} /${c.segments.join("/")}`)).toEqual([
      "GET /payer/posting-trades",
      "GET /payer/unlocks/:param/contact",
      "GET /payer/unlock-outcomes/due",
      "POST /payer/job-postings/:param/pause",
      "GET /payer/posting-trades/catalogue",
    ]);
    const missing = s.items.filter((c) => !hasHandler(c, routes)).map((c) => c.segments.join("/"));
    // The #3054 shape: the client asks for a route the API does not serve.
    expect(missing).toEqual(["payer/posting-trades/catalogue"]);
  });

  it("refuses to guess: a path or method it cannot read is reported, not skipped", () => {
    const src = `
      let p = "/payer/x";
      await payerFetch(p, { schema });
      await payerFetch(buildPath(), { schema });
      await payerFetch("/payer/x", opts);
      await payerFetch("/payer/x", { method: verb, schema });
    `;
    const s = scanPayerFetchCalls("fixture.ts", src);
    expect(s.items).toEqual([]);
    expect(s.unreadable).toHaveLength(4);
  });

  it("a wrong method is a missing handler", () => {
    const call: ClientCall = { method: "DELETE", segments: ["payer", "posting-trades"], where: "x" };
    expect(hasHandler(call, routes)).toBe(false);
  });

  it("reads the Dart client's literal, interpolated and variable paths", () => {
    const src = `
      final a = await _http.send(PayerMethod.get, '/payer/posting-trades/\${Uri.encodeComponent(k)}');
      final b = await _http
          .send(PayerMethod.post, '/payer/job-postings/$id/$action');
      final String path = s == null
          ? '/payer/unlock-outcomes/due'
          : '/payer/unlock-outcomes/due?status=$s';
      final c = await _http.send(PayerMethod.get, path);
      final d = await _http.send(PayerMethod.get, mystery);
    `;
    const s = scanDartClient("fixture.dart", src);
    expect(s.items.map((c) => `${c.method} /${c.segments.join("/")}`)).toEqual([
      "GET /payer/posting-trades/:param",
      "POST /payer/job-postings/:param/:param",
      "GET /payer/unlock-outcomes/due",
      "GET /payer/unlock-outcomes/due",
    ]);
    expect(s.unreadable).toHaveLength(1);
    expect(s.items.filter((c) => !hasHandler(c, routes)).map((c) => c.segments.join("/"))).toEqual([
      "payer/posting-trades/:param",
    ]);
  });
});
