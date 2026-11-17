/**
 * #2754 items 4 to 14 — import companies from BadaBhai Campus.
 *
 *   pnpm --filter @badabhai/api build
 *   node apps/api/dist/payers/import-campus-companies.cli.js --bundle <folder> [--plan-quota <file>]
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
 * NOT YET BUILT in this part (each refuses with a message, never a partial run):
 *   --apply --batch <key> --run-by <label> [--test]   write a batch (#2754 items 6 to 10)
 *   --report --batch <key>                            the per-company verification report (item 11)
 *   --rollback --batch <key>                          reverse a batch (item 14)
 *
 * `--write-synthetic` writes a bundle of dummy companies in the same format, for the pilot of our
 * own dummy companies (ruling 17 Nov 2026) and for rehearsals. `--phones` is a JSON array of
 * 10-digit numbers for the owners, so a pilot can receive real SMS codes on our own team's phones.
 *
 * `--plan-quota` is a JSON object of Campus plan code to CV-view quota, used only for
 * `paid_plan_never_posted` lines; a plan code missing from it is an exception, never a guess.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { readCampusBundle } from "./campus-import/read-bundle";
import { buildImportPlan, type ImportPlan } from "./campus-import/plan";
import { writeSyntheticBundle } from "./campus-import/synthetic-bundle";

export const IMPORT_CAMPUS_COMPANIES_SCRIPT = "import-campus-companies";

export type ImportCampusCompaniesArgs =
  | { mode: "plan"; bundle: string; planQuota: Record<string, number> }
  | { mode: "synthetic"; out: string; companies: number; seed: string; phones: string[] };

const NOT_YET = ["apply", "report", "rollback"] as const;

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
      "write-synthetic": { type: "string" },
      companies: { type: "string" },
      seed: { type: "string" },
      phones: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  for (const flag of NOT_YET) {
    if (values[flag]) {
      throw new Error(`--${flag} is not built yet (#2754, a later part); only the dry run is available`);
    }
  }
  if (values["write-synthetic"] !== undefined) {
    if (values.bundle !== undefined) throw new Error("--write-synthetic and --bundle cannot be combined");
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
  return { mode: "plan", bundle: values.bundle, planQuota };
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

export function run(argv: readonly string[], log: (line: string) => void = console.log): number {
  const args = parseImportCampusCompaniesArgs(argv);
  if (args.mode === "synthetic") {
    writeSyntheticBundle(args.out, {
      companies: args.companies,
      seed: args.seed,
      phones: args.phones,
    });
    log(`[${IMPORT_CAMPUS_COMPANIES_SCRIPT}] wrote a synthetic bundle of ${args.companies} dummy companies (seed ${args.seed})`);
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
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (err) {
    console.error(`[${IMPORT_CAMPUS_COMPANIES_SCRIPT}] FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
