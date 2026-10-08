import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

/**
 * ADR-0053 (PAY-DB-01) — architecture tests for payer org tenancy.
 *
 *  T5  Every function or method that touches a tenant-owned table and takes a RAW payer id
 *      (`payerId: string`, `inviterPayerId: string`, …) is listed below. Phase 2 retypes those
 *      parameters to the branded `TenantKey` and deletes the entry; P3 (the flip) requires
 *      UNCONVERTED to be empty, leaving only NAMED_EXCEPTIONS (plan §4). The comparison is
 *      EXACT in both directions: a new raw-id method fails this test, and so does a converted
 *      one whose entry was not removed — the list cannot go stale.
 *  T8  `PAYER_ORG_TENANCY_MODE` has one reader, the resolver service.
 *  —   One org choice: only the resolver and the invite-accept invariants read memberships, and
 *      nothing reaches for the retired single-row `resolveOrgForPayer`.
 *
 * Scope of T5, stated so nobody over-reads it: a callable is listed when (a) one of its
 * parameters — or a property of a parameter typed inline (also as an array element) or by an
 * interface in the same file — is named `payerId` / `*PayerId` / `agencyId` and typed `string`,
 * and (b) its OWN body names a tenant table:
 * a Drizzle table imported from `@badabhai/db`, or the table in a `sql` template's FROM / JOIN /
 * INTO / UPDATE. A method that only delegates to a listed helper is not listed; retyping the
 * helper forces its callers through the type system. Parsed with the TypeScript compiler
 * (syntax only), never regex over source.
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
/** `payerId`, `inviterPayerId`, `agencyPayerId`, … and the payout module's `agencyId`. */
const PAYER_ID_NAME = /^(?:[a-z][A-Za-z]*PayerId|payerId|agencyId)$/;

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

/**
 * NOT YET CONVERTED. Phase 2 removes entries as it retypes them to `TenantKey`. Must be EMPTY
 * before the flip (P3). Grouped by the Phase 2 PR that owns them (ORG_TENANCY_PLAN §3).
 */
const UNCONVERTED: readonly string[] = [
  // P2a — postings, applicants, Candidates inbox
  "job-postings/job-postings.repository.ts JobPostingsRepository.closeOwned",
  "job-postings/job-postings.repository.ts JobPostingsRepository.findByIdAndPayer",
  "job-postings/job-postings.repository.ts JobPostingsRepository.listByPayer",
  "job-postings/job-postings.repository.ts JobPostingsRepository.transitionOwned",
  "job-postings/job-postings.repository.ts JobPostingsRepository.updateOwned",
  "match/match-feed.repository.ts MatchFeedRepository.listRankedCandidatesByApplication",
  "payer-portal/payer-applicant-inbox.repository.ts inboxPageStatement",
  "payers/owned-job-ref.ts findOwnedJobRef",
  "reach/reach.repository.ts ReachRepository.findOwnedJobSignalRowById",
  "reach/reach.repository.ts ReachRepository.findOwnedJobSignalRowsByIds",
  // P2b — unlocks, credits, ledger, payment orders, resume disclosures
  "disclosures/resume-disclosure.repository.ts ResumeDisclosureRepository.countDisclosedForPosting",
  "disclosures/resume-disclosure.repository.ts ResumeDisclosureRepository.findByPayerWorkerPosting",
  "disclosures/resume-disclosure.repository.ts ResumeDisclosureRepository.insertRow",
  "disclosures/resume-disclosure.repository.ts ResumeDisclosureRepository.listByPayer",
  "unlocks/unlocks.repository.ts UnlocksRepository.appendLedger",
  "unlocks/unlocks.repository.ts UnlocksRepository.createPaymentOrder",
  "unlocks/unlocks.repository.ts UnlocksRepository.creditPackWithinTx",
  "unlocks/unlocks.repository.ts UnlocksRepository.findByPayerWorker",
  "unlocks/unlocks.repository.ts UnlocksRepository.findCreditsForUpdate",
  "unlocks/unlocks.repository.ts UnlocksRepository.getBalance",
  "unlocks/unlocks.repository.ts UnlocksRepository.listByPayer",
  "unlocks/unlocks.repository.ts UnlocksRepository.listByPayerWithStatus",
  "unlocks/unlocks.repository.ts UnlocksRepository.listCreditLedgerByPayer",
  "unlocks/unlocks.repository.ts UnlocksRepository.recordDeny",
  "unlocks/unlocks.repository.ts UnlocksRepository.tryDebit",
  "unlocks/unlocks.repository.ts UnlocksRepository.upsertGrant",
  // P2c — plans, boosts, quota top-up, capacity
  "posting-plans/posting-plans.repository.ts PostingPlansRepository.addQuotaTopup",
  "posting-plans/posting-plans.repository.ts PostingPlansRepository.countActivePlansForPayer",
  "posting-plans/posting-plans.repository.ts PostingPlansRepository.findActivePlanForPostingAndPayer",
  "posting-plans/posting-plans.repository.ts PostingPlansRepository.getCapacity",
  "posting-plans/posting-plans.repository.ts PostingPlansRepository.listPausedPlansForPayer",
  "posting-plans/posting-plans.repository.ts PostingPlansRepository.upsertCapacity",
  // P2d — agency jobs, invites, workers, KYC, payouts
  "agency/agency-invites.repository.ts AgencyInvitesRepository.create",
  "agency/agency-invites.repository.ts AgencyInvitesRepository.stageCountsForOwner",
  "agency/agency-jobs.repository.ts AgencyJobsRepository.closeOwnedIfLive",
  "agency/agency-jobs.repository.ts AgencyJobsRepository.create",
  "agency/agency-jobs.repository.ts AgencyJobsRepository.findOwnedById",
  "agency/agency-jobs.repository.ts AgencyJobsRepository.listOwned",
  "agency/agency-jobs.repository.ts AgencyJobsRepository.pauseOwnedIfOpen",
  "agency/agency-jobs.repository.ts AgencyJobsRepository.resumeOwnedIfPaused",
  "agency/agency-jobs.repository.ts AgencyJobsRepository.updateOwned",
  "agency/agency-kyc.repository.ts AgencyKycRepository.findByPayer",
  "agency/agency-kyc.repository.ts AgencyKycRepository.upsertPending",
  "agency/agency-payout.repository.ts AgencyPayoutRepository.aggregate",
  "agency/agency-payout.repository.ts AgencyPayoutRepository.createRequestClaiming",
  "agency/agency-payout.repository.ts AgencyPayoutRepository.findQualifyingUnlocks",
  "agency/agency-payout.repository.ts AgencyPayoutRepository.insertAccruals",
  "agency/agency-payout.repository.ts AgencyPayoutRepository.listRequests",
  "agency/agency-workers.repository.ts AgencyWorkersRepository.listReferredWithConsent",
];

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

/** Same-file interfaces / type literals that carry a raw payer id property. */
function localRawIdTypes(sf: ts.SourceFile): Set<string> {
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

/** A parameter type that carries a raw payer id: inline, `T[]` / `Array<T>`, or a local type. */
function typeCarriesRawPayerId(type: ts.TypeNode | undefined, localTypes: Set<string>): boolean {
  if (!type) return false;
  if (ts.isTypeLiteralNode(type)) return membersHaveRawPayerId(type.members);
  if (ts.isArrayTypeNode(type)) return typeCarriesRawPayerId(type.elementType, localTypes);
  if (ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName)) {
    if (type.typeName.text === "Array" || type.typeName.text === "ReadonlyArray") {
      return typeCarriesRawPayerId(type.typeArguments?.[0], localTypes);
    }
    return localTypes.has(type.typeName.text);
  }
  return false;
}

function hasRawPayerIdParam(
  params: ts.NodeArray<ts.ParameterDeclaration>,
  localTypes: Set<string>,
): boolean {
  return params.some(
    (p) =>
      (ts.isIdentifier(p.name) && PAYER_ID_NAME.test(p.name.text) && isStringish(p.type)) ||
      typeCarriesRawPayerId(p.type, localTypes),
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
    if (ts.isTaggedTemplateExpression(node) && /sql$/.test(node.tag.getText(sf))) {
      if (SQL_TABLE.test(node.template.getText(sf))) found = true;
    }
    node.forEachChild(visit);
  };
  visit(body);
  return found;
}

/** `<path> <Class>.<method>` / `<path> <function>` for every raw-id tenant-table callable. */
function scanRawTenantKeyCallables(): string[] {
  const out: string[] = [];
  for (const file of tsFiles(SRC)) {
    const text = readFileSync(file, "utf8");
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const tables = importedTenantTables(sf);
    const localTypes = localRawIdTypes(sf);
    const visit = (node: ts.Node, owner: string | null): void => {
      if (ts.isClassDeclaration(node)) {
        node.forEachChild((c) => visit(c, node.name?.text ?? "<anonymous>"));
        return;
      }
      const callable =
        (ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) && node.body && node.name
          ? node
          : null;
      if (
        callable &&
        hasRawPayerIdParam(callable.parameters, localTypes) &&
        bodyTouchesTenantTable(callable.body!, sf, tables)
      ) {
        const name = callable.name!.getText(sf);
        out.push(`${rel(file)} ${owner ? `${owner}.${name}` : name}`);
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
    // One per detection path: a Drizzle table, a raw `sql` template, a same-file input type.
    expect(found).toContain("unlocks/unlocks.repository.ts UnlocksRepository.getBalance");
    expect(found).toContain("payer-portal/payer-applicant-inbox.repository.ts inboxPageStatement");
    expect(found).toContain("agency/agency-jobs.repository.ts AgencyJobsRepository.create");
  });

  it("the two lists are disjoint and free of duplicates (a reviewable allowlist)", () => {
    expect(NAMED_EXCEPTIONS.filter((e) => UNCONVERTED.includes(e))).toEqual([]);
    const all = [...NAMED_EXCEPTIONS, ...UNCONVERTED];
    expect(new Set(all).size).toBe(all.length);
  });

  it("every raw-id tenant-table callable is listed, and every listed one still exists", () => {
    const expected = [...NAMED_EXCEPTIONS, ...UNCONVERTED].sort();
    const unlisted = found.filter((f) => !expected.includes(f));
    const stale = expected.filter((e) => !found.includes(e));
    expect(
      { unlisted, stale },
      "A new raw payer id on a tenant table must take a TenantKey (ADR-0053 §5.2). A converted " +
        "callable must leave UNCONVERTED. Do not add to NAMED_EXCEPTIONS without an ADR ruling.",
    ).toEqual({ unlisted: [], stale: [] });
  });
});

/** Non-test source under apps/api/src, comments stripped (prose may name what code must not do). */
function codeOf(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("T8 — PAYER_ORG_TENANCY_MODE has ONE reader (ADR-0053 §5.3)", () => {
  it("only the resolver service reads the mode", () => {
    const readers = tsFiles(SRC)
      .filter((f) => codeOf(f).includes("PAYER_ORG_TENANCY_MODE"))
      .map(rel);
    expect(readers).toEqual(["payers/payer-tenant-scope.service.ts"]);
  });
});

describe("one org choice — every caller goes through the resolver (ADR-0053 §3.2)", () => {
  it("only the resolver and the invite-accept invariants read a payer's memberships", () => {
    const readers = tsFiles(SRC)
      .filter((f) => /\.listActiveMembershipsWithAnchor\(/.test(codeOf(f)))
      .map(rel)
      .sort();
    expect(readers).toEqual([
      "payer-portal/payer-org-members.service.ts",
      "payers/payer-tenant-scope.service.ts",
    ]);
  });

  it("nothing picks an org on its own: the retired single-row read is gone", () => {
    const offenders = tsFiles(SRC)
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
      expect(codeOf(join(SRC, file)), file).toMatch(/\.resolveActingOrg\(/);
    }
  });
});
