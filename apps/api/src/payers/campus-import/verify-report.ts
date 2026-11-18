/**
 * #2754 item 11 — the verification report: for every company of one export bundle, what Campus
 * had and what BadaBhai now has, side by side, with a difference file.
 *
 * TWO SIDES.
 *   - CAMPUS: the bundle itself, read through the same pure rules the import used (`plan.ts`):
 *     does the company move, its live jobs, the applicants of each live job, the contacts it had
 *     opened, the credits its unused balance converts to.
 *   - BADABHAI: the import ledger (`company_import_rows`) and, for every row that names a target,
 *     the real BadaBhai row it names — the account and its status, the posting and its status, the
 *     application, the opened contact, the credit lot and its granted credits. A ledger row whose
 *     target is gone or changed is a difference; the ledger alone is never taken as proof.
 *
 * WHAT IS A DIFFERENCE. Every record Campus would move that BadaBhai does not have as moved is a
 * line of `differences.csv`, marked:
 *   - `explained`: the ledger says why, with a reason code (a held applicant with no BadaBhai
 *     account, a company whose phone two accounts share, a plan with no known quota). These are
 *     the placement team's work list, not a failure of the import.
 *   - `unexplained`: nothing on the ledger accounts for it (never imported, or its BadaBhai row is
 *     missing, closed, archived or holds different credits). Under the cut-over runbook any
 *     unexplained difference is a reason to stop and roll back, so the CLI exits 2 when there is one.
 *
 * READ ONLY. One `repeatable read`, `read only` transaction, so every number comes from one
 * snapshot and nothing can be written.
 *
 * NO PII. The files carry Campus source ids (opaque uuids), BadaBhai ids, counts, statuses and
 * reason codes. Never a name, phone, email or GSTIN.
 */
import { mkdirSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import {
  applications,
  companyImportRows,
  creditLots,
  jobPostings,
  payers,
  unlocks,
  type CompanyImportRowKind,
  type CompanyImportRowState,
  type Database,
} from "@badabhai/db";
import type { CampusBundle } from "./bundle.schema";
import { decideApplication, decideBalance, decideJob } from "./mapping";
import { buildImportPlan } from "./plan";
import { CAMPUS_SOURCE } from "./import-ledger.repository";

export interface LedgerFact {
  state: CompanyImportRowState;
  targetId: string | null;
  reason: string | null;
}

/** Everything the report reads from BadaBhai, keyed for lookup. */
export interface BadaBhaiFacts {
  /** `<kind>:<source id>` → the ledger row of that source record. */
  ledger: ReadonlyMap<string, LedgerFact>;
  payerStatus: ReadonlyMap<string, string>;
  postingStatus: ReadonlyMap<string, string>;
  /** application id → its action and posting. */
  application: ReadonlyMap<string, { action: string; jobPostingId: string | null }>;
  unlockStatus: ReadonlyMap<string, string>;
  lotCredits: ReadonlyMap<string, number>;
}

export type DifferenceScope = "company" | "job" | "application" | "access" | "balance";

export interface Difference {
  companySourceId: string;
  scope: DifferenceScope;
  sourceId: string;
  explained: boolean;
  /** A reason code from the ledger, or the report's own code for an unexplained one. */
  code: string;
  campus: string;
  badabhai: string;
}

export interface CompanyLine {
  companySourceId: string;
  campusMoves: boolean;
  /** created, matched, exception:<reason>, skipped:<reason> or not_imported. */
  ledger: string;
  payerId: string | null;
  payerStatus: string | null;
  campusLiveJobs: number;
  badabhaiOpenPostings: number;
  campusApplicants: number;
  badabhaiApplicantsMoved: number;
  badabhaiApplicantsHeld: number;
  campusOpenedContacts: number;
  badabhaiOpenedContacts: number;
  campusCredits: number;
  badabhaiCredits: number;
  differences: number;
  unexplained: number;
}

export interface JobLine {
  companySourceId: string;
  jobSourceId: string;
  postingId: string | null;
  postingStatus: string | null;
  campusApplicants: number;
  moved: number;
  held: number;
  other: number;
}

export interface VerificationReport {
  companies: CompanyLine[];
  jobs: JobLine[];
  differences: Difference[];
  totals: {
    companies: number;
    companiesOnBadaBhai: number;
    campusLiveJobs: number;
    badabhaiOpenPostings: number;
    campusApplicants: number;
    badabhaiApplicantsMoved: number;
    badabhaiApplicantsHeld: number;
    campusCredits: number;
    badabhaiCredits: number;
    explained: number;
    unexplained: number;
  };
}

const ledgerKey = (kind: CompanyImportRowKind, sourceId: string): string => `${kind}:${sourceId}`;
const MOVED: ReadonlySet<CompanyImportRowState> = new Set(["created", "matched"]);
const describe = (f: LedgerFact | undefined): string =>
  f === undefined ? "not_imported" : MOVED.has(f.state) ? f.state : `${f.state}:${f.reason ?? "none"}`;

/**
 * Compare the two sides. PURE: the bundle, the plan quota and the facts read from BadaBhai in,
 * the report out. Every rule of "what is a difference" is a unit test of this function.
 */
export function compareSides(
  bundle: CampusBundle,
  planQuota: Readonly<Record<string, number>>,
  facts: BadaBhaiFacts,
): VerificationReport {
  const plan = buildImportPlan(bundle, planQuota);
  const differences: Difference[] = [];
  const jobs: JobLine[] = [];
  const lines = new Map<string, CompanyLine>();

  // Companies.
  for (const cp of plan.perCompany) {
    const fact = facts.ledger.get(ledgerKey("company", cp.sourceId));
    const moved = fact !== undefined && MOVED.has(fact.state);
    const payerStatus = moved ? (facts.payerStatus.get(fact.targetId!) ?? null) : null;
    lines.set(cp.sourceId, {
      companySourceId: cp.sourceId,
      campusMoves: cp.decision.move,
      ledger: describe(fact),
      payerId: moved ? fact.targetId : null,
      payerStatus,
      campusLiveJobs: cp.jobs.move,
      badabhaiOpenPostings: 0,
      campusApplicants: cp.applications.move,
      badabhaiApplicantsMoved: 0,
      badabhaiApplicantsHeld: 0,
      campusOpenedContacts: cp.carriedAccess,
      badabhaiOpenedContacts: 0,
      campusCredits: cp.balances.credits,
      badabhaiCredits: 0,
      differences: 0,
      unexplained: 0,
    });
    const diff = (explained: boolean, code: string, badabhai: string) =>
      differences.push({
        companySourceId: cp.sourceId,
        scope: "company",
        sourceId: cp.sourceId,
        explained,
        code,
        campus: cp.decision.move ? "moves" : `not_moved:${cp.decision.reason}`,
        badabhai,
      });
    if (!cp.decision.move) {
      // Campus's own rules keep it back (no phone and no e-mail): a person decides.
      diff(true, cp.decision.reason, describe(fact));
    } else if (fact === undefined) {
      diff(false, "company_not_imported", "not_imported");
    } else if (!moved) {
      diff(true, fact.reason ?? fact.state, describe(fact));
    } else if (payerStatus === null) {
      diff(false, "account_missing", `payer:${fact.targetId}`);
    } else if (payerStatus === "archived" || payerStatus === "suspended") {
      diff(false, `account_${payerStatus}`, `payer:${fact.targetId}`);
    }
  }

  // Jobs, and each live job's applicants. A job is live on Campus's side by the plan's own rule:
  // its company moves and `decideJob` moves it.
  const appsByJob = new Map<string, CampusBundle["applications"][number][]>();
  for (const app of bundle.applications) {
    const list = appsByJob.get(app.job_source_id);
    if (list) list.push(app);
    else appsByJob.set(app.job_source_id, [app]);
  }
  for (const job of bundle.jobs) {
    const line = lines.get(job.company_source_id);
    if (!line?.campusMoves || !decideJob(job).move) continue;
    const appsOfJob = appsByJob.get(job.source_id) ?? [];
    const jobFact = facts.ledger.get(ledgerKey("job", job.source_id));
    const jobMoved = jobFact !== undefined && MOVED.has(jobFact.state);
    const postingStatus = jobMoved ? (facts.postingStatus.get(jobFact.targetId!) ?? null) : null;
    const jobLine: JobLine = {
      companySourceId: job.company_source_id,
      jobSourceId: job.source_id,
      postingId: jobMoved ? jobFact.targetId : null,
      postingStatus,
      campusApplicants: 0,
      moved: 0,
      held: 0,
      other: 0,
    };
    jobs.push(jobLine);
    const jobDiff = (explained: boolean, code: string, badabhai: string) =>
      differences.push({
        companySourceId: job.company_source_id,
        scope: "job",
        sourceId: job.source_id,
        explained,
        code,
        campus: "live",
        badabhai,
      });
    if (jobFact === undefined) jobDiff(false, "job_not_imported", "not_imported");
    else if (!jobMoved) jobDiff(true, jobFact.reason ?? jobFact.state, describe(jobFact));
    else if (postingStatus === null) jobDiff(false, "posting_missing", `posting:${jobFact.targetId}`);
    else if (postingStatus !== "open") jobDiff(false, `posting_${postingStatus}`, `posting:${jobFact.targetId}`);
    else line.badabhaiOpenPostings += 1;

    for (const app of appsOfJob) {
      if (!decideApplication(app).move) continue;
      jobLine.campusApplicants += 1;
      const appFact = facts.ledger.get(ledgerKey("application", app.source_id));
      const appDiff = (explained: boolean, code: string, badabhai: string) =>
        differences.push({
          companySourceId: app.company_source_id,
          scope: "application",
          sourceId: app.source_id,
          explained,
          code,
          campus: `applied:${app.status}`,
          badabhai,
        });
      if (appFact === undefined) {
        jobLine.other += 1;
        appDiff(!jobMoved, jobMoved ? "application_not_imported" : "job_not_moved", "not_imported");
        continue;
      }
      if (appFact.state === "held") {
        jobLine.held += 1;
        line.badabhaiApplicantsHeld += 1;
        appDiff(true, appFact.reason ?? "held", describe(appFact));
        continue;
      }
      if (!MOVED.has(appFact.state)) {
        jobLine.other += 1;
        appDiff(true, appFact.reason ?? appFact.state, describe(appFact));
        continue;
      }
      const row = facts.application.get(appFact.targetId!);
      if (row === undefined || row.action !== "applied" || row.jobPostingId !== jobLine.postingId) {
        jobLine.other += 1;
        appDiff(false, row === undefined ? "application_missing" : "application_changed", `application:${appFact.targetId}`);
        continue;
      }
      jobLine.moved += 1;
      line.badabhaiApplicantsMoved += 1;

      // Item 9: a contact the company had opened on Campus is opened on BadaBhai.
      if (app.company_unlocked_at !== null) {
        const access = facts.ledger.get(ledgerKey("access", app.source_id));
        const status = access && MOVED.has(access.state) ? facts.unlockStatus.get(access.targetId!) : undefined;
        if (status === "granted") {
          line.badabhaiOpenedContacts += 1;
        } else {
          differences.push({
            companySourceId: app.company_source_id,
            scope: "access",
            sourceId: app.source_id,
            explained: false,
            code: access === undefined ? "access_not_imported" : status === undefined ? "access_missing" : `access_${status}`,
            campus: "opened",
            badabhai: access?.targetId ? `unlock:${access.targetId}` : "not_imported",
          });
        }
      }
    }
  }
  // Balances: each line Campus would convert, against its lot.
  for (const lineRec of bundle.unusedPlans) {
    const companyId = lineRec.company_source_id;
    if (!companyId) continue;
    const line = lines.get(companyId);
    if (!line?.campusMoves) continue;
    const decision = decideBalance(lineRec, planQuota);
    if (!decision.convert) continue;
    const fact = facts.ledger.get(ledgerKey("balance", lineRec.key));
    const granted = fact && MOVED.has(fact.state) ? facts.lotCredits.get(fact.targetId!) : undefined;
    const balDiff = (explained: boolean, code: string, badabhai: string) =>
      differences.push({
        companySourceId: companyId,
        scope: "balance",
        sourceId: lineRec.key,
        explained,
        code,
        campus: `credits:${decision.credits}`,
        badabhai,
      });
    if (fact === undefined) balDiff(false, "balance_not_imported", "not_imported");
    else if (!MOVED.has(fact.state)) balDiff(true, fact.reason ?? fact.state, describe(fact));
    else if (granted === undefined) balDiff(false, "lot_missing", `lot:${fact.targetId}`);
    else {
      line.badabhaiCredits += granted;
      if (granted !== decision.credits) balDiff(false, "lot_credits_differ", `credits:${granted}`);
    }
  }

  for (const d of differences) {
    const line = lines.get(d.companySourceId);
    if (!line) continue;
    line.differences += 1;
    if (!d.explained) line.unexplained += 1;
  }
  const companies = [...lines.values()];
  const sum = (pick: (l: CompanyLine) => number) => companies.reduce((n, l) => n + pick(l), 0);
  return {
    companies,
    jobs,
    differences,
    totals: {
      companies: companies.length,
      companiesOnBadaBhai: companies.filter((l) => l.payerId !== null && l.payerStatus !== null).length,
      campusLiveJobs: sum((l) => l.campusLiveJobs),
      badabhaiOpenPostings: sum((l) => l.badabhaiOpenPostings),
      campusApplicants: sum((l) => l.campusApplicants),
      badabhaiApplicantsMoved: sum((l) => l.badabhaiApplicantsMoved),
      badabhaiApplicantsHeld: sum((l) => l.badabhaiApplicantsHeld),
      campusCredits: sum((l) => l.campusCredits),
      badabhaiCredits: sum((l) => l.badabhaiCredits),
      explained: differences.filter((d) => d.explained).length,
      unexplained: differences.filter((d) => !d.explained).length,
    },
  };
}

/** Chunk an id list so one `IN` never grows past a few thousand parameters. */
function chunks<T>(items: readonly T[], size = 2000): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Read the BadaBhai side for one bundle, from ONE read-only snapshot: the ledger rows of every
 * record in the bundle (whichever batch owns them), then every BadaBhai row those rows name.
 */
export async function readBadaBhaiFacts(db: Database, bundle: CampusBundle): Promise<BadaBhaiFacts> {
  return db.transaction(
    async (raw) => {
      const tx = raw as unknown as Database;
      const wanted: [CompanyImportRowKind, string[]][] = [
        ["company", bundle.companies.map((c) => c.source_id)],
        ["job", bundle.jobs.map((j) => j.source_id)],
        ["application", bundle.applications.map((a) => a.source_id)],
        ["access", bundle.applications.map((a) => a.source_id)],
        ["balance", bundle.unusedPlans.map((l) => l.key)],
      ];
      const ledger = new Map<string, LedgerFact>();
      const targets: Record<CompanyImportRowKind, string[]> = {
        company: [],
        job: [],
        application: [],
        access: [],
        balance: [],
      };
      for (const [kind, ids] of wanted) {
        for (const part of chunks(ids)) {
          const rows = await tx
            .select({
              sourceId: companyImportRows.sourceId,
              state: companyImportRows.state,
              targetId: companyImportRows.targetId,
              reason: companyImportRows.reason,
            })
            .from(companyImportRows)
            .where(
              and(
                eq(companyImportRows.sourceSystem, CAMPUS_SOURCE),
                eq(companyImportRows.kind, kind),
                inArray(companyImportRows.sourceId, part),
              ),
            );
          for (const r of rows) {
            ledger.set(ledgerKey(kind, r.sourceId), { state: r.state, targetId: r.targetId, reason: r.reason });
            if (r.targetId && MOVED.has(r.state)) targets[kind].push(r.targetId);
          }
        }
      }

      const payerStatus = new Map<string, string>();
      for (const part of chunks(targets.company)) {
        for (const r of await tx.select({ id: payers.id, status: payers.status }).from(payers).where(inArray(payers.id, part))) {
          payerStatus.set(r.id, r.status);
        }
      }
      const postingStatus = new Map<string, string>();
      for (const part of chunks(targets.job)) {
        for (const r of await tx
          .select({ id: jobPostings.id, status: jobPostings.status })
          .from(jobPostings)
          .where(inArray(jobPostings.id, part))) {
          postingStatus.set(r.id, r.status);
        }
      }
      const application = new Map<string, { action: string; jobPostingId: string | null }>();
      for (const part of chunks(targets.application)) {
        for (const r of await tx
          .select({ id: applications.id, action: applications.action, jobPostingId: applications.jobPostingId })
          .from(applications)
          .where(inArray(applications.id, part))) {
          application.set(r.id, { action: r.action, jobPostingId: r.jobPostingId });
        }
      }
      const unlockStatus = new Map<string, string>();
      for (const part of chunks(targets.access)) {
        for (const r of await tx.select({ id: unlocks.id, status: unlocks.status }).from(unlocks).where(inArray(unlocks.id, part))) {
          unlockStatus.set(r.id, r.status);
        }
      }
      const lotCredits = new Map<string, number>();
      for (const part of chunks(targets.balance)) {
        for (const r of await tx
          .select({ id: creditLots.id, credits: creditLots.creditsGranted })
          .from(creditLots)
          .where(inArray(creditLots.id, part))) {
          lotCredits.set(r.id, r.credits);
        }
      }
      return { ledger, payerStatus, postingStatus, application, unlockStatus, lotCredits };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

const csvCell = (v: string | number | boolean | null): string => {
  const s = v === null ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = (header: readonly string[], rows: readonly (readonly (string | number | boolean | null)[])[]): string =>
  [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\n") + "\n";

export const REPORT_FILES = ["companies.csv", "jobs.csv", "differences.csv"] as const;

/**
 * Write the report into `dir`: created if missing, refused if it already holds anything, so a
 * report is never mixed with an older one.
 */
export function writeReportFiles(dir: string, report: VerificationReport): void {
  if (existsSync(dir) && readdirSync(dir).length > 0) {
    throw new Error(`the report folder ${dir} is not empty; give a new --out folder`);
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "companies.csv"),
    csv(
      [
        "company_source_id",
        "campus_moves",
        "ledger",
        "payer_id",
        "payer_status",
        "campus_live_jobs",
        "badabhai_open_postings",
        "campus_applicants",
        "badabhai_applicants_moved",
        "badabhai_applicants_held",
        "campus_opened_contacts",
        "badabhai_opened_contacts",
        "campus_credits",
        "badabhai_credits",
        "differences",
        "unexplained",
      ],
      report.companies.map((l) => [
        l.companySourceId,
        l.campusMoves,
        l.ledger,
        l.payerId,
        l.payerStatus,
        l.campusLiveJobs,
        l.badabhaiOpenPostings,
        l.campusApplicants,
        l.badabhaiApplicantsMoved,
        l.badabhaiApplicantsHeld,
        l.campusOpenedContacts,
        l.badabhaiOpenedContacts,
        l.campusCredits,
        l.badabhaiCredits,
        l.differences,
        l.unexplained,
      ]),
    ),
    { flag: "wx" },
  );
  writeFileSync(
    join(dir, "jobs.csv"),
    csv(
      ["company_source_id", "job_source_id", "posting_id", "posting_status", "campus_applicants", "moved", "held", "other"],
      report.jobs.map((j) => [
        j.companySourceId,
        j.jobSourceId,
        j.postingId,
        j.postingStatus,
        j.campusApplicants,
        j.moved,
        j.held,
        j.other,
      ]),
    ),
    { flag: "wx" },
  );
  writeFileSync(
    join(dir, "differences.csv"),
    csv(
      ["company_source_id", "scope", "source_id", "explained", "code", "campus", "badabhai"],
      report.differences.map((d) => [d.companySourceId, d.scope, d.sourceId, d.explained, d.code, d.campus, d.badabhai]),
    ),
    { flag: "wx" },
  );
}
