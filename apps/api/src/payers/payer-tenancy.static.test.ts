import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

/**
 * ADR-0053 (PAY-DB-01) — architecture tests for payer org tenancy.
 *
 *  T5  Every function or method that touches a tenant-owned table and takes a RAW payer id
 *      (`payerId: string`, `inviterPayerId: string`, …) must be one of the NAMED_EXCEPTIONS
 *      below — the plan's §4 exceptions, nothing else. Phase 2 retyped every other one to the
 *      branded `TenantKey` and emptied the old UNCONVERTED allowlist; Phase 3 (this PR) DELETED
 *      that list, so there is no longer anywhere to park a raw id: the comparison is EXACT in
 *      both directions against NAMED_EXCEPTIONS alone, and every exception's file must be one
 *      §4 of ORG_TENANCY_PLAN.md names. That is what lets the deploy preflight admit `on`
 *      (risk R66, closed).
 *  T8  `PAYER_ORG_TENANCY_MODE` has one reader, the resolver service.
 *  —   One org choice: only the resolver and the invite-accept invariants read memberships, and
 *      nothing reaches for the retired single-row `resolveOrgForPayer`.
 *  S-F1 Nothing forges the brand: no type assertion to TenantKey / PayerTenantScope /
 *      ActingOrgChoice (or an alias / interface built on one) outside payer-tenant-scope.ts, and
 *      `chooseActingOrg` is imported only by the resolver service and its test. No cast to
 *      `PayerTenantScopeService` outside tests and `*.test-support.ts` (a cast stand-in could
 *      hand out any scope), and no production file imports a `*.test-support` module (the
 *      support files mint keys through stub resolvers; security review of PR #2167, L1).
 *
 * WHAT T5 SEES. A callable — a method, a function declaration, or a class property / variable
 * initialised with an arrow function or function expression — is listed when (a) one of its
 * parameters, or a property of a parameter typed inline, as an array element, as a member of an
 * intersection or union (`{ payerId: string } & WalletCredit`, P3), or by an interface or type
 * literal declared ANYWHERE under apps/api/src, is named `payerId` / `*PayerId` / `agencyId` /
 * `tenant` / `tenantKey` and typed `string`, and (b) its OWN body names a tenant table: a Drizzle
 * table imported from `@badabhai/db`, Drizzle's relational `….query.<table>`, or the table in a
 * `sql` template's FROM / JOIN / INTO / UPDATE. Parsed with the TypeScript compiler (syntax only).
 * The fixture suite below proves each of those paths fires.
 *
 * WHAT T5 CANNOT SEE — HAND-CHECKED IN P3 (ORG_TENANCY_PLAN §5 item 4, every finding recorded
 * there and in the P3 PR). A green T5 is NOT proof of completeness on its own:
 *  1. `PostingPlansRepository.lockPayer` — an advisory lock keyed by the payer id; no table.
 *  2. `PostingPlansRepository.couponUsage` — counts `coupon.redeemed` in `events` (O-4).
 *  3. `PostingPlansRepository.insertPlan`, 4. `insertBoost`, 5. `JobPostingsRepository.create` —
 *     their payer id rides a Drizzle insert type declared in packages/db (`New…`), which this
 *     scan does not read; the same holds for ANY parameter typed by a type from outside
 *     apps/api/src. (5 is hand-converted in P2a: it takes `NewTenantJobPosting`, whose
 *     `payerId` is a `TenantKey | null`. 1–4 are hand-converted in P2c: the lock and the coupon
 *     count take a `TenantKey`; the inserts take `NewTenantPostingPlan` / `NewTenantPostingBoost`,
 *     whose `payerId` is a `TenantKey`. The "T5 blind spots 1–5" case pins all five.)
 *  6. A raw id under a name outside PAYER_ID_NAME (e.g. `ownerId`, `tenantId`, `id`). (`tenant`
 *     and `tenantKey` are inside it since the P2c review: a de-branded `tenant: string` is seen.)
 *  7. A parameter typed `any` / `unknown` that carries a payer id. (P3 closes the CAST form of
 *     it: `x as any` / `x as never` passed where a forgeable type is expected — "S-F1 (P3)"
 *     below. A value that is `any` with no cast at all — an unparsed body, `JSON.parse` — stays
 *     a review rule: inputs reach payer services only as Zod-parsed DTOs and the session id.)
 *  8. A callable that only DELEGATES to a listed helper (deliberate: retyping the helper forces
 *     its callers through the type system — but only once the helper is retyped).
 *  9. A payer id inside an intersection-typed parameter (`UnlocksRepository.creditPack`,
 *     `{ payerId: TenantKey } & WalletCredit`). Closed in P3: the scanner reads intersections and
 *     unions, and creditPack's written signature is pinned below with blind spots 1–5.
 * Closed by this scanner (fixture-tested): arrow-function class properties, top-level const
 * arrows, `this.db.query.<table>`, parameter types declared in another apps/api file, and (P3)
 * intersection / union parameter types.
 */

const SRC = join(__dirname, "..");

/** ADR-0053 §4 classes A and B — the tables keyed by a payer reference. */
const TENANT_TABLES: Record<string, string> = {
  jobPostings: "job_postings",
  jobs: "jobs",
  postingPlans: "posting_plans",
  postingBoosts: "posting_boosts",
  payerCapacity: "payer_capacity",
  unlocks: "unlocks",
  resumeDisclosures: "resume_disclosures",
  payerCredits: "payer_credits",
  creditLedger: "credit_ledger",
  paymentOrders: "payment_orders",
  agencyInvites: "agency_invites",
  referralLinks: "referral_links",
  agencyKyc: "agency_kyc",
  agencyPayoutRequests: "agency_payout_requests",
  agencyPayoutAccruals: "agency_payout_accruals",
  payerJobPostingChatSessions: "payer_job_posting_chat_sessions",
  payerJobPostingChatMessages: "payer_job_posting_chat_messages",
  payerFormDrafts: "payer_form_drafts",
};
const SQL_TABLE = new RegExp(
  `\\b(?:from|join|into|update)\\s+(?:public\\.)?(${Object.values(TENANT_TABLES).join("|")})\\b`,
  "i",
);
/**
 * `payerId`, `inviterPayerId`, `agencyPayerId`, … the payout module's `agencyId`, and the
 * tenancy vocabulary itself — `tenant` / `tenantKey` — so a converted parameter that loses its
 * brand but keeps its name (`tenant: string`) is caught (review of PR #2174, security L1; the
 * same finding, F3, on PR #2175).
 */
const PAYER_ID_NAME = /^(?:[a-z][A-Za-z]*PayerId|payerId|agencyId|tenant|tenantKey)$/;

/**
 * Stay actor- or literal-keyed through the flip (ORG_TENANCY_PLAN §4). Each needs a reason a
 * reviewer can check; adding one is an ADR-level decision, not a way to make this test pass.
 */
const NAMED_EXCEPTIONS: readonly string[] = [
  // Member-private AI posting-chat drafts (O-7): every method of the chat repository.
  "payer-portal/job-posting-chat/job-posting-chat.repository.ts JobPostingChatRepository.bindPublishedPosting",
  "payer-portal/job-posting-chat/job-posting-chat.repository.ts JobPostingChatRepository.claimForPublish",
  "payer-portal/job-posting-chat/job-posting-chat.repository.ts JobPostingChatRepository.createSession",
  "payer-portal/job-posting-chat/job-posting-chat.repository.ts JobPostingChatRepository.findOwnedSession",
  "payer-portal/job-posting-chat/job-posting-chat.repository.ts JobPostingChatRepository.listSessions",
  "payer-portal/job-posting-chat/job-posting-chat.repository.ts JobPostingChatRepository.releasePublishClaim",
  "payer-portal/job-posting-chat/job-posting-chat.repository.ts JobPostingChatRepository.saveTurn",
  // The per-account signup grant (ADR-0053 §6, free tier): actor-keyed by design.
  "match/free-tier.service.ts FreeTierService.grantForPayer",
  // Ops address an account literally (admin actions, entity views, finance).
  "admin/admin-actions.repository.ts AdminActionsRepository.grantCredits",
  "admin/admin-actions.repository.ts AdminActionsRepository.reinstatePayerInventory",
  "admin/admin-actions.repository.ts AdminActionsRepository.suspendPayerInventory",
  "admin/admin-entities.repository.ts AdminEntitiesRepository.getCreditBalance",
  "admin/admin-entities.repository.ts AdminEntitiesRepository.listCreditLedger",
  "admin/admin-entities.repository.ts AdminEntitiesRepository.listJobPostings",
  "admin/admin-finance.repository.ts AdminFinanceRepository.listLedger",
  "admin/admin-finance.repository.ts AdminFinanceRepository.listOrders",
  // Ops verify / reject the KYC of the account they name (plan §3.4, agency-kyc-ops: literal).
  "agency/agency-kyc.repository.ts AgencyKycRepository.markRejected",
  "agency/agency-kyc.repository.ts AgencyKycRepository.markVerified",
];

// THE OLD `UNCONVERTED` ALLOWLIST IS GONE (Phase 3). Phase 2 emptied it, one domain per PR:
//  - P2a (PR #2167) postings, applicants, Candidates inbox, agency jobs;
//  - P2b (PR #2171) unlocks, credits, ledger, payment orders, resume disclosures, and P2a's
//    shared helper `payers/owned-job-ref.ts findOwnedJobRef`. Hand-converted beside them (T5
//    cannot see these): UnlocksRepository.findOwnedJobRef / .creditPack,
//    ResumeDisclosureRepository.findOwnedJobRef, PaymentGateway.debitOneCreditWithinTx /
//    .purchasePackMock / .createRealOrder / .settleOrder(expectedTenantKey), the reveal and relay
//    owner compares. `countDistinctPayersSince` (both repos) keeps its SQL: distinct ORGS in `on`;
//  - P2c (PR #2174) plans, boosts, quota top-up, capacity, coupons (+ blind spots 1–4 by hand);
//  - P2d (PR #2175) agency invites, workers, KYC, payouts (the ops KYC verify / reject stay
//    literal: NAMED_EXCEPTIONS above).
// With no list to add to, a new raw-id tenant callable can only pass as a §4 exception, which is
// an ADR-level ruling. The deploy preflight admits `on` on that premise (risk R66, closed).

// ---------------------------------------------------------------------------------------------

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return tsFiles(full);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts")
      ? [full]
      : [];
  });
}

const rel = (file: string): string => relative(SRC, file).replace(/\\/g, "/");

function isStringish(type: ts.TypeNode | undefined): boolean {
  if (!type) return false;
  if (type.kind === ts.SyntaxKind.StringKeyword) return true;
  return ts.isUnionTypeNode(type) && type.types.some((t) => t.kind === ts.SyntaxKind.StringKeyword);
}

function membersHaveRawPayerId(members: ts.NodeArray<ts.TypeElement>): boolean {
  return members.some(
    (m) =>
      ts.isPropertySignature(m) &&
      ts.isIdentifier(m.name) &&
      PAYER_ID_NAME.test(m.name.text) &&
      isStringish(m.type),
  );
}

/**
 * Interfaces / type-literal aliases that carry a raw payer id property, by name. Built over EVERY
 * file under apps/api/src, so a parameter typed by an interface declared in another file is seen
 * too. Matching is by name, which can only over-report (a same-named type elsewhere), never hide.
 */
function rawIdTypes(files: readonly ts.SourceFile[]): Set<string> {
  const names = new Set<string>();
  for (const sf of files) for (const name of rawIdTypesIn(sf)) names.add(name);
  return names;
}

function rawIdTypesIn(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  sf.forEachChild((node) => {
    if (ts.isInterfaceDeclaration(node) && membersHaveRawPayerId(node.members)) {
      names.add(node.name.text);
    } else if (
      ts.isTypeAliasDeclaration(node) &&
      ts.isTypeLiteralNode(node.type) &&
      membersHaveRawPayerId(node.type.members)
    ) {
      names.add(node.name.text);
    }
  });
  return names;
}

/**
 * A parameter type that carries a raw payer id: inline, `T[]` / `Array<T>`, a local type, or any
 * member of an intersection / union (`{ payerId: string } & WalletCredit`; P3, blind spot 9).
 */
function typeCarriesRawPayerId(type: ts.TypeNode | undefined, rawTypes: Set<string>): boolean {
  if (!type) return false;
  if (ts.isTypeLiteralNode(type)) return membersHaveRawPayerId(type.members);
  if (ts.isArrayTypeNode(type)) return typeCarriesRawPayerId(type.elementType, rawTypes);
  if (ts.isParenthesizedTypeNode(type)) return typeCarriesRawPayerId(type.type, rawTypes);
  if (ts.isIntersectionTypeNode(type) || ts.isUnionTypeNode(type)) {
    return type.types.some((member) => typeCarriesRawPayerId(member, rawTypes));
  }
  if (ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName)) {
    if (type.typeName.text === "Array" || type.typeName.text === "ReadonlyArray") {
      return typeCarriesRawPayerId(type.typeArguments?.[0], rawTypes);
    }
    return rawTypes.has(type.typeName.text);
  }
  return false;
}

function hasRawPayerIdParam(
  params: ts.NodeArray<ts.ParameterDeclaration>,
  rawTypes: Set<string>,
): boolean {
  return params.some(
    (p) =>
      (ts.isIdentifier(p.name) && PAYER_ID_NAME.test(p.name.text) && isStringish(p.type)) ||
      typeCarriesRawPayerId(p.type, rawTypes),
  );
}

/** Drizzle tenant tables this file imports from @badabhai/db (local name → table). */
function importedTenantTables(sf: ts.SourceFile): Set<string> {
  const locals = new Set<string>();
  sf.forEachChild((node) => {
    if (
      !ts.isImportDeclaration(node) ||
      !ts.isStringLiteral(node.moduleSpecifier) ||
      node.moduleSpecifier.text !== "@badabhai/db"
    ) {
      return;
    }
    const bindings = node.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) return;
    for (const el of bindings.elements) {
      if (el.isTypeOnly) continue;
      const imported = (el.propertyName ?? el.name).text;
      if (imported in TENANT_TABLES) locals.add(el.name.text);
    }
  });
  return locals;
}

function bodyTouchesTenantTable(body: ts.Node, sf: ts.SourceFile, tables: Set<string>): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(node) && tables.has(node.text)) {
      // A real reference, not a property name that happens to match (`x.jobs`).
      const parent = node.parent;
      const isPropertyName =
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isPropertyAssignment(parent) && parent.name === node);
      if (!isPropertyName) found = true;
    }
    // Drizzle's relational API names the table as a PROPERTY: `this.db.query.jobPostings.findFirst`.
    // The key is the schema export name, so it needs no import to count.
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text in TENANT_TABLES &&
      /(^|\.)query$/.test(node.expression.getText(sf))
    ) {
      found = true;
    }
    if (ts.isTaggedTemplateExpression(node) && /sql$/.test(node.tag.getText(sf))) {
      if (SQL_TABLE.test(node.template.getText(sf))) found = true;
    }
    node.forEachChild(visit);
  };
  visit(body);
  return found;
}

/**
 * A named callable with a body: a method, a function declaration, or a class property / variable
 * whose initializer is an arrow function or a function expression (`foo = async (payerId) => …`).
 */
function asCallable(
  node: ts.Node,
  sf: ts.SourceFile,
): { name: string; params: ts.NodeArray<ts.ParameterDeclaration>; body: ts.Node } | null {
  if ((ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) && node.body && node.name) {
    return { name: node.name.getText(sf), params: node.parameters, body: node.body };
  }
  if ((ts.isPropertyDeclaration(node) || ts.isVariableDeclaration(node)) && node.initializer) {
    const init = node.initializer;
    if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
      return { name: node.name.getText(sf), params: init.parameters, body: init.body };
    }
  }
  return null;
}

/**
 * Compute once per test file, then reuse. The source tree is ~1,400 files: re-reading and
 * re-parsing it for every check took this file to 39 s under --coverage on CI, against a 30 s
 * per-test limit (merge-train review of PR #2175). Every check reads the SAME tree.
 */
function once<T>(fn: () => T): () => T {
  let cached: { value: T } | undefined;
  return () => (cached ??= { value: fn() }).value;
}

/** Every non-test source file under apps/api/src with its text — read ONCE per test file. */
const prodFiles = once(
  (): ReadonlyMap<string, string> =>
    new Map(tsFiles(SRC).map((file) => [file, readFileSync(file, "utf8")])),
);

/** Every non-test source file under apps/api/src, parsed (syntax only). */
function parsedSources(): ts.SourceFile[] {
  return [...prodFiles()].map(([file, text]) =>
    ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true),
  );
}

/** {@link parsedSources}, parsed ONCE per test file: T5, S-F1 and N1 all read this one parse. */
const prodSources = once(parsedSources);

/** An in-memory source, for the fixtures that prove each detection path can fire. */
function fixture(path: string, text: string): ts.SourceFile {
  return ts.createSourceFile(join(SRC, path), text, ts.ScriptTarget.Latest, true);
}

/** `<path> <Class>.<member>` / `<path> <function>` for every raw-id tenant-table callable. */
function scanRawTenantKeyCallables(sources: readonly ts.SourceFile[] = prodSources()): string[] {
  const out: string[] = [];
  const rawTypes = rawIdTypes(sources);
  for (const sf of sources) {
    const tables = importedTenantTables(sf);
    const visit = (node: ts.Node, owner: string | null): void => {
      if (ts.isClassDeclaration(node)) {
        node.forEachChild((c) => visit(c, node.name?.text ?? "<anonymous>"));
        return;
      }
      const callable = asCallable(node, sf);
      if (
        callable &&
        hasRawPayerIdParam(callable.params, rawTypes) &&
        bodyTouchesTenantTable(callable.body, sf, tables)
      ) {
        out.push(`${rel(sf.fileName)} ${owner ? `${owner}.${callable.name}` : callable.name}`);
      }
      node.forEachChild((c) => visit(c, owner));
    };
    visit(sf, null);
  }
  return out.sort();
}

describe("T5 — no tenant-table callable takes a raw payer id, except the listed ones (ADR-0053)", () => {
  const found = scanRawTenantKeyCallables();

  it("the scanner finds the known raw-id readers (a guard against a vacuous scan)", () => {
    // One per detection path: a Drizzle table, a raw `sql` template, an inline input type. Each
    // must name a callable that is STILL raw, so all three are NAMED_EXCEPTIONS: they stay raw
    // through the flip and never need swapping (P2d review F2; these used to be P2b/P2d methods).
    // A Drizzle table (`payerCredits`), named directly in the body.
    expect(found).toContain(
      "admin/admin-entities.repository.ts AdminEntitiesRepository.getCreditBalance",
    );
    // Its only table reference is a `dsql` template (the file imports no Drizzle table).
    expect(found).toContain("match/free-tier.service.ts FreeTierService.grantForPayer");
    // Its raw id is `filter.payerId` in an INLINE type literal (the parameter is `filter`).
    expect(found).toContain(
      "admin/admin-entities.repository.ts AdminEntitiesRepository.listJobPostings",
    );
  });

  it("the exceptions are free of duplicates (a reviewable list)", () => {
    expect(new Set(NAMED_EXCEPTIONS).size).toBe(NAMED_EXCEPTIONS.length);
  });

  it("P3: every raw-id tenant-table callable is a §4 NAMED EXCEPTION — nothing is unconverted — and every exception still exists", () => {
    const expected = [...NAMED_EXCEPTIONS].sort();
    const unlisted = found.filter((f) => !expected.includes(f));
    const stale = expected.filter((e) => !found.includes(e));
    expect(
      { unlisted, stale },
      "A raw payer id on a tenant table must take a TenantKey (ADR-0053 §5.2): the flip is armed " +
        "(risk R66 closed), so there is no unconverted list to park it in. Do not add to " +
        "NAMED_EXCEPTIONS without an ADR ruling and a row in ORG_TENANCY_PLAN §4.",
    ).toEqual({ unlisted: [], stale: [] });
  });

  it("P3: the exceptions are exactly the plan's §4 — every exception's file is a path §4 names", () => {
    const plan = readFileSync(join(SRC, "../../../docs/payer-agent/ORG_TENANCY_PLAN.md"), "utf8");
    const from = plan.indexOf("## 4. Explicit exceptions");
    const to = plan.indexOf("\n## 5.", from);
    expect(from, "ORG_TENANCY_PLAN.md §4 not found").toBeGreaterThan(-1);
    const section = plan.slice(from, to < 0 ? undefined : to);
    // §4 names every file by its full `apps/api/src/…` path (so this read needs no shorthand).
    const named = new Set(
      [...section.matchAll(/`apps\/api\/src\/([^`\s]+\.ts)`/g)].map((m) => m[1]!),
    );
    expect(named.size, "§4 lists no apps/api/src path: the read is broken").toBeGreaterThan(0);
    const outside = NAMED_EXCEPTIONS.map((e) => e.split(" ")[0]!).filter(
      (file) => !named.has(file),
    );
    expect([...new Set(outside)], "add the file to ORG_TENANCY_PLAN §4, with its reason").toEqual(
      [],
    );
  });
});

/** The written type of each parameter of `Class.method` in `file` (syntax only). */
function paramTypesOf(file: string, className: string, method: string): string[] {
  const sf = ts.createSourceFile(
    file,
    readFileSync(join(SRC, file), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  let found: string[] | null = null;
  sf.forEachChild((node) => {
    if (!ts.isClassDeclaration(node) || node.name?.text !== className) return;
    for (const member of node.members) {
      if (ts.isMethodDeclaration(member) && member.name.getText(sf) === method) {
        found = member.parameters.map((p) => p.type?.getText(sf) ?? "<untyped>");
      }
    }
  });
  if (found === null) throw new Error(`${file}: ${className}.${method} not found`);
  return found;
}

/** The written type of `property` on the top-level type alias `alias` in `file`. */
function aliasPropertyType(file: string, alias: string, property: string): string | null {
  const sf = ts.createSourceFile(
    file,
    readFileSync(join(SRC, file), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  let found: string | null = null;
  const visit = (node: ts.Node): void => {
    if (ts.isPropertySignature(node) && ts.isIdentifier(node.name) && node.name.text === property) {
      found = node.type?.getText(sf) ?? null;
    }
    node.forEachChild(visit);
  };
  sf.forEachChild((node) => {
    if (ts.isTypeAliasDeclaration(node) && node.name.text === alias) visit(node.type);
  });
  return found;
}

/** The written type of `property` inside parameter `index` of `Class.method` in `file`. */
function paramPropertyType(
  file: string,
  className: string,
  method: string,
  index: number,
  property: string,
): string | null {
  const sf = ts.createSourceFile(
    file,
    readFileSync(join(SRC, file), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  let found: string | null = null;
  sf.forEachChild((node) => {
    if (!ts.isClassDeclaration(node) || node.name?.text !== className) return;
    for (const member of node.members) {
      if (!ts.isMethodDeclaration(member) || member.name.getText(sf) !== method) continue;
      const type = member.parameters[index]?.type;
      const visit = (n: ts.Node): void => {
        if (ts.isPropertySignature(n) && ts.isIdentifier(n.name) && n.name.text === property) {
          found = n.type?.getText(sf) ?? null;
        }
        n.forEachChild(visit);
      };
      if (type) visit(type);
    }
  });
  return found;
}

/**
 * T5's blind spots 1–5 (the header list) are converted by HAND, so nothing above would notice a
 * revert: a `TenantKey` is assignable to `string`, so retyping one of these back to a raw id
 * still compiles. Pinned here by their written signatures instead.
 */
describe("T5 blind spots 1–5 and 9 — the hand-converted callables keep taking the tenant key (P2a, P2b, P2c)", () => {
  const PLANS = "posting-plans/posting-plans.repository.ts";

  it("1, 2: the capacity advisory lock and the coupon count take a TenantKey (O-4)", () => {
    expect(paramTypesOf(PLANS, "PostingPlansRepository", "lockPayer")).toEqual(["Tx", "TenantKey"]);
    expect(paramTypesOf(PLANS, "PostingPlansRepository", "couponUsage")).toEqual([
      "string",
      "TenantKey",
    ]);
  });

  it("3, 4: the plan and boost inserts take an insert type whose payerId is a TenantKey", () => {
    expect(paramTypesOf(PLANS, "PostingPlansRepository", "insertPlan")[0]).toBe(
      "NewTenantPostingPlan",
    );
    expect(paramTypesOf(PLANS, "PostingPlansRepository", "insertBoost")[0]).toBe(
      "NewTenantPostingBoost",
    );
    expect(aliasPropertyType(PLANS, "NewTenantPostingPlan", "payerId")).toBe("TenantKey");
    expect(aliasPropertyType(PLANS, "NewTenantPostingBoost", "payerId")).toBe("TenantKey");
  });

  it("5: the posting insert takes NewTenantJobPosting, whose payerId is a TenantKey or NULL (ops)", () => {
    const POSTINGS = "job-postings/job-postings.repository.ts";
    expect(paramTypesOf(POSTINGS, "JobPostingsRepository", "create")[0]).toBe(
      "NewTenantJobPosting",
    );
    expect(aliasPropertyType(POSTINGS, "NewTenantJobPosting", "payerId")).toBe("TenantKey | null");
  });

  it("9 (P3): creditPack's wallet — `payerId` inside its INTERSECTION parameter — is a TenantKey", () => {
    // `{ payerId: TenantKey } & WalletCredit` (P2b). T5 reads intersections since P3, but the
    // written signature is pinned too, the way P2c pinned its hand conversions.
    const UNLOCKS = "unlocks/unlocks.repository.ts";
    expect(paramPropertyType(UNLOCKS, "UnlocksRepository", "creditPack", 0, "payerId")).toBe(
      "TenantKey",
    );
    expect(paramTypesOf(UNLOCKS, "UnlocksRepository", "creditPack")).toHaveLength(1);
  });
});

/** Non-test source under apps/api/src, comments stripped (prose may name what code must not do). */
function codeOf(file: string): string {
  return (prodFiles().get(file) ?? readFileSync(file, "utf8"))
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** The paths of {@link prodFiles} (no second directory walk). */
const prodPaths = (): string[] => [...prodFiles().keys()];

describe("T8 — PAYER_ORG_TENANCY_MODE has ONE reader (ADR-0053 §5.3)", () => {
  it("only the resolver service reads the mode", () => {
    const readers = prodPaths()
      .filter((f) => codeOf(f).includes("PAYER_ORG_TENANCY_MODE"))
      .map(rel);
    expect(readers).toEqual(["payers/payer-tenant-scope.service.ts"]);
  });
});

describe("one org choice — every caller goes through the resolver (ADR-0053 §3.2)", () => {
  it("only the resolver and the invite-accept invariants read a payer's memberships", () => {
    const readers = prodPaths()
      .filter((f) => /\.listActiveMembershipsWithAnchor\(/.test(codeOf(f)))
      .map(rel)
      .sort();
    expect(readers).toEqual([
      "payer-portal/payer-org-members.service.ts",
      "payers/payer-tenant-scope.service.ts",
    ]);
  });

  it("nothing picks an org on its own: the retired single-row read is gone", () => {
    const offenders = prodPaths()
      .filter((f) => /\bresolveOrgForPayer\b/.test(codeOf(f)))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it("the guard, the session claim, GET /payer/me and login all ask the resolver", () => {
    for (const file of [
      "payers/payer-org-role.guard.ts",
      "payers/payer-session-org-claim.ts",
      "payers/payer-account.service.ts",
      "payer-portal/payer-auth.service.ts",
    ]) {
      // Login asks the HEALING entry point (one place repairs a missing org, review L1). The org-
      // role guard asks the TENANT entry point, once, and hands that scope on (PR #2175 F1).
      // GET/PATCH /payer/me ask the SELF-VIEW entry point (the org + the tenant key, O-10; P3).
      expect(codeOf(join(SRC, file)), file).toMatch(
        /\.(resolve|resolveActingOrg|ensureActingOrg|resolveSelfView)\(/,
      );
    }
  });

  it("invite rule A1 uses the resolver's one 'team' predicate, never its own comparison", () => {
    const code = codeOf(join(SRC, "payer-portal/payer-org-members.service.ts"));
    expect(code).toMatch(/isTeamMembership\(/);
    expect(code).not.toMatch(/anchorPayerId\s*!==/);
  });
});

describe("T5's scanner — every detection path fires (fixtures, so a quiet scan is not a vacuous one)", () => {
  const TABLE_IMPORT = `import { jobPostings, unlocks } from "@badabhai/db";\n`;

  it("a method on a Drizzle table, and not a method that touches none", () => {
    const found = scanRawTenantKeyCallables([
      fixture(
        "fx/method.repository.ts",
        `${TABLE_IMPORT}export class FxRepository {
          async listOwned(payerId: string) { return this.db.select().from(jobPostings); }
          async label(payerId: string) { return this.labels.jobs.get(payerId); }
        }`,
      ),
    ]);
    expect(found).toEqual(["fx/method.repository.ts FxRepository.listOwned"]);
  });

  it("an arrow-function class property", () => {
    const found = scanRawTenantKeyCallables([
      fixture(
        "fx/arrow.repository.ts",
        `${TABLE_IMPORT}export class FxRepository {
          listOwned = async (payerId: string) => this.db.select().from(jobPostings);
        }`,
      ),
    ]);
    expect(found).toEqual(["fx/arrow.repository.ts FxRepository.listOwned"]);
  });

  it("a top-level const arrow and a const function expression", () => {
    const found = scanRawTenantKeyCallables([
      fixture(
        "fx/consts.ts",
        `${TABLE_IMPORT}export const countOwned = async (db: Db, payerId: string) => db.select().from(unlocks);
        export const listOwned = async function (db: Db, payerId: string) { return db.select().from(unlocks); };`,
      ),
    ]);
    expect(found).toEqual(["fx/consts.ts countOwned", "fx/consts.ts listOwned"]);
  });

  it("Drizzle's relational API (`this.db.query.<table>`), with no table import at all", () => {
    const found = scanRawTenantKeyCallables([
      fixture(
        "fx/relational.repository.ts",
        `export class FxRepository {
          async findOne(payerId: string) { return this.db.query.unlocks.findFirst({}); }
        }`,
      ),
    ]);
    expect(found).toEqual(["fx/relational.repository.ts FxRepository.findOne"]);
  });

  it("a property of a parameter typed INLINE — a type literal, alone or as an array element", () => {
    // Pinned by a fixture as well as by the live example above (review of PR #2167, finding 5):
    // P2d converted the agency methods that were this path's only live examples then.
    const found = scanRawTenantKeyCallables([
      fixture(
        "fx/inline.repository.ts",
        `${TABLE_IMPORT}export class FxRepository {
          async create(input: { inviterPayerId: string; code: string }) { return this.db.insert(unlocks).values(input); }
          async accrue(rows: Array<{ agencyPayerId: string }>) { return this.db.insert(unlocks).values(rows); }
          async count(input: { inviterPayerId: number }) { return this.db.select().from(unlocks); }
        }`,
      ),
    ]);
    expect(found).toEqual([
      "fx/inline.repository.ts FxRepository.accrue",
      "fx/inline.repository.ts FxRepository.create",
    ]);
  });

  it("a parameter typed by an interface declared in ANOTHER file", () => {
    const found = scanRawTenantKeyCallables([
      fixture("fx/types.ts", `export interface FxOwnedInput { agencyPayerId: string; n: number }`),
      fixture(
        "fx/cross.repository.ts",
        `${TABLE_IMPORT}import type { FxOwnedInput } from "./types";
        export class FxRepository {
          async create(input: FxOwnedInput) { return this.db.insert(unlocks).values(input); }
        }`,
      ),
    ]);
    expect(found).toEqual(["fx/cross.repository.ts FxRepository.create"]);
  });

  it("a property of an INTERSECTION or UNION parameter type (P3, blind spot 9 — creditPack's shape)", () => {
    const found = scanRawTenantKeyCallables([
      fixture(
        "fx/intersect.repository.ts",
        `${TABLE_IMPORT}import type { TenantKey } from "../payers/payer-tenant-scope";
        interface Credit { credits: number }
        export class FxRepository {
          async credit(input: { payerId: string } & Credit) { return this.db.insert(unlocks).values(input); }
          async maybe(input: ({ agencyPayerId: string }) | null) { return this.db.select().from(unlocks); }
          async ok(input: { payerId: TenantKey } & Credit) { return this.db.insert(unlocks).values(input); }
        }`,
      ),
    ]);
    expect(found).toEqual([
      "fx/intersect.repository.ts FxRepository.credit",
      "fx/intersect.repository.ts FxRepository.maybe",
    ]);
  });

  it("a raw table name in a `sql` template", () => {
    const found = scanRawTenantKeyCallables([
      fixture(
        "fx/raw.repository.ts",
        "export function stmt(payerId: string) { return sql`SELECT 1 FROM payment_orders WHERE payer_id = ${payerId}`; }",
      ),
    ]);
    expect(found).toEqual(["fx/raw.repository.ts stmt"]);
  });

  it("a raw id under the tenancy vocabulary itself — `tenant` / `tenantKey` typed `string` (review of PR #2174, L1)", () => {
    // The converted repositories name the parameter `tenant`; a revert that keeps the name but
    // drops the brand (`tenant: string`) must not slip past the scan. Typed `TenantKey`, it is fine.
    const found = scanRawTenantKeyCallables([
      fixture(
        "fx/tenant.repository.ts",
        `${TABLE_IMPORT}import type { TenantKey } from "../payers/payer-tenant-scope";
        export class FxRepository {
          async count(tx: Tx, tenant: string) { return tx.select().from(unlocks); }
          async find(id: string, tenantKey: string | undefined) { return this.db.select().from(jobPostings); }
          async create(input: { tenant: string }) { return this.db.insert(unlocks).values(input); }
          async ok(tx: Tx, tenant: TenantKey) { return tx.select().from(unlocks); }
        }`,
      ),
    ]);
    expect(found).toEqual([
      "fx/tenant.repository.ts FxRepository.count",
      "fx/tenant.repository.ts FxRepository.create",
      "fx/tenant.repository.ts FxRepository.find",
    ]);
  });
});

/**
 * S-F1 (security review) — the brand holds only while nothing forges it. A `TenantKey` is a
 * compile-time device: `x as TenantKey` (or `as unknown as TenantKey`, or `<TenantKey>x`) would
 * mint one from any string and walk a body/path/JWT value into a tenant predicate. So:
 *  - no type assertion to TenantKey / PayerTenantScope / ActingOrgChoice in non-test source
 *    outside payer-tenant-scope.ts (its private `asTenantKey` is the one constructor);
 *  - `chooseActingOrg` — the only function that returns a scope — is imported only by the
 *    resolver service (and its own unit test), and re-exported by nobody.
 */
const FORGEABLE = ["TenantKey", "PayerTenantScope", "ActingOrgChoice"];
const SCOPE_FILE = "payers/payer-tenant-scope.ts";

/**
 * Every type reference inside `node`, as written: `TenantKey`, `scope.TenantKey`, and the
 * import-type form `import("./payer-tenant-scope").TenantKey` (a forge spelled that way got past
 * the first version of this screen).
 */
function typeNamesIn(node: ts.Node, sf: ts.SourceFile): string[] {
  const out: string[] = [];
  const walk = (t: ts.Node): void => {
    if (ts.isTypeReferenceNode(t)) out.push(t.typeName.getText(sf));
    else if (ts.isExpressionWithTypeArguments(t)) out.push(t.expression.getText(sf));
    else if (ts.isImportTypeNode(t) && t.qualifier) out.push(t.qualifier.getText(sf));
    t.forEachChild(walk);
  };
  walk(node);
  return out;
}

const lastName = (written: string): string => written.split(".").pop()!;

/**
 * The forgeable tenancy types PLUS every alias or interface built on one outside
 * payer-tenant-scope.ts (`type K = TenantKey`, `interface In { tenant: TenantKey }`, `interface S
 * extends PayerTenantScope`), to a fixpoint — casting to any of those forges a key just the same.
 */
function forgeableNames(
  sources: readonly ts.SourceFile[],
  seed: readonly string[] = FORGEABLE,
): Set<string> {
  const names = new Set(seed);
  for (let grew = true; grew; ) {
    grew = false;
    for (const sf of sources) {
      if (rel(sf.fileName) === SCOPE_FILE) continue;
      sf.forEachChild((node) => {
        if (!ts.isTypeAliasDeclaration(node) && !ts.isInterfaceDeclaration(node)) return;
        if (names.has(node.name.text)) return;
        if (typeNamesIn(node, sf).some((n) => names.has(lastName(n)))) {
          names.add(node.name.text);
          grew = true;
        }
      });
    }
  }
  return names;
}

/**
 * `path:line Type` for every type assertion (`as T`, `<T>x`, `as unknown as T`) whose target
 * names a forgeable type, every explicit CALL type argument that does (`launder<TenantKey>(id)`
 * through a generic `x as T`), and (P3, review N1 of PR #2155) every TYPE PREDICATE or ASSERTION
 * FUNCTION that does (`(x: string): x is TenantKey`, `asserts x is TenantKey`): either mints a
 * key from any string at its call site with no visible cast.
 */
function forgedTenancyCasts(
  sources: readonly ts.SourceFile[],
  seed: readonly string[] = FORGEABLE,
): string[] {
  const names = forgeableNames(sources, seed);
  const out: string[] = [];
  for (const sf of sources) {
    const report = (at: ts.Node, typeNode: ts.Node): void => {
      for (const written of typeNamesIn(typeNode, sf)) {
        if (!names.has(lastName(written))) continue;
        const line = sf.getLineAndCharacterOfPosition(at.getStart(sf)).line + 1;
        out.push(`${rel(sf.fileName)}:${line} ${written}`);
      }
    };
    const visit = (node: ts.Node): void => {
      if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) report(node, node.type);
      if (ts.isCallExpression(node)) for (const arg of node.typeArguments ?? []) report(node, arg);
      // `x is T` and `asserts x is T` (a bare `asserts x` has no type and names nothing).
      if (ts.isTypePredicateNode(node) && node.type) report(node, node.type);
      node.forEachChild(visit);
    };
    visit(sf);
  }
  return out;
}

/**
 * Callable name → the indices of its parameters whose WRITTEN type names a forgeable type
 * (`tenant: TenantKey`, `scope: PayerTenantScope`, `input: NewTenantJobPosting`,
 * `{ payerId: TenantKey } & WalletCredit`). Matching is by NAME, so a same-named callable elsewhere
 * can only add positions (over-report), never hide one.
 */
function forgeableParamPositions(
  sources: readonly ts.SourceFile[],
  names: Set<string>,
): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  for (const sf of sources) {
    const visit = (node: ts.Node): void => {
      const callable = asCallable(node, sf);
      callable?.params.forEach((param, index) => {
        if (!param.type || !typeNamesIn(param.type, sf).some((n) => names.has(lastName(n)))) return;
        const at = out.get(callable.name) ?? new Set<number>();
        at.add(index);
        out.set(callable.name, at);
      });
      node.forEachChild(visit);
    };
    visit(sf);
  }
  return out;
}

/** `x as any` / `x as never` / `<any>x` / `<never>x`: the casts that assign to ANY type. */
function isEscapeHatchCast(expression: ts.Expression): boolean {
  let e = expression;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  return (
    (ts.isAsExpression(e) || ts.isTypeAssertionExpression(e)) &&
    (e.type.kind === ts.SyntaxKind.AnyKeyword || e.type.kind === ts.SyntaxKind.NeverKeyword)
  );
}

/**
 * An argument that launders an id into a tenant position: an escape-hatch cast itself, or an
 * object literal whose payer-id-named property (`payerId: x as never`) is one.
 */
function launders(argument: ts.Expression): boolean {
  if (isEscapeHatchCast(argument)) return true;
  let e = argument;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  return (
    ts.isObjectLiteralExpression(e) &&
    e.properties.some(
      (p) =>
        ts.isPropertyAssignment(p) &&
        ts.isIdentifier(p.name) &&
        PAYER_ID_NAME.test(p.name.text) &&
        isEscapeHatchCast(p.initializer),
    )
  );
}

/**
 * S-F1 (P3) — `path:line callee#index` for every call that passes an `as any` / `as never` cast
 * where the callee's parameter is written with a forgeable type. Neither cast names `TenantKey`,
 * so the cast screen above cannot see it, yet both assign to it: `repo.find(id, body.x as never)`
 * mints a tenant key from a request value. Syntax only (no type checker: the whole-program check
 * would cost more than this file's 30 s budget), so a value that is `any` with no cast at all
 * stays a review rule (blind spot 7).
 */
function escapeHatchTenancyArgs(sources: readonly ts.SourceFile[]): string[] {
  const positions = forgeableParamPositions(sources, forgeableNames(sources));
  const out: string[] = [];
  for (const sf of sources) {
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = ts.isPropertyAccessExpression(node.expression)
          ? node.expression.name.text
          : ts.isIdentifier(node.expression)
            ? node.expression.text
            : null;
        const at = callee === null ? undefined : positions.get(callee);
        node.arguments.forEach((argument, index) => {
          if (!at?.has(index) || !launders(argument)) return;
          const line = sf.getLineAndCharacterOfPosition(argument.getStart(sf)).line + 1;
          out.push(`${rel(sf.fileName)}:${line} ${callee}#${index}`);
        });
      }
      node.forEachChild(visit);
    };
    visit(sf);
  }
  return out;
}

/** Every file (tests included) that imports or re-exports `chooseActingOrg`. */
function chooseActingOrgImporters(sources: readonly ts.SourceFile[]): string[] {
  const out: string[] = [];
  for (const sf of sources) {
    sf.forEachChild((node) => {
      const spec =
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
          ? node.moduleSpecifier.text
          : null;
      if (!spec || !/(^|\/)payer-tenant-scope$/.test(spec)) return;
      const bindings = ts.isImportDeclaration(node)
        ? node.importClause?.namedBindings
        : (node as ts.ExportDeclaration).exportClause;
      const names =
        bindings && (ts.isNamedImports(bindings) || ts.isNamedExports(bindings))
          ? bindings.elements.map((e) => (e.propertyName ?? e.name).text)
          : ["*"]; // a namespace import / `export *` exposes everything
      if (names.includes("chooseActingOrg") || names.includes("*")) out.push(rel(sf.fileName));
    });
  }
  return out.sort();
}

/**
 * A module specifier written with an escape sequence (`"./x.test-support"`): its cooked
 * text names a module its raw text does not. The text pre-filters below let such a file through.
 */
const ESCAPED_SPECIFIER = /(?:from|import|require)\s*\(?\s*["'][^"'\n]*\\[ux]/;

/** True when an import-only screen for `needle` must parse this file (a lossless pre-filter). */
const mayImport = (text: string, needle: string): boolean =>
  text.includes(needle) || ESCAPED_SPECIFIER.test(text);

/** Every .ts path under apps/api/src, tests included (an import from a test is still an import). */
function allTsPaths(dir: string = SRC): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return allTsPaths(full);
    return name.endsWith(".ts") && !name.endsWith(".d.ts") ? [full] : [];
  });
}

/**
 * Every .ts under apps/api/src, tests included, that can import from `needle`, parsed. A module
 * specifier naming `payer-tenant-scope` must contain it verbatim (or carry an escape, which
 * {@link mayImport} lets through), so pre-filtering on the RAW text loses nothing and spares
 * parsing ~1,300 files to read their imports.
 */
function sourcesThatMayImport(needle: string): ts.SourceFile[] {
  return allTsPaths().flatMap((file) => {
    const text = readFileSync(file, "utf8");
    return mayImport(text, needle)
      ? [ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)]
      : [];
  });
}

/** The resolver itself: a cast stand-in (`{ resolve: … } as PayerTenantScopeService`) forges scopes. */
const RESOLVER = ["PayerTenantScopeService"];

const isTestSupport = (sf: ts.SourceFile): boolean => sf.fileName.endsWith(".test-support.ts");

/**
 * `path` for every non-test, non-test-support file that imports, re-exports, `import()`s or
 * `require`s a `*.test-support` module. Test support mints keys through stub resolvers and casts
 * fakes to services; none of it may reach production code.
 */
function testSupportImporters(sources: readonly ts.SourceFile[]): string[] {
  const out = new Set<string>();
  const isSupport = (spec: string): boolean => /\.test-support(\.ts)?$/.test(spec);
  for (const sf of sources) {
    // Lossless pre-filter: a specifier naming a `.test-support` module contains that text
    // verbatim, unless escaped (`mayImport` lets an escaped specifier through).
    if (isTestSupport(sf) || !mayImport(sf.text, "test-support")) continue;
    const visit = (node: ts.Node): void => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        isSupport(node.moduleSpecifier.text)
      ) {
        out.add(rel(sf.fileName));
      }
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0]) &&
        isSupport(node.arguments[0].text)
      ) {
        out.add(rel(sf.fileName));
      }
      node.forEachChild(visit);
    };
    visit(sf);
  }
  return [...out].sort();
}

describe("S-F1 — nothing forges a tenant key or a scope (security review, ADR-0053 §5.2 rule 2)", () => {
  it("no type assertion, type predicate or assertion function to TenantKey / PayerTenantScope / ActingOrgChoice outside payer-tenant-scope.ts", () => {
    const offenders = forgedTenancyCasts(prodSources()).filter(
      (o) => !o.startsWith(`${SCOPE_FILE}:`),
    );
    expect(offenders, "mint a TenantKey only through the resolver").toEqual([]);
  });

  it("no cast to PayerTenantScopeService outside tests and *.test-support.ts (L1)", () => {
    const production = prodSources().filter((sf) => !isTestSupport(sf));
    expect(forgedTenancyCasts(production, RESOLVER), "inject the real resolver").toEqual([]);
  });

  it("no production file imports a *.test-support module (L1)", () => {
    expect(testSupportImporters(prodSources())).toEqual([]);
  });

  it("the resolver-cast screen is not vacuous: a cast, an alias cast and a call type argument count", () => {
    const found = forgedTenancyCasts(
      [
        fixture(
          "fx/resolver.ts",
          [
            `const a = fake as unknown as PayerTenantScopeService;`,
            `type R = PayerTenantScopeService;`,
            `const b = fake as R;`,
            `const c = make<PayerTenantScopeService>(fake);`,
            `const d = fake as PayerOrgsRepository;`,
          ].join("\n"),
        ),
      ],
      RESOLVER,
    );
    expect(found).toEqual([
      "fx/resolver.ts:1 PayerTenantScopeService",
      "fx/resolver.ts:3 R",
      "fx/resolver.ts:4 PayerTenantScopeService",
    ]);
  });

  it("the test-support import screen is not vacuous: import, re-export, import() and require count; support files may import each other", () => {
    const found = testSupportImporters([
      fixture(
        "fx/a.ts",
        `import { resolverOver } from "../payers/payer-tenant-scope.test-support";`,
      ),
      fixture("fx/b.ts", `export * from "./x.test-support";`),
      fixture("fx/c.ts", `const m = await import("./y.test-support");`),
      fixture("fx/d.ts", `const m = require("./z.test-support.ts");`),
      fixture("fx/e.ts", `import { x } from "./test-support-utils";`),
      fixture("fx/f.test-support.ts", `import { y } from "./g.test-support";`),
    ]);
    expect(found).toEqual(["fx/a.ts", "fx/b.ts", "fx/c.ts", "fx/d.ts"]);
  });

  it("chooseActingOrg is imported only by the resolver service and its own test", () => {
    expect(chooseActingOrgImporters(sourcesThatMayImport("payer-tenant-scope"))).toEqual([
      "payers/payer-tenant-scope.service.ts",
      "payers/payer-tenant-scope.test.ts",
    ]);
  });

  it("the cast screen is not vacuous: it catches every spelling of a forge, and nothing else", () => {
    const found = forgedTenancyCasts([
      fixture(
        "fx/forge.ts",
        [
          `const a = id as TenantKey;`,
          `const b = id as unknown as TenantKey;`,
          `const c = <TenantKey>id;`,
          `const d = raw as PayerTenantScope;`,
          `const e = raw as scope.ActingOrgChoice;`,
          `const f = id as string;`,
          `const g = list as readonly TenantKey[];`,
          `const h = id as unknown as import("../payers/payer-tenant-scope").TenantKey;`,
          `type Key = TenantKey;`,
          `interface Input { tenant: Key; status: string }`,
          `const i = id as Key;`,
          `const j = body as Input;`,
          `const k = launder<TenantKey>(id);`,
          `const l = new Map<TenantKey, number>();`,
          `const m = body as Record<string, unknown>;`,
        ].join("\n"),
      ),
    ]);
    expect(found).toEqual([
      "fx/forge.ts:1 TenantKey",
      "fx/forge.ts:2 TenantKey",
      "fx/forge.ts:3 TenantKey",
      "fx/forge.ts:4 PayerTenantScope",
      "fx/forge.ts:5 scope.ActingOrgChoice",
      "fx/forge.ts:7 TenantKey",
      "fx/forge.ts:8 TenantKey",
      "fx/forge.ts:11 Key",
      "fx/forge.ts:12 Input",
      "fx/forge.ts:13 TenantKey",
    ]);
  });

  it("the predicate screen is not vacuous: a type predicate or assertion function naming a forgeable type counts, and nothing else (P3, review N1 of PR #2155)", () => {
    const found = forgedTenancyCasts([
      fixture(
        "fx/predicate.ts",
        [
          `function isKey(x: string): x is TenantKey { return true; }`,
          `function assertKey(x: unknown): asserts x is TenantKey {}`,
          `type Key = TenantKey;`,
          `const isAlias = (x: string): x is Key => true;`,
          `class Fx { isScope(x: unknown): x is PayerTenantScope { return true; } }`,
          `function isString(x: unknown): x is string { return true; }`,
          `function assertOk(x: unknown): asserts x {}`,
          `function isKeys(x: unknown): x is readonly TenantKey[] { return true; }`,
          `type Guard = (x: string) => x is scope.TenantKey;`,
        ].join("\n"),
      ),
    ]);
    expect(found).toEqual([
      "fx/predicate.ts:1 TenantKey",
      "fx/predicate.ts:2 TenantKey",
      "fx/predicate.ts:4 Key",
      "fx/predicate.ts:5 PayerTenantScope",
      "fx/predicate.ts:8 TenantKey",
      "fx/predicate.ts:9 scope.TenantKey",
    ]);
  });

  it("no `as any` / `as never` reaches a parameter written with a forgeable type (P3)", () => {
    expect(
      escapeHatchTenancyArgs(prodSources()),
      "pass the resolver's key; never cast a value into a tenant position",
    ).toEqual([]);
  });

  it("the escape-hatch screen is not vacuous: a direct cast, a parenthesised one and an object property count; other positions and casts do not", () => {
    const found = escapeHatchTenancyArgs([
      fixture(
        "fx/launder.ts",
        [
          `type NewTenantRow = { payerId: TenantKey; n: number };`,
          `export class FxRepository {`,
          `  async find(id: string, tenant: TenantKey) { return id; }`,
          `  async create(input: NewTenantRow) { return input; }`,
          `}`,
          `export const scoped = async (scope: PayerTenantScope, n: number) => n;`,
          `function use(repo: FxRepository, body: any, id: string) {`,
          `  repo.find(id, body.payerId as any);`,
          `  repo.find(id, (id as never));`,
          `  repo.find(id as any, key);`,
          `  repo.create({ payerId: id as never, n: 1 });`,
          `  repo.create({ payerId: key, n: 1 as never });`,
          `  repo.find(id, id as string);`,
          `  scoped(body as any, 1);`,
          `  scoped(scope, 1 as never);`,
          `}`,
        ].join("\n"),
      ),
    ]);
    expect(found).toEqual([
      "fx/launder.ts:8 find#1",
      "fx/launder.ts:9 find#1",
      "fx/launder.ts:11 create#0",
      "fx/launder.ts:14 scoped#0",
    ]);
  });

  it("the import screens' raw-text pre-filter is lossless: an ESCAPED specifier is still parsed and caught", () => {
    // `-` is `-`: the cooked specifier names the module, the raw text does not.
    const escapedScope = `import { chooseActingOrg } from "./payer\\u002dtenant-scope";`;
    const escapedSupport = `import { resolverOver } from "../payers/payer-tenant-scope.test\\u002dsupport";`;
    expect(mayImport(escapedScope, "payer-tenant-scope")).toBe(true);
    expect(mayImport(escapedSupport, "test-support")).toBe(true);
    expect(mayImport(`import { a } from "./other";`, "payer-tenant-scope")).toBe(false);
    expect(chooseActingOrgImporters([fixture("fx/esc-a.ts", escapedScope)])).toEqual([
      "fx/esc-a.ts",
    ]);
    expect(testSupportImporters([fixture("fx/esc-b.ts", escapedSupport)])).toEqual(["fx/esc-b.ts"]);
  });

  it("the import screen is not vacuous: a named import, an alias, a namespace and a re-export all count", () => {
    const found = chooseActingOrgImporters([
      fixture("fx/a.ts", `import { chooseActingOrg } from "../payers/payer-tenant-scope";`),
      fixture("fx/b.ts", `import { chooseActingOrg as pick } from "./payer-tenant-scope";`),
      fixture("fx/c.ts", `import * as scope from "../payers/payer-tenant-scope";`),
      fixture("fx/d.ts", `export { chooseActingOrg } from "./payer-tenant-scope";`),
      fixture("fx/e.ts", `import { isTeamMembership } from "../payers/payer-tenant-scope";`),
      fixture("fx/f.ts", `import type { TenantKey } from "../payers/payer-tenant-scope.service";`),
    ]);
    expect(found).toEqual(["fx/a.ts", "fx/b.ts", "fx/c.ts", "fx/d.ts"]);
  });
});

/**
 * A tenant scope reaches a route handler ONLY through `@CurrentTenantScope()` (review N1 of PR
 * #2175). Nest builds a handler argument from its parameter decorator, not its type: a parameter
 * typed `PayerTenantScope` (or any type carrying a `TenantKey`) under `@Body()` / `@Query()` /
 * `@Param()` would turn request JSON into a "scope" with no cast at all, past S-F1. So every route
 * handler parameter whose type names a forgeable tenancy type must carry exactly one decorator,
 * `@CurrentTenantScope()`, the one that reads the scope `PayerOrgRoleGuard` resolved.
 */
const ROUTE_DECORATORS = new Set([
  "Get",
  "Post",
  "Put",
  "Patch",
  "Delete",
  "All",
  "Options",
  "Head",
]);

function decoratorNames(node: ts.Node, sf: ts.SourceFile): string[] {
  const decorators = ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : [];
  return decorators.map((d) =>
    ts.isCallExpression(d.expression)
      ? d.expression.expression.getText(sf)
      : d.expression.getText(sf),
  );
}

/** `checked`: every route-handler parameter typed with a tenancy type; `offenders`: the ones not taken by exactly `@CurrentTenantScope()`. */
function scopeHandlerParams(sources: readonly ts.SourceFile[]): {
  checked: string[];
  offenders: string[];
} {
  const names = forgeableNames(sources);
  const checked: string[] = [];
  const offenders: string[] = [];
  for (const sf of sources) {
    sf.forEachChild((cls) => {
      if (!ts.isClassDeclaration(cls) || !decoratorNames(cls, sf).includes("Controller")) return;
      for (const m of cls.members) {
        if (
          !ts.isMethodDeclaration(m) ||
          !decoratorNames(m, sf).some((d) => ROUTE_DECORATORS.has(d))
        )
          continue;
        m.parameters.forEach((p, i) => {
          if (!p.type || !typeNamesIn(p.type, sf).some((n) => names.has(lastName(n)))) return;
          const at = `${rel(sf.fileName)} ${cls.name?.text}.${m.name.getText(sf)}#${i}`;
          checked.push(at);
          const decorators = ts.canHaveDecorators(p) ? (ts.getDecorators(p) ?? []) : [];
          const only = decorators.length === 1 ? decorators[0]!.expression : undefined;
          const exact =
            only !== undefined &&
            ts.isCallExpression(only) &&
            only.expression.getText(sf) === "CurrentTenantScope" &&
            only.arguments.length === 0;
          if (!exact) offenders.push(at);
        });
      }
    });
  }
  return { checked: checked.sort(), offenders: offenders.sort() };
}

describe("N1 — a tenant scope reaches a handler only through @CurrentTenantScope() (ADR-0053 §5.2 rule 1)", () => {
  it("every route-handler parameter typed with a tenancy type is taken by exactly @CurrentTenantScope()", () => {
    const { checked, offenders } = scopeHandlerParams(prodSources());
    // Not vacuous: the five agency money handlers take the owner gate's scope.
    expect(checked.filter((c) => c.startsWith("agency/agency-payouts.controller.ts"))).toHaveLength(
      5,
    );
    expect(offenders, "take the scope with @CurrentTenantScope(), never from the request").toEqual(
      [],
    );
  });

  it("the screen is not vacuous: body / query / bare / doubled / argument-carrying scopes all count", () => {
    const { checked, offenders } = scopeHandlerParams([
      fixture(
        "fx/scope.controller.ts",
        `type Key = TenantKey;
        @Controller("fx")
        export class FxController {
          @Get("a") a(@CurrentTenantScope() scope: PayerTenantScope) {}
          @Post("b") b(@Body() scope: PayerTenantScope) {}
          @Post("c") c(@Body() dto: { tenant: TenantKey; n: number }) {}
          @Get("d") d(@Query() q: Key) {}
          @Get("e") e(scope: PayerTenantScope) {}
          @Get("f") f(@CurrentTenantScope() @Body() scope: PayerTenantScope) {}
          @Get("g") g(@CurrentTenantScope("x") scope: PayerTenantScope) {}
          @Get("h") h(@CurrentPayer() payer: AuthenticatedPayer, @Body() dto: CreateDto) {}
          private helper(scope: PayerTenantScope) {}
        }
        export class FxService { run(scope: PayerTenantScope) {} }`,
      ),
    ]);
    expect(checked).toHaveLength(7);
    expect(offenders).toEqual(
      ["b", "c", "d", "e", "f", "g"].map((h) => `fx/scope.controller.ts FxController.${h}#0`),
    );
  });
});
