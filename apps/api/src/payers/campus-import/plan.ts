/**
 * #2754 — the dry-run plan: what an import of one bundle would do, before it touches a database.
 *
 * Applies the pure rules of `mapping.ts` to every record and tallies the outcomes. The result is
 * COUNTS AND REASON CODES ONLY, per company keyed by its Campus source id (an opaque uuid): it is
 * printed to a terminal and must never carry a name, phone, email or GSTIN.
 *
 * Whether a company MATCHES an existing BadaBhai account (phone, then email, then GSTIN) needs the
 * database, so the plan counts companies as "to place" and the apply step decides created vs
 * matched.
 */
import type { CampusBundle } from "./bundle.schema";
import {
  decideApplication,
  decideBalance,
  decideCompany,
  decideJob,
  type CompanyDecision,
} from "./mapping";

export interface CompanyPlan {
  sourceId: string;
  decision: CompanyDecision;
  jobs: { move: number; skipped: Record<string, number> };
  applications: { move: number; heldOnCampus: number; skipped: Record<string, number> };
  /** Applications the company had already opened on Campus: carried over as opened (item 9). */
  carriedAccess: number;
  balances: { credits: number; lines: number; skipped: Record<string, number> };
}

export interface ImportPlan {
  companies: { total: number; toPlace: number; exceptions: Record<string, number> };
  phones: { proven: number; unproven: number; none: Record<string, number> };
  verification: { verified: number; pending: number };
  jobs: { total: number; move: number; skipped: Record<string, number> };
  applications: {
    total: number;
    move: number;
    rvmStudents: number;
    external: number;
    heldOnCampus: number;
    skipped: Record<string, number>;
  };
  carriedAccess: number;
  balances: { lines: number; convert: number; credits: number; skipped: Record<string, number> };
  problems: Record<string, number>;
  perCompany: CompanyPlan[];
}

const bump = (tally: Record<string, number>, key: string, by = 1): void => {
  tally[key] = (tally[key] ?? 0) + by;
};

export function buildImportPlan(
  bundle: CampusBundle,
  planQuota: Readonly<Record<string, number>> = {},
): ImportPlan {
  const plan: ImportPlan = {
    companies: { total: bundle.companies.length, toPlace: 0, exceptions: {} },
    phones: { proven: 0, unproven: 0, none: {} },
    verification: { verified: 0, pending: 0 },
    jobs: { total: bundle.jobs.length, move: 0, skipped: {} },
    applications: {
      total: bundle.applications.length,
      move: 0,
      rvmStudents: 0,
      external: 0,
      heldOnCampus: 0,
      skipped: {},
    },
    carriedAccess: 0,
    balances: { lines: bundle.unusedPlans.length, convert: 0, credits: 0, skipped: {} },
    problems: {},
    perCompany: [],
  };

  const byCompany = new Map<string, CompanyPlan>();
  for (const company of bundle.companies) {
    const decision = decideCompany(company, bundle.logins);
    const cp: CompanyPlan = {
      sourceId: company.source_id,
      decision,
      jobs: { move: 0, skipped: {} },
      applications: { move: 0, heldOnCampus: company.counts.applications_held, skipped: {} },
      carriedAccess: 0,
      balances: { credits: 0, lines: 0, skipped: {} },
    };
    byCompany.set(company.source_id, cp);
    plan.perCompany.push(cp);
    plan.applications.heldOnCampus += company.counts.applications_held;
    if (!decision.move) {
      bump(plan.companies.exceptions, decision.reason);
      continue;
    }
    plan.companies.toPlace += 1;
    plan.verification[decision.verification] += 1;
    if (decision.phone === null) bump(plan.phones.none, decision.noPhoneReason ?? "unknown");
    else if (decision.phoneProven) plan.phones.proven += 1;
    else plan.phones.unproven += 1;
  }

  // A job or application of a company that does not move does not move either.
  const movingJobs = new Set<string>();
  for (const job of bundle.jobs) {
    const cp = byCompany.get(job.company_source_id)!;
    const reason = !cp.decision.move ? "company_not_placed" : undefined;
    const decision = reason ? { move: false as const, reason } : decideJob(job);
    if (decision.move) {
      movingJobs.add(job.source_id);
      cp.jobs.move += 1;
      plan.jobs.move += 1;
    } else {
      bump(cp.jobs.skipped, decision.reason);
      bump(plan.jobs.skipped, decision.reason);
    }
  }

  for (const application of bundle.applications) {
    const cp = byCompany.get(application.company_source_id)!;
    const decision = !movingJobs.has(application.job_source_id)
      ? { move: false as const, reason: "job_not_moved" }
      : decideApplication(application);
    if (!decision.move) {
      bump(cp.applications.skipped, decision.reason);
      bump(plan.applications.skipped, decision.reason);
      continue;
    }
    cp.applications.move += 1;
    plan.applications.move += 1;
    if (decision.candidate === "rvm_student") plan.applications.rvmStudents += 1;
    else plan.applications.external += 1;
    if (application.company_unlocked_at !== null) {
      cp.carriedAccess += 1;
      plan.carriedAccess += 1;
    }
  }

  for (const line of bundle.unusedPlans) {
    const cp = line.company_source_id ? byCompany.get(line.company_source_id) : undefined;
    const decision =
      cp && !cp.decision.move
        ? { convert: false as const, reason: "company_not_placed" }
        : decideBalance(line, planQuota);
    if (cp) cp.balances.lines += 1;
    if (decision.convert) {
      plan.balances.convert += 1;
      plan.balances.credits += decision.credits;
      if (cp) cp.balances.credits += decision.credits;
    } else {
      bump(plan.balances.skipped, decision.reason);
      if (cp) bump(cp.balances.skipped, decision.reason);
    }
  }

  for (const problem of bundle.problems) bump(plan.problems, problem.kind);
  return plan;
}
