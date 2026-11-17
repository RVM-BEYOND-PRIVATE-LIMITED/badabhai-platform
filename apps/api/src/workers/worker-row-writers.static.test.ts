import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";

/**
 * #2753 item 12 (brief 4F.2) — NO PARTNER-MADE PROFILE. "A profile exists only after the worker
 * signs in with a code on his own phone; no route lets a partner create or confirm one."
 *
 * A `workers` row is the profile's root, so this pins EVERY production writer of one, parsed with
 * the TypeScript compiler (syntax only) over every non-test file under apps/api/src:
 *   1. INSERTS. A Drizzle `.insert(workers)` (the table recognised by its import, an import alias,
 *      a namespace import `schema.workers` or a Drizzle `alias(workers, …)`), and raw SQL in a
 *      template or string: `INSERT INTO [public.]workers` / `INSERT INTO ${workers}`. Every one
 *      must sit in a member listed in {@link ALLOWED_INSERTS}: today only `WorkersRepository`.
 *   2. CALLERS of those repository writers. `createOrGetByPhoneHash` (any receiver) and `.create`
 *      on anything typed or constructed as `WorkersRepository` must come only from a member listed
 *      in {@link ALLOWED_CALLERS}: OTP sign-in, and the Campus link (#2752).
 *   3. THE SIGN-IN CHAIN. Inside `AuthService` the insert is reached only through
 *      `findOrCreateForPhone` ← `mintLoginForPhone` ← `verifyOtp` (the worker's own OTP) or
 *      `testLogin` (the staging seam behind TEST_LOGIN_ENABLED + its token, unarmable in prod).
 *
 * ANOTHER WRITER IS NAMED, NOT HIDDEN: the Campus link creates a `pending` row for an RVM student
 * who has not signed in (behind CAMPUS_LINK_ENABLED, institute only, never a partner); only his own
 * OTP sign-in activates it (`WorkersRepository.activatePending`). A new entry in either list is a
 * new way for a profile to exist without its owner and must be reviewed as one, against the rule
 * above. Every listed entry must still exist, so the lists cannot go stale.
 *
 * WHAT IT DOES NOT SEE: `packages/db` (seeds and the demo/synthetic workforce scripts, which write
 * demo and staging data), test files, and manual SQL.
 */

const API_SRC = join(__dirname, "..");

/** The members allowed to INSERT a `workers` row, with the reason. Exact `file Class.member`. */
const ALLOWED_INSERTS: Record<string, string> = {
  "workers/workers.repository.ts WorkersRepository.create":
    "a plain insert with no production caller (pinned by ALLOWED_CALLERS.create being empty)",
  "workers/workers.repository.ts WorkersRepository.createOrGetByPhoneHash":
    "the race-safe insert-or-get (TD23); its callers are pinned in ALLOWED_CALLERS",
};

type RepoWriter = "create" | "createOrGetByPhoneHash";

/** Who may call each `WorkersRepository` writer, with the reason. Exact `file Class.member`. */
const ALLOWED_CALLERS: Record<RepoWriter, Record<string, string>> = {
  createOrGetByPhoneHash: {
    "auth/auth.service.ts AuthService.findOrCreateForPhone":
      "OTP sign-in on the worker's own phone (and the test-login seam), via mintLoginForPhone",
    "campus-link/institute-link.service.ts InstituteLinkService.linkInTransaction":
      "the Campus link (#2752): a `pending` row for an RVM student, behind CAMPUS_LINK_ENABLED; " +
      "only his own OTP sign-in activates it",
    "student-import/import-campus-students.ts createStudent":
      "the bulk student move (#2887, ADR-0067): a `pending` row for an RVM student from Campus's " +
      "export, written by the ops CLI with STUDENT_MOVE_ENABLED on; only his own OTP sign-in " +
      "activates it, and a phone that is already a BadaBhai worker is held, never taken",
  },
  create: {},
};

/** Inside `AuthService`: who may call each private step of the sign-in chain. */
const AUTH_SERVICE = "auth/auth.service.ts";
const SIGN_IN_CHAIN: Record<string, string[]> = {
  findOrCreateForPhone: ["AuthService.mintLoginForPhone"],
  mintLoginForPhone: ["AuthService.testLogin", "AuthService.verifyOtp"],
};

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out);
    } else if (
      entry.endsWith(".ts") &&
      !entry.endsWith(".test.ts") &&
      !entry.endsWith(".test-support.ts") &&
      !entry.endsWith(".d.ts")
    ) {
      out.push(full);
    }
  }
  return out;
}

function unwrap(expr: ts.Expression): ts.Expression {
  let e = expr;
  while (ts.isParenthesizedExpression(e) || ts.isAwaitExpression(e)) e = e.expression;
  return e;
}

/** `Class.method` (or the function's name) of the member a node sits in. */
function memberName(node: ts.Node): string {
  for (let n: ts.Node | undefined = node; n !== undefined; n = n.parent) {
    if (
      (ts.isMethodDeclaration(n) ||
        ts.isFunctionDeclaration(n) ||
        ts.isPropertyDeclaration(n) ||
        ts.isConstructorDeclaration(n)) &&
      (n.name !== undefined || ts.isConstructorDeclaration(n))
    ) {
      const name = ts.isConstructorDeclaration(n) ? "constructor" : n.name!.getText();
      const owner = ts.isClassDeclaration(n.parent) ? n.parent.name?.text : undefined;
      return owner === undefined ? name : `${owner}.${name}`;
    }
  }
  return "(top level)";
}

/** Names bound to the `workers` table: imports (and their aliases), namespaces, `alias()`. */
function tableBindings(sf: ts.SourceFile): { locals: Set<string>; namespaces: Set<string> } {
  const locals = new Set<string>();
  const namespaces = new Set<string>(["schema"]);
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && node.importClause?.namedBindings) {
      const bindings = node.importClause.namedBindings;
      if (ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
      else {
        for (const el of bindings.elements) {
          if ((el.propertyName ?? el.name).text === "workers") locals.add(el.name.text);
        }
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === "alias"
    ) {
      const source = node.initializer.arguments[0];
      if (source !== undefined && ts.isIdentifier(source) && locals.has(source.text)) {
        locals.add(node.name.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { locals, namespaces };
}

function isWorkersTable(
  expr: ts.Expression | undefined,
  b: ReturnType<typeof tableBindings>,
): boolean {
  if (expr === undefined) return false;
  const e = unwrap(expr);
  if (ts.isIdentifier(e)) return b.locals.has(e.text);
  return (
    ts.isPropertyAccessExpression(e) &&
    ts.isIdentifier(e.expression) &&
    b.namespaces.has(e.expression.text) &&
    e.name.text === "workers"
  );
}

/** `workers` and `"workers"`, optionally schema-qualified, or `${workers}`; never `worker_x`/`workers_x`. */
const RAW_WORKERS_INSERT =
  /\binsert\s+into\s+(?:only\s+)?(?:"?public"?\s*\.\s*)?(?:"workers"|workers\b|\$\{\s*(?:\w+\.)?workers\s*\})/i;

/** A template's text with each `${…}` kept as written. */
function templateText(node: ts.TemplateLiteral): string {
  if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return (
    node.head.text +
    node.templateSpans.map((s) => "${" + s.expression.getText() + "}" + s.literal.text).join("")
  );
}

/** Is a type node `WorkersRepository`? */
const isRepoType = (t: ts.TypeNode | undefined): boolean =>
  t !== undefined &&
  ts.isTypeReferenceNode(t) &&
  ts.isIdentifier(t.typeName) &&
  t.typeName.text === "WorkersRepository";

/** Names a file binds to a `WorkersRepository` (parameters, properties, variables). */
function repoBindings(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      (ts.isParameter(node) || ts.isPropertyDeclaration(node) || ts.isVariableDeclaration(node)) &&
      ts.isIdentifier(node.name)
    ) {
      const init = node.initializer === undefined ? undefined : unwrap(node.initializer);
      const constructed =
        init !== undefined &&
        ts.isNewExpression(init) &&
        ts.isIdentifier(init.expression) &&
        init.expression.text === "WorkersRepository";
      if (isRepoType(node.type) || constructed) names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return names;
}

interface Site {
  kind: string;
  member: string;
  line: number;
}

/** Every `workers` insert, every repository-writer call and every sign-in-chain call in a file. */
function analyse(
  fileName: string,
  text: string,
): {
  inserts: Site[];
  calls: (Site & { writer: RepoWriter })[];
  chain: (Site & { step: string })[];
} {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const tables = tableBindings(sf);
  const repos = repoBindings(sf);
  const inserts: Site[] = [];
  const calls: (Site & { writer: RepoWriter })[] = [];
  const chain: (Site & { step: string })[] = [];
  const lineOf = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const receiver = unwrap(node.expression.expression);
      if (method === "insert" && isWorkersTable(node.arguments[0], tables)) {
        inserts.push({
          kind: "drizzle insert(workers)",
          member: memberName(node),
          line: lineOf(node),
        });
      }
      if (method === "createOrGetByPhoneHash") {
        calls.push({
          kind: "createOrGetByPhoneHash call",
          writer: "createOrGetByPhoneHash",
          member: memberName(node),
          line: lineOf(node),
        });
      }
      const receiverName = ts.isIdentifier(receiver)
        ? receiver.text
        : ts.isPropertyAccessExpression(receiver) &&
            receiver.expression.kind === ts.SyntaxKind.ThisKeyword
          ? receiver.name.text
          : null;
      if (method === "create" && receiverName !== null && repos.has(receiverName)) {
        calls.push({
          kind: "WorkersRepository.create call",
          writer: "create",
          member: memberName(node),
          line: lineOf(node),
        });
      }
      if (
        receiver.kind === ts.SyntaxKind.ThisKeyword &&
        Object.prototype.hasOwnProperty.call(SIGN_IN_CHAIN, method)
      ) {
        chain.push({
          kind: `${method} call`,
          step: method,
          member: memberName(node),
          line: lineOf(node),
        });
      }
    }
    if (
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateExpression(node) ||
      ts.isStringLiteral(node)
    ) {
      const raw = ts.isStringLiteral(node) ? node.text : templateText(node);
      if (RAW_WORKERS_INSERT.test(raw)) {
        inserts.push({
          kind: "raw INSERT INTO workers",
          member: memberName(node),
          line: lineOf(node),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { inserts, calls, chain };
}

function apiFiles(): { file: string; text: string }[] {
  return sourceFiles(API_SRC).map((full) => ({
    file: relative(API_SRC, full).split(sep).join("/"),
    text: readFileSync(full, "utf8"),
  }));
}

describe("a `workers` row is written only by sign-in on the worker's own phone (#2753 item 12)", () => {
  const analysed = apiFiles().map((f) => ({ ...f, ...analyse(f.file, f.text) }));
  const keyed = <T extends Site>(pick: (a: (typeof analysed)[number]) => T[]) =>
    analysed.flatMap((a) =>
      pick(a).map((s) => ({ ...s, key: `${a.file} ${s.member}`, file: a.file })),
    );

  it("the scan sees the writers it exists for (it has not gone blind)", () => {
    const inserts = keyed((a) => a.inserts).map((s) => s.key);
    for (const known of Object.keys(ALLOWED_INSERTS)) expect(inserts).toContain(known);
    const callers = keyed((a) => a.calls).map((s) => s.key);
    for (const known of Object.keys(ALLOWED_CALLERS.createOrGetByPhoneHash)) {
      expect(callers).toContain(known);
    }
  });

  it("every `workers` INSERT sits in an allowed member (today: WorkersRepository only)", () => {
    const stray = keyed((a) => a.inserts)
      .filter((s) => !(s.key in ALLOWED_INSERTS))
      .map((s) => `${s.file}:${s.line} ${s.kind} in ${s.member}`);
    expect(stray, "a new writer of a workers row: review it against brief 4F.2").toEqual([]);
  });

  it.each(["createOrGetByPhoneHash", "create"] as const)(
    "WorkersRepository.%s is called only from the allowed members",
    (writer) => {
      const stray = keyed((a) => a.calls)
        .filter((s) => s.writer === writer && !(s.key in ALLOWED_CALLERS[writer]))
        .map((s) => `${s.file}:${s.line} ${s.kind} in ${s.member}`);
      expect(stray, "a new way to create a profile: review it against brief 4F.2").toEqual([]);
    },
  );

  it("inside AuthService the insert is reached only through OTP verify and test login", () => {
    const auth = analysed.find((a) => a.file === AUTH_SERVICE);
    expect(auth, `${AUTH_SERVICE} moved: re-point this test`).toBeDefined();
    for (const [step, allowed] of Object.entries(SIGN_IN_CHAIN)) {
      const callers = [...new Set(auth!.chain.filter((c) => c.step === step).map((c) => c.member))];
      expect(callers.sort(), `callers of AuthService.${step}`).toEqual([...allowed].sort());
    }
  });

  it("no referral, agency or partner code path calls a writer (the partner rule, stated directly)", () => {
    const partnerSide = keyed((a) => [...a.inserts, ...a.calls])
      .filter((s) => /^(referrals|agency|agency-twin|payer-portal|payers|messaging)\//.test(s.file))
      .map((s) => `${s.file}:${s.line} ${s.kind}`);
    expect(partnerSide).toEqual([]);
  });

  it("every listed member still exists (the lists stay honest)", () => {
    const inserts = new Set(keyed((a) => a.inserts).map((s) => s.key));
    expect(Object.keys(ALLOWED_INSERTS).filter((k) => !inserts.has(k))).toEqual([]);
    const callers = new Set(keyed((a) => a.calls).map((s) => s.key));
    for (const writer of ["createOrGetByPhoneHash", "create"] as const) {
      expect(Object.keys(ALLOWED_CALLERS[writer]).filter((k) => !callers.has(k))).toEqual([]);
    }
  });

  describe("the scan itself", () => {
    const BT = String.fromCharCode(96);
    const DL = String.fromCharCode(36);
    const raw = (sqlText: string) => "sql" + BT + sqlText + BT;
    const IMPORTS = 'import { workers, workerOrigins } from "@badabhai/db";\n';
    const member = (body: string, header = IMPORTS) =>
      `${header}class R {\n  async write(tx: Db) {\n    ${body}\n  }\n}`;
    const scan = (src: string) => analyse("fixture.ts", src);

    it.each([
      ["a Drizzle insert", member("await tx.insert(workers).values(v);")],
      [
        "an import alias",
        member("await tx.insert(w).values(v);", 'import { workers as w } from "@badabhai/db";\n'),
      ],
      [
        "a namespace import",
        member("await db.insert(s.workers).values(v);", 'import * as s from "@badabhai/db";\n'),
      ],
      [
        "a Drizzle alias()",
        member(
          "await tx.insert(ww).values(v);",
          'import { workers } from "@badabhai/db";\nconst ww = alias(workers, "ww");\n',
        ),
      ],
      [
        "raw INSERT INTO workers",
        member(`await tx.execute(${raw("INSERT INTO workers (id) VALUES (1)")});`),
      ],
      [
        "raw insert into public.workers",
        member(`await tx.execute(${raw("insert into public.workers (id) values (1)")});`),
      ],
      [
        'raw INSERT INTO "workers"',
        member(`await tx.execute(${raw('INSERT INTO "workers" (id) VALUES (1)')});`),
      ],
      [
        "raw INSERT INTO ${workers}",
        member(`await tx.execute(${raw("INSERT INTO " + DL + "{workers} (id) VALUES (1)")});`),
      ],
      ["a plain string", member(`await client.unsafe("insert into workers (id) values (1)");`)],
    ])("sees %s", (_n, src) => {
      expect(scan(src).inserts.map((s) => s.member)).toEqual(["R.write"]);
    });

    it.each([
      ["another table", member("await tx.insert(workerOrigins).values(v);")],
      [
        "a raw insert into worker_origins",
        member(`await tx.execute(${raw("INSERT INTO worker_origins (worker_id) VALUES (1)")});`),
      ],
      [
        "a raw insert into workers_archive",
        member(`await tx.execute(${raw("INSERT INTO workers_archive (id) VALUES (1)")});`),
      ],
      ["a read of workers", member(`await tx.execute(${raw("SELECT id FROM workers")});`)],
      ["an update of workers", member("await tx.update(workers).set({ status: 'active' });")],
      [
        "a local named like the table that is not the table",
        member("await this.repo.insert(this.workers);", ""),
      ],
    ])("ignores %s", (_n, src) => {
      expect(scan(src).inserts).toEqual([]);
    });

    it("sees WorkersRepository.create through a typed parameter or a constructed instance", () => {
      const typed =
        "class S {\n  constructor(private readonly people: WorkersRepository) {}\n" +
        "  async go() {\n    await this.people.create(v);\n  }\n}";
      expect(scan(typed).calls.map((c) => `${c.writer} ${c.member}`)).toEqual(["create S.go"]);
      const built =
        "function go(db: Db) {\n  const repo = new WorkersRepository(db);\n  return repo.create(v);\n}";
      expect(scan(built).calls.map((c) => `${c.writer} ${c.member}`)).toEqual(["create go"]);
    });

    it("ignores .create on anything else, and sees createOrGetByPhoneHash on any receiver", () => {
      const other =
        "class S {\n  constructor(private readonly sessions: SessionService) {}\n" +
        "  async go() {\n    await this.sessions.create(id);\n    await anything.createOrGetByPhoneHash(v);\n  }\n}";
      expect(scan(other).calls.map((c) => `${c.writer} ${c.member}`)).toEqual([
        "createOrGetByPhoneHash S.go",
      ]);
    });
  });
});
