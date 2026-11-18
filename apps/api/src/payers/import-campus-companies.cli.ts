/**
 * #2754 items 4 to 14 — import companies from BadaBhai Campus.
 *
 *   pnpm --filter @badabhai/api build
 *   node apps/api/dist/payers/import-campus-companies.cli.js --bundle <folder> [--plan-quota <file>]
 *   node apps/api/dist/payers/import-campus-companies.cli.js --bundle <folder> --apply \
 *        --batch <key> --run-by <label> [--test | --rehearsal] [--agents <file>]
 *   node apps/api/dist/payers/import-campus-companies.cli.js --write-synthetic <empty folder> \
 *        --companies 3 --seed pilot-1 [--phones <file>]
 *
 * INPUT is the export bundle of RVMBeyond_jobportal#156 (`docs/api/company-export-bundle.md`),
 * NEVER the Campus database. The bundle is checked end to end before anything else happens: the
 * manifest's format and version, each file's sha256 and record count, every record's shape, and
 * every cross-file reference (`read-bundle.ts`).
 *
 * DRY RUN BY DEFAULT: it prints what an import would do, as counts and reason codes per company
 * keyed by the Campus source id. It never prints a name, phone, email or GSTIN.
 *
 * APPLY (#2754 items 6 and 9 so far: company accounts, then balances). Opens (or resumes) the
 * named batch and places
 * every company on a BadaBhai account, one transaction per company, matching an existing account
 * by phone, then e-mail, then GSTIN before creating one. A second run of the same batch over the
 * same bundle adds nothing. `--test` marks every placed company a test account with reason
 * `pilot_test` (our own dummy companies, ruling 17 Nov 2026), `--rehearsal` with reason
 * `rehearsal`. `--agents` is a JSON array of Campus company source ids the placement team named
 * as agencies or contractors (created as `agent`). It refuses until migration `company_import` is
 * applied. Then each company's unused Campus balance becomes ONE `migrated` credit lot per bundle
 * line (`campus_conversion:<line key>`, once ever), valid `--credit-validity-days` (default and
 * floor 30; bundle v1 carries no plan expiry). Then each live Campus job becomes a posting through
 * Campus's own creator (`createForCampus`, origin `campus_imported`), held from BadaBhai workers
 * until an admin opens it (#2891), with the RVM approval recorded.
 *
 * THE JOBS STEP RUNS ONLY WITH `--worker-hold-live`, AND ONLY WHEN #2891's TABLE EXISTS. The table
 * exists from the moment its migration is applied, which is BEFORE the API that honours the hold
 * (#2903) is deployed; in that window a `both` posting would reach every matching BadaBhai worker
 * through the deployed API even though its `off` row is written. So the operator passes
 * `--worker-hold-live` only after checking that the production build contains #2903: read the
 * build sha from the production /health and run
 * `git merge-base --is-ancestor fdabdc17b4167deaaf26f3c297fb1ffba797ec78 <build sha>` (#2903). Without the flag the jobs step
 * prints that it is waiting and imports no job. A created posting that is not held is closed and
 * the step stops.
 *
 * Then, only when the jobs step ran, each open application of a moved job moves onto its posting
 * with its stage (#2754 item 8): a moved or linked RVM student, or an outside candidate who already
 * has a consenting BadaBhai account on that phone; everyone else is held with no personal detail.
 * A contact the company had opened on Campus is carried over, opened for good and free (item 9).
 * The batch stays `applying` until the report and the rollback land.
 *
 * NOT YET BUILT (each refuses with a message, never a partial run):
 *   --report --batch <key>      the per-company verification report (item 11)
 *   --rollback --batch <key>    reverse a batch (item 14)
 *
 * TARGET SAFETY: `--apply` goes through the shared ops guard — a write to a production-like
 * database needs `--i-am-authorised-to-write-to-production` AND
 * `OPS_ALLOW_PRODUCTION=import-campus-companies`. Under D15 Prakash runs it in production.
 *
 * `--write-synthetic` writes a bundle of dummy companies in the same format, for the pilot of our
 * own dummy companies and for rehearsals. `--phones` is a JSON array of 10-digit numbers for the
 * owners, so a pilot can receive real SMS codes on our own team's phones.
 *
 * `--plan-quota` is a JSON object of Campus plan code to CV-view quota, used only for
 * `paid_plan_never_posted` lines; a plan code missing from it is an exception, never a guess.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { loadServerConfig, type ServerConfig } from "@badabhai/config";
import { PRODUCTION_WRITE_FLAG, createDbClient, enforceOpsGuard } from "@badabhai/db";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { NameTokenService } from "../admin/candidate-index/name-token.service";
import { EventsRepository } from "../events/events.repository";
import { EventsService } from "../events/events.service";
import { PayersRepository } from "./payers.repository";
import { PayerPhoneProofsRepository } from "./payer-phone-proofs.repository";
import { readCampusBundle } from "./campus-import/read-bundle";
import { buildImportPlan, type ImportPlan } from "./campus-import/plan";
import { writeSyntheticBundle } from "./campus-import/synthetic-bundle";
import { importCompanies, type CompanyImportSummary } from "./campus-import/import-companies";
import {
  importBalances,
  MIN_CONVERTED_VALIDITY_DAYS,
  type BalanceImportSummary,
} from "./campus-import/import-balances";
import {
  CampusImportRefusal,
  importLedgerExists,
  openBatch,
} from "./campus-import/import-ledger.repository";
import {
  importJobs,
  workerVisibilityTableExists,
  type JobImportSummary,
} from "./campus-import/import-jobs";
import { buildJobImportDeps } from "./campus-import/job-import-wiring";
import {
  importApplications,
  type ApplicationImportSummary,
} from "./campus-import/import-applications";

export const IMPORT_CAMPUS_COMPANIES_SCRIPT = "import-campus-companies";

export type ImportCampusCompaniesArgs =
  | { mode: "plan"; bundle: string; planQuota: Record<string, number> }
  | {
      mode: "apply";
      bundle: string;
      planQuota: Record<string, number>;
      batch: string;
      runBy: string;
      testReason: "pilot_test" | "rehearsal" | null;
      agents: string[];
      creditValidityDays: number;
      workerHoldLive: boolean;
    }
  | { mode: "synthetic"; out: string; companies: number; seed: string; phones: string[] };

const NOT_YET = ["report", "rollback"] as const;
const BATCH_KEY = /^[a-z0-9][a-z0-9-]{0,63}$/;

function readJson(path: string, what: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`${what}: cannot read ${path} as JSON`);
  }
}

/** Strict argv parsing: an unknown or malformed flag is an error, never a guess. */
export function parseImportCampusCompaniesArgs(argv: readonly string[]): ImportCampusCompaniesArgs {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      bundle: { type: "string" },
      "plan-quota": { type: "string" },
      apply: { type: "boolean", default: false },
      report: { type: "boolean", default: false },
      rollback: { type: "boolean", default: false },
      batch: { type: "string" },
      "run-by": { type: "string" },
      test: { type: "boolean", default: false },
      rehearsal: { type: "boolean", default: false },
      agents: { type: "string" },
      "credit-validity-days": { type: "string" },
      "worker-hold-live": { type: "boolean", default: false },
      "write-synthetic": { type: "string" },
      companies: { type: "string" },
      seed: { type: "string" },
      phones: { type: "string" },
      [PRODUCTION_WRITE_FLAG.replace(/^--/, "")]: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  for (const flag of NOT_YET) {
    if (values[flag]) {
      throw new Error(`--${flag} is not built yet (#2754, a later part)`);
    }
  }
  if (values["write-synthetic"] !== undefined) {
    if (values.bundle !== undefined) throw new Error("--write-synthetic and --bundle cannot be combined");
    if (values.apply) throw new Error("--write-synthetic and --apply cannot be combined");
    const companies = Number(values.companies ?? "3");
    if (!Number.isInteger(companies) || companies < 1 || companies > 20) {
      throw new Error("--companies must be an integer from 1 to 20");
    }
    if (!values.seed) throw new Error("--seed is required with --write-synthetic");
    let phones: string[] = [];
    if (values.phones !== undefined) {
      const raw = readJson(values.phones, "--phones");
      if (!Array.isArray(raw) || !raw.every((p) => typeof p === "string" && /^[6-9]\d{9}$/.test(p))) {
        throw new Error("--phones must be a JSON array of 10-digit Indian mobile numbers");
      }
      phones = raw as string[];
    }
    return { mode: "synthetic", out: values["write-synthetic"], companies, seed: values.seed, phones };
  }
  if (!values.bundle) throw new Error("--bundle <folder> is required");
  let planQuota: Record<string, number> = {};
  if (values["plan-quota"] !== undefined) {
    const raw = readJson(values["plan-quota"], "--plan-quota");
    if (
      raw === null ||
      typeof raw !== "object" ||
      Array.isArray(raw) ||
      !Object.values(raw).every((v) => Number.isInteger(v) && (v as number) >= 0)
    ) {
      throw new Error("--plan-quota must be a JSON object of plan code to a whole number of CV views");
    }
    planQuota = raw as Record<string, number>;
  }
  if (!values.apply) {
    for (const flag of ["batch", "run-by", "agents", "credit-validity-days"] as const) {
      if (values[flag] !== undefined) throw new Error(`--${flag} needs --apply`);
    }
    if (values.test || values.rehearsal) throw new Error("--test and --rehearsal need --apply");
    if (values["worker-hold-live"]) throw new Error("--worker-hold-live needs --apply");
    return { mode: "plan", bundle: values.bundle, planQuota };
  }
  if (!values.batch || !BATCH_KEY.test(values.batch)) {
    throw new Error("--apply needs --batch <key>: lower-case letters, digits and dashes, up to 64");
  }
  const runBy = values["run-by"]?.trim() ?? "";
  if (runBy.length < 1 || runBy.length > 128) {
    throw new Error("--apply needs --run-by <who is running it>");
  }
  if (values.test && values.rehearsal) throw new Error("--test and --rehearsal cannot be combined");
  let agents: string[] = [];
  if (values.agents !== undefined) {
    const raw = readJson(values.agents, "--agents");
    if (!Array.isArray(raw) || !raw.every((v) => typeof v === "string" && v.length > 0)) {
      throw new Error("--agents must be a JSON array of Campus company source ids");
    }
    agents = raw as string[];
  }
  const creditValidityDays = Number(values["credit-validity-days"] ?? String(MIN_CONVERTED_VALIDITY_DAYS));
  if (!Number.isInteger(creditValidityDays) || creditValidityDays < MIN_CONVERTED_VALIDITY_DAYS || creditValidityDays > 365) {
    throw new Error(`--credit-validity-days must be a whole number from ${MIN_CONVERTED_VALIDITY_DAYS} to 365`);
  }
  return {
    mode: "apply",
    bundle: values.bundle,
    planQuota,
    batch: values.batch,
    runBy,
    testReason: values.test ? "pilot_test" : values.rehearsal ? "rehearsal" : null,
    agents,
    creditValidityDays,
    workerHoldLive: values["worker-hold-live"] === true,
  };
}

const fmt = (tally: Record<string, number>): string => {
  const keys = Object.keys(tally).sort();
  return keys.length === 0 ? "none" : keys.map((k) => `${k}=${tally[k]}`).join(" ");
};

/** The dry-run printout: counts and reason codes only, and Campus source ids (opaque uuids). */
export function formatImportPlan(plan: ImportPlan): string[] {
  const lines = [
    `companies: total=${plan.companies.total} to_place=${plan.companies.toPlace} exceptions: ${fmt(plan.companies.exceptions)}`,
    `  verification: verified=${plan.verification.verified} pending=${plan.verification.pending}`,
    `  phones: proven=${plan.phones.proven} unproven=${plan.phones.unproven} none: ${fmt(plan.phones.none)}`,
    `jobs: total=${plan.jobs.total} move=${plan.jobs.move} skipped: ${fmt(plan.jobs.skipped)}`,
    `applications: total=${plan.applications.total} move=${plan.applications.move} ` +
      `(rvm_students=${plan.applications.rvmStudents} external=${plan.applications.external}) ` +
      `held_on_campus=${plan.applications.heldOnCampus} skipped: ${fmt(plan.applications.skipped)}`,
    `carried_access (already opened on Campus): ${plan.carriedAccess}`,
    `balances: lines=${plan.balances.lines} convert=${plan.balances.convert} credits=${plan.balances.credits} ` +
      `skipped: ${fmt(plan.balances.skipped)}`,
    `problems in the bundle: ${fmt(plan.problems)}`,
    "per company (Campus source id):",
  ];
  for (const c of plan.perCompany) {
    const head = c.decision.move
      ? `place ${c.decision.verification} phone=${c.decision.phone === null ? (c.decision.noPhoneReason ?? "none") : c.decision.phoneProven ? "proven" : "unproven"}`
      : `exception ${c.decision.reason}`;
    lines.push(
      `  ${c.sourceId}: ${head}; jobs move=${c.jobs.move}; applications move=${c.applications.move} ` +
        `held_on_campus=${c.applications.heldOnCampus}; carried_access=${c.carriedAccess}; credits=${c.balances.credits}`,
    );
  }
  return lines;
}

/** The `--apply` printout: counts and reason codes only. */
export function formatCompanySummary(s: CompanyImportSummary): string[] {
  return [
    `companies: created=${s.created} matched=${s.matched} already_done=${s.alreadyDone} exceptions: ${fmt(s.exceptions)}`,
    `  phone proof not recorded: ${fmt(s.proofNotRecorded)}`,
  ];
}

export function formatJobSummary(s: JobImportSummary): string[] {
  return [
    `jobs: created=${s.created} already_done=${s.alreadyDone} not moved: ${fmt(s.notMoved)}`,
    `  fields dropped by the company form: ${fmt(s.droppedFields)}; inactive branch ids dropped: ${s.droppedBranchIds}`,
  ];
}

export function formatApplicationSummary(s: ApplicationImportSummary): string[] {
  return [
    `applications: moved=${s.moved} (reused an existing apply=${s.reusedApplication}) already_done=${s.alreadyDone} ` +
      `held: ${fmt(s.held)} skipped: ${fmt(s.skipped)}`,
    `  stages: ${fmt(s.stages)}; contacts carried over as opened: ${s.carriedAccess}`,
  ];
}

export function formatBalanceSummary(s: BalanceImportSummary): string {
  return (
    `balances: converted=${s.converted} credits=${s.credits} already_done=${s.alreadyDone} ` +
    `not converted: ${fmt(s.notConverted)}`
  );
}

async function apply(
  args: Extract<ImportCampusCompaniesArgs, { mode: "apply" }>,
  log: (line: string) => void,
): Promise<number> {
  const bundle = readCampusBundle(args.bundle);
  const { connectionString } = enforceOpsGuard({
    script: IMPORT_CAMPUS_COMPANIES_SCRIPT,
    connectionString: process.env.DATABASE_URL,
    mutating: true,
  });
  const config: ServerConfig = loadServerConfig();
  const client = createDbClient(connectionString, { max: 2 });
  try {
    const db = client.db;
    if (!(await importLedgerExists(db))) {
      throw new CampusImportRefusal("migration company_import is not applied on this database");
    }
    const pii = new PiiCryptoService(config);
    const events = new EventsService(new EventsRepository(db), config);
    const batch = await openBatch(db, {
      batchKey: args.batch,
      bundleFormat: bundle.manifest.format,
      bundleVersion: bundle.manifest.version,
      bundleGeneratedAt: new Date(bundle.manifest.generated_at),
      manifestSha256: bundle.manifestSha256,
      isTest: args.testReason !== null,
      runBy: args.runBy,
      manifestCounts: bundle.manifest.counts,
    });
    log(
      `[${IMPORT_CAMPUS_COMPANIES_SCRIPT}] APPLY batch ${batch.batchKey} ` +
        `(${batch.resumed ? "resumed" : "new"}${batch.isTest ? ", test" : ""})`,
    );
    const summary = await importCompanies(
      {
        db,
        pii,
        payers: new PayersRepository(db, pii, new NameTokenService(config)),
        phoneProofs: new PayerPhoneProofsRepository(db),
        events,
      },
      batch,
      bundle,
      { agentSourceIds: new Set(args.agents), testReason: args.testReason },
    );
    for (const line of formatCompanySummary(summary)) log(line);
    const balances = await importBalances(db, batch, bundle, summary.placed, {
      planQuota: args.planQuota,
      validityDays: args.creditValidityDays,
    });
    log(formatBalanceSummary(balances));
    if (!args.workerHoldLive) {
      log(
        "jobs: NOT IMPORTED — pass --worker-hold-live only after the production build contains " +
          "#2903 (git merge-base --is-ancestor fdabdc17b4167deaaf26f3c297fb1ffba797ec78 <the /health build sha>). Before " +
          "then a moved job could reach BadaBhai workers.",
      );
    } else if (!(await workerVisibilityTableExists(db))) {
      log(
        "jobs: NOT IMPORTED — #2891's job_posting_worker_visibility table is missing on this " +
          "database; apply its migration first.",
      );
    } else {
      const jobs = await importJobs(buildJobImportDeps(db, config, events), batch, bundle, summary.placed, {
        requestId: `campus-import:${batch.batchKey}`,
        correlationId: batch.id,
      });
      for (const line of formatJobSummary(jobs)) log(line);
      const apps = await importApplications(db, pii, batch, bundle, summary.placed, jobs.placed);
      for (const line of formatApplicationSummary(apps)) log(line);
    }
    log("the batch stays open until the verification report and the rollback land (#2754 items 11, 14)");
    return 0;
  } finally {
    await client.sql.end({ timeout: 5 });
  }
}

export async function run(
  argv: readonly string[],
  log: (line: string) => void = console.log,
): Promise<number> {
  const args = parseImportCampusCompaniesArgs(argv);
  if (args.mode === "apply") return apply(args, log);
  if (args.mode === "synthetic") {
    writeSyntheticBundle(args.out, {
      companies: args.companies,
      seed: args.seed,
      phones: args.phones,
    });
    log(
      `[${IMPORT_CAMPUS_COMPANIES_SCRIPT}] wrote a synthetic bundle of ${args.companies} dummy ` +
        `companies (seed ${args.seed})`,
    );
    return 0;
  }
  const bundle = readCampusBundle(args.bundle);
  log(
    `[${IMPORT_CAMPUS_COMPANIES_SCRIPT}] DRY RUN — bundle v${bundle.manifest.version} generated ` +
      `${bundle.manifest.generated_at}, manifest sha256 ${bundle.manifestSha256.slice(0, 12)}…, checks passed`,
  );
  for (const line of formatImportPlan(buildImportPlan(bundle, args.planQuota))) log(line);
  return 0;
}

if (require.main === module) {
  run(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      console.error(
        `[${IMPORT_CAMPUS_COMPANIES_SCRIPT}] FAILED: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exitCode = 1;
    });
}
