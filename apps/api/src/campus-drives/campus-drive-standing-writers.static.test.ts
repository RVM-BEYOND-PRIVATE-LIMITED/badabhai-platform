import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";

/**
 * #2746 PR 6, migration review M1 — EVERY WRITER OF A COMPANY'S CAMPUS STANDING RE-STAMPS ITS
 * DRIVE REQUESTS.
 *
 * Campus's drive feed pages on `campus_drive_requests.updated_at` alone, and reads whether a
 * request's company is withdrawn (owner ruling R2) live from `payers.status` / `payers.role` and
 * `employer_profiles.verification_status` / `gst_number_enc`. A write to one of those that does not
 * move the request's `updated_at` leaves the request where Campus already read it, so Campus never
 * learns of the withdrawal (or the reinstatement). `restampCompanyDriveRequests`
 * (`campus-drive-feed-stamp.ts`) is the move; this test fails any write that skips it.
 *
 * WHAT IT SEES, parsed with the TypeScript compiler (syntax only), in every non-test file under
 * apps/api/src. The tables are recognised by their import (`payers`, `payers as p`), a namespace
 * import (`schema.payers`), or a Drizzle `alias(payers, …)`:
 *   - a Drizzle `.update(payers).set({…})` whose object names `status`, as a key or shorthand, or
 *     spreads anything (a spread may carry `status`);
 *   - a Drizzle `.insert(payers)…onConflictDoUpdate({ set })` whose `set` does the same, or is not
 *     an object literal;
 *   - ANY Drizzle `.insert` / `.update` / `.delete` on `employer_profiles` (the verification and the
 *     GSTIN arrive in spread column objects, so the write itself is the signal);
 *   - raw SQL in a template: `UPDATE [public.]payers SET … status =` (or `UPDATE ${payers}`), and
 *     `UPDATE` / `INSERT INTO` / `DELETE FROM` on `employer_profiles`.
 * Each such write must be followed, in the SAME function and on the SAME executor (the receiver of
 * the Drizzle chain, or of the raw statement's `execute`), by a `restampCompanyDriveRequests(…)`
 * call. A comment, a call in another function, a call before the write and a call on another
 * executor do not count.
 *
 * A write it flags that changes no standing (a spread it cannot see into) is named, with the
 * reason, in `NOT_STANDING_WRITES`; an entry whose write is gone fails the test.
 *
 * WHAT IT DOES NOT SEE:
 *   - `.set(obj)` with a prebuilt object (`PayersRepository.update` builds its `set` from a name and
 *     a phone only);
 *   - an `INSERT INTO payers` without an upsert (a new payer has no drive requests yet);
 *   - `packages/db`. Its demo seeds `seed-demo-matching.ts` and `seed-synthetic-workforce.ts` UPSERT
 *     a seeded payer with `status: "active"` on conflict, so a re-seed can reinstate a seeded
 *     company without re-stamping its drive requests; that touches demo and staging data only,
 *     never a production company. The PII re-encryption rewrites `gst_number_enc` ciphertext
 *     without changing whether a GSTIN is on file.
 *   - manual SQL. ADR-0063's runbook line: any manual SQL that changes a company's standing must
 *     re-stamp its drive requests too.
 *
 * THE HELPER IS IMPORTED ONLY BY THE WRITERS THAT CALL IT TODAY ({@link HELPER_IMPORTERS}): a new
 * importer is a new standing writer and must be reviewed as one.
 */

const API_SRC = join(__dirname, "..");
const HELPER = "restampCompanyDriveRequests";
const HELPER_MODULE = /\/campus-drive-feed-stamp$/;
const HELPER_IMPORTERS = [
  "admin/admin-actions.repository.ts",
  "admin/companies/admin-companies.repository.ts",
  "payers/payers.repository.ts",
];

type Table = "payers" | "employerProfiles";
const TABLES: readonly Table[] = ["payers", "employerProfiles"];

interface StandingWrite {
  kind: string;
  /** Where the write ends (character offset): a re-stamp must start after it. */
  end: number;
  line: number;
  /** The receiver the write ran on (`tx`, `executor`, `this.db`), or null when it cannot be told. */
  executor: string | null;
  fn: ts.Node | undefined;
  /** `Class.method` the write sits in. */
  member: string;
}

interface Restamp {
  start: number;
  executor: string;
  fn: ts.Node | undefined;
}

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

const flat = (text: string) => text.replace(/\s+/g, " ").trim();

function enclosingFunction(node: ts.Node): ts.Node | undefined {
  for (let n = node.parent; n !== undefined; n = n.parent) {
    if (ts.isFunctionLike(n)) return n;
  }
  return undefined;
}

function unwrap(expr: ts.Expression): ts.Expression {
  let e = expr;
  while (ts.isParenthesizedExpression(e) || ts.isAwaitExpression(e)) e = e.expression;
  return e;
}

/** The names a file binds to each watched table (imports, namespace imports, aliases). */
function tableBindings(sf: ts.SourceFile): {
  locals: Map<string, Table>;
  namespaces: Set<string>;
} {
  const locals = new Map<string, Table>();
  const namespaces = new Set<string>(["schema"]);
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && node.importClause?.namedBindings) {
      const bindings = node.importClause.namedBindings;
      if (ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
      else {
        for (const el of bindings.elements) {
          const imported = (el.propertyName ?? el.name).text;
          if ((TABLES as readonly string[]).includes(imported)) {
            locals.set(el.name.text, imported as Table);
          }
        }
      }
    }
    // const p = alias(payers, "p")
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
        locals.set(node.name.text, locals.get(source.text)!);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { locals, namespaces };
}

function tableOf(
  expr: ts.Expression | undefined,
  b: ReturnType<typeof tableBindings>,
): Table | null {
  if (expr === undefined) return null;
  const e = unwrap(expr);
  if (ts.isIdentifier(e)) return b.locals.get(e.text) ?? null;
  if (
    ts.isPropertyAccessExpression(e) &&
    ts.isIdentifier(e.expression) &&
    b.namespaces.has(e.expression.text) &&
    (TABLES as readonly string[]).includes(e.name.text)
  ) {
    return e.name.text as Table;
  }
  return null;
}

/**
 * Is a spread source PROVABLY free of `status`? An object literal that names no `status` (and spreads
 * nothing that is not), or a conditional whose two branches both are. Anything else (a call, a
 * variable) may carry `status`.
 */
function statusFree(expr: ts.Expression): boolean {
  const e = unwrap(expr);
  if (ts.isObjectLiteralExpression(e)) return !setsStatus(e);
  if (ts.isConditionalExpression(e)) return statusFree(e.whenTrue) && statusFree(e.whenFalse);
  return false;
}

/** Does an object literal (a `.set` argument) name `status`, or spread what may carry it? */
function setsStatus(obj: ts.Expression | undefined): boolean {
  if (obj === undefined) return false;
  const o = unwrap(obj);
  if (!ts.isObjectLiteralExpression(o)) return false;
  return o.properties.some(
    (p) =>
      (ts.isSpreadAssignment(p) && !statusFree(p.expression)) ||
      ((ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
        (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) &&
        p.name.text === "status"),
  );
}

/** `Class.method` (or the function's name) of the member a node sits in, for the exemptions. */
function memberName(node: ts.Node | undefined): string {
  for (let n = node; n !== undefined; n = n.parent) {
    if ((ts.isMethodDeclaration(n) || ts.isFunctionDeclaration(n)) && n.name !== undefined) {
      const owner = ts.isClassDeclaration(n.parent) ? n.parent.name?.text : undefined;
      const name = n.name.getText();
      return owner === undefined ? name : `${owner}.${name}`;
    }
  }
  return "(top level)";
}

/**
 * Writes the scan flags that change NO standing, each with the reason: a spread it cannot see
 * into. Exact `file member` keys; an entry whose write disappears fails the test too.
 */
const NOT_STANDING_WRITES: Record<string, string> = {
  "payers/payers.repository.ts PayersRepository.setOrgName":
    "spreads orgNameTokens(): the company-name search-token columns (orgNameTokenHashes, orgNameTokenKeyId) only",
};

/** The method calls chained after `call` (`.values(…)`, `.set(…)`, `.onConflictDoUpdate(…)`). */
function chainAfter(call: ts.CallExpression): { name: string; args: readonly ts.Expression[] }[] {
  const out: { name: string; args: readonly ts.Expression[] }[] = [];
  let node: ts.Node = call;
  while (
    ts.isPropertyAccessExpression(node.parent) &&
    node.parent.expression === node &&
    ts.isCallExpression(node.parent.parent) &&
    node.parent.parent.expression === node.parent
  ) {
    out.push({ name: node.parent.name.text, args: node.parent.parent.arguments });
    node = node.parent.parent;
  }
  return out;
}

/** The end of the whole chain `call` starts (so a re-stamp must come after the full statement). */
function chainEnd(call: ts.CallExpression): number {
  let node: ts.Node = call;
  while (
    ts.isPropertyAccessExpression(node.parent) &&
    node.parent.expression === node &&
    ts.isCallExpression(node.parent.parent)
  ) {
    node = node.parent.parent;
  }
  return node.getEnd();
}

const RAW_PAYERS_STATUS =
  /\bupdate\s+(?:only\s+)?(?:"?public"?\s*\.\s*)?(?:"?payers"?|\$\{\s*(?:\w+\.)?payers\s*\})(?:\s+(?:as\s+)?\w+)?\s+set\b(?:(?!\bwhere\b|\breturning\b|\bfrom\b)[\s\S])*?(?<![\w.])"?status"?\s*=/i;
const RAW_EMPLOYER_PROFILES =
  /\b(?:update\s+(?:only\s+)?|delete\s+from\s+(?:only\s+)?|insert\s+into\s+)(?:"?public"?\s*\.\s*)?(?:"?employer_profiles"?|\$\{\s*(?:\w+\.)?employerProfiles\s*\})/i;

/** A template's text with each `${…}` kept as written. */
function templateText(node: ts.TemplateLiteral): string {
  if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return (
    node.head.text +
    node.templateSpans.map((s) => "${" + s.expression.getText() + "}" + s.literal.text).join("")
  );
}

/** The executor a raw template runs on: `x.execute(sql…)`, or a tagged `tx\`…\`` / `client.sql\`…\``. */
function rawExecutor(template: ts.TemplateLiteral): string | null {
  let node: ts.Node = template;
  if (ts.isTaggedTemplateExpression(node.parent)) {
    const tag = node.parent.tag;
    node = node.parent;
    if (!(ts.isIdentifier(tag) && tag.text === "sql")) return flat(tag.getText());
  }
  const call = node.parent;
  if (
    call !== undefined &&
    ts.isCallExpression(call) &&
    ts.isPropertyAccessExpression(call.expression) &&
    call.expression.name.text === "execute"
  ) {
    return flat(call.expression.expression.getText());
  }
  return null;
}

/** Every standing write and every re-stamp call in one source text. */
function analyse(fileName: string, text: string): { writes: StandingWrite[]; restamps: Restamp[] } {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const b = tableBindings(sf);
  const writes: StandingWrite[] = [];
  const restamps: Restamp[] = [];
  const lineOf = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && callee.text === HELPER && node.arguments[0] !== undefined) {
        restamps.push({
          start: node.getStart(),
          executor: flat(node.arguments[0].getText()),
          fn: enclosingFunction(node),
        });
      }
      if (ts.isPropertyAccessExpression(callee) && node.arguments.length === 1) {
        const method = callee.name.text;
        const table = tableOf(node.arguments[0], b);
        const executor = flat(unwrap(callee.expression).getText());
        const record = (kind: string) =>
          writes.push({
            kind,
            end: chainEnd(node),
            line: lineOf(node.getStart()),
            executor,
            fn: enclosingFunction(node),
            member: memberName(node),
          });
        if (table === "employerProfiles" && ["insert", "update", "delete"].includes(method)) {
          record(`employer_profiles ${method}`);
        }
        if (table === "payers" && method === "update") {
          const set = chainAfter(node).find((c) => c.name === "set");
          if (set !== undefined && setsStatus(set.args[0])) record("payers.status update");
        }
        if (table === "payers" && method === "insert") {
          const upsert = chainAfter(node).find((c) => c.name === "onConflictDoUpdate");
          const cfg = upsert?.args[0] === undefined ? undefined : unwrap(upsert.args[0]);
          if (cfg !== undefined && ts.isObjectLiteralExpression(cfg)) {
            const setProp = cfg.properties.find(
              (p): p is ts.PropertyAssignment =>
                ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "set",
            );
            if (
              setProp !== undefined &&
              (!ts.isObjectLiteralExpression(unwrap(setProp.initializer)) ||
                setsStatus(setProp.initializer))
            ) {
              record("payers.status upsert");
            }
          }
        }
      }
    }
    if (ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
      const raw = templateText(node);
      const kind = RAW_PAYERS_STATUS.test(raw)
        ? "raw payers.status update"
        : RAW_EMPLOYER_PROFILES.test(raw)
          ? "raw employer_profiles write"
          : null;
      if (kind !== null) {
        writes.push({
          kind,
          end: node.getEnd(),
          line: lineOf(node.getStart()),
          executor: rawExecutor(node),
          fn: enclosingFunction(node),
          member: memberName(node),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { writes, restamps };
}

/** Is `write` followed by a re-stamp in the same function, on the same executor? */
function restampFollows(write: StandingWrite, restamps: readonly Restamp[]): boolean {
  return restamps.some(
    (r) =>
      r.fn === write.fn &&
      r.start > write.end &&
      (write.executor === null || r.executor === write.executor),
  );
}

function apiFiles(): { file: string; text: string }[] {
  return sourceFiles(API_SRC).map((full) => ({
    file: relative(API_SRC, full).split(sep).join("/"),
    text: readFileSync(full, "utf8"),
  }));
}

describe("every writer of a company's Campus standing re-stamps its drive requests (migration review M1)", () => {
  const files = apiFiles();
  const analysed = files.map((f) => ({ ...f, ...analyse(f.file, f.text) }));

  it("the scan sees the writers it exists for (it has not gone blind)", () => {
    const writers = analysed.filter((a) => a.writes.length > 0).map((a) => a.file);
    for (const known of HELPER_IMPORTERS) expect(writers).toContain(known);
  });

  it("each standing write is followed by restampCompanyDriveRequests on the same executor, in the same function", () => {
    const missing: string[] = [];
    for (const { file, writes, restamps } of analysed) {
      for (const w of writes) {
        if (`${file} ${w.member}` in NOT_STANDING_WRITES) continue;
        if (!restampFollows(w, restamps)) missing.push(`${file}:${w.line} ${w.kind}`);
      }
    }
    expect(missing, "re-stamp after these writes, on the write's own transaction").toEqual([]);
  });

  it("every named non-standing write still exists (the list stays honest)", () => {
    const flagged = new Set(
      analysed.flatMap(({ file, writes }) => writes.map((w) => `${file} ${w.member}`)),
    );
    expect(Object.keys(NOT_STANDING_WRITES).filter((k) => !flagged.has(k))).toEqual([]);
  });

  it("only the writers that call it today import the helper (security re-check L4)", () => {
    const importers = files
      .filter(({ file, text }) => {
        if (file === "campus-drives/campus-drive-feed-stamp.ts") return false;
        const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
        return sf.statements.some(
          (s) =>
            ts.isImportDeclaration(s) &&
            ts.isStringLiteral(s.moduleSpecifier) &&
            HELPER_MODULE.test(s.moduleSpecifier.text),
        );
      })
      .map((f) => f.file)
      .sort();
    expect(importers).toEqual([...HELPER_IMPORTERS].sort());
  });

  describe("the scan itself", () => {
    const IMPORTS = 'import { payers, employerProfiles } from "@badabhai/db";\n';
    const BT = String.fromCharCode(96);
    const DL = String.fromCharCode(36);
    const raw = (sqlText: string) => "sql" + BT + sqlText + BT;
    const member = (body: string) =>
      `${IMPORTS}class R {\n  async write(tx: Db, id: string) {\n${body}\n  }\n\n  async next() {}\n}`;
    const restamp = "\n    await restampCompanyDriveRequests(tx, id);";
    const scan = (src: string) => analyse("fixture.ts", src);
    const covered = (src: string) => {
      const { writes, restamps } = scan(src);
      return writes.map((w) => restampFollows(w, restamps));
    };

    it.each([
      ["a status key", `await tx.update(payers).set({ status: "suspended" }).where(w);`],
      ["a status key after others", `await tx.update(payers).set({ a: 1, status: x }).where(w);`],
      ["a status shorthand", `await tx.update(payers).set({ status }).where(w);`],
      ["a spread into the set", `await tx.update(payers).set({ ...patch, updatedAt }).where(w);`],
      [
        "a spread of a call",
        `await tx.update(payers).set({ ...this.columns(x), updatedAt }).where(w);`,
      ],
      [
        "a spread of a conditional that may set status",
        `await tx.update(payers).set({ ...(on ? { status: "active" } : {}) }).where(w);`,
      ],
      [
        "an upsert that sets status on conflict",
        `await tx.insert(payers).values(v).onConflictDoUpdate({ target: payers.id, set: { status: "active" } });`,
      ],
      [
        "an upsert whose set is not a literal",
        `await tx.insert(payers).values(v).onConflictDoUpdate({ target: payers.id, set: row });`,
      ],
      ["an employer_profiles insert", `await tx.insert(employerProfiles).values(v);`],
      ["an employer_profiles update", `await tx.update(employerProfiles).set(s).where(w);`],
      ["an employer_profiles delete", `await tx.delete(employerProfiles).where(w);`],
      [
        "raw UPDATE payers",
        `await tx.execute(${raw("UPDATE payers SET status = 'archived' WHERE id = " + DL + "{id}")});`,
      ],
      [
        "raw UPDATE public.payers",
        `await tx.execute(${raw("update public.payers set status = 'suspended'")});`,
      ],
      [
        "raw UPDATE ${payers}",
        `await tx.execute(${raw("UPDATE " + DL + "{payers} SET status = " + DL + "{s} WHERE id = " + DL + "{id}")});`,
      ],
      [
        "raw DELETE FROM employer_profiles",
        `await tx.execute(${raw("DELETE FROM employer_profiles WHERE payer_id = " + DL + "{id}")});`,
      ],
      [
        "raw UPDATE employer_profiles",
        `await tx.execute(${raw("update employer_profiles set gst_number_enc = null")});`,
      ],
    ])("sees %s, and wants the re-stamp after it", (_n, write) => {
      expect(scan(member(write)).writes).toHaveLength(1);
      expect(covered(member(write))).toEqual([false]);
      expect(covered(member(write + restamp))).toEqual([true]);
    });

    it.each([
      [
        "schema.payers (a namespace import)",
        'import * as schema from "@badabhai/db";\n',
        "schema.payers",
      ],
      ["an import alias", 'import { payers as p } from "@badabhai/db";\n', "p"],
      [
        "a Drizzle alias()",
        'import { payers } from "@badabhai/db";\nconst pp = alias(payers, "pp");\n',
        "pp",
      ],
    ])("sees a status write through %s", (_n, header, ref) => {
      const src = `${header}async function write(tx: Db, id: string) {\n  await tx.update(${ref}).set({ status: "archived" }).where(w);\n}`;
      expect(scan(src).writes.map((w) => w.kind)).toEqual(["payers.status update"]);
    });

    it("a re-stamp in a COMMENT does not count", () => {
      const src = member(
        `await tx.update(payers).set({ status: "x" }).where(w);\n    // restampCompanyDriveRequests(tx, id);`,
      );
      expect(covered(src)).toEqual([false]);
    });

    it("a re-stamp on ANOTHER executor (outside the write's transaction) does not count", () => {
      const src = member(
        `await tx.update(payers).set({ status: "x" }).where(w);\n    await restampCompanyDriveRequests(this.db, id);`,
      );
      expect(covered(src)).toEqual([false]);
    });

    it("a re-stamp BEFORE the write, or in another function, does not count", () => {
      const before = member(
        `await restampCompanyDriveRequests(tx, id);\n    await tx.update(payers).set({ status: "x" }).where(w);`,
      );
      expect(covered(before)).toEqual([false]);
      const elsewhere = `${IMPORTS}class R {\n  async write(tx: Db) {\n    await tx.update(payers).set({ status: "x" }).where(w);\n  }\n  async other(tx: Db, id: string) {\n    await restampCompanyDriveRequests(tx, id);\n  }\n}`;
      expect(covered(elsewhere)).toEqual([false]);
      const nested = member(
        `await tx.update(payers).set({ status: "x" }).where(w);\n    const later = async () => restampCompanyDriveRequests(tx, id);`,
      );
      expect(covered(nested)).toEqual([false]);
    });

    it.each([
      ["a name write", `await tx.update(payers).set({ orgNameEnc: x }).where(w);`],
      ["a login stamp", `await tx.update(payers).set({ lastLoginAt: now }).where(w);`],
      ["a prebuilt set object", `await tx.update(payers).set(set).where(w);`],
      [
        "a spread of a conditional literal without status",
        `await tx.update(payers).set({ ...(on ? { sessionsValidAfter: at } : {}), updatedAt }).where(w);`,
      ],
      ["a plain insert of a new payer", `await tx.insert(payers).values({ status: "pending" });`],
      [
        "raw previous_status only",
        `await tx.execute(${raw("UPDATE payers SET previous_status = NULL")});`,
      ],
      [
        "raw status in the WHERE only",
        `await tx.execute(${raw("UPDATE payers SET last_login_at = now() WHERE status = 'active'")});`,
      ],
      [
        "another table's status",
        `await tx.update(jobPostings).set({ status: "closed" }).where(w);`,
      ],
    ])("ignores %s", (_n, write) => {
      expect(scan(member(write)).writes).toEqual([]);
    });
  });
});
