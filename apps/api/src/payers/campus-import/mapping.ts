/**
 * #2754 — the rules that turn one Campus record into one BadaBhai decision. PURE: no database, no
 * clock, no I/O, so every rule of the issue and every ruling of 17 Nov 2026 is a unit test.
 *
 * A decision is either a move (with the mapped values) or a reason code saying why the record does
 * not move. Reason codes are short machine strings stored in `company_import_rows.reason`; they
 * never carry a value from the bundle.
 */
import type { ApplicantStage } from "@badabhai/types";
import type {
  CampusApplication,
  CampusCompany,
  CampusJob,
  CampusLogin,
  CampusUnusedPlan,
} from "./bundle.schema";

/** A Campus phone (10 digits, from 6 to 9) to E.164, or null when it is not an Indian mobile. */
export function campusPhoneToE164(value: string | null | undefined): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, "");
  const ten = digits.length === 12 && digits.startsWith("91") ? digits.slice(2) : digits;
  return /^[6-9]\d{9}$/.test(ten) ? `+91${ten}` : null;
}

function cleanEmail(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : null;
}

export type CompanyDecision =
  | {
      move: true;
      /** `approved` on Campus becomes `verified`; `pending` stays `pending` (#2754 Mapping). */
      verification: "verified" | "pending";
      /** The sign-in email for the account: the owner login's, else the company contact's. */
      email: string | null;
      /** The phone stored on the account (E.164), or null for an email-only account. */
      phone: string | null;
      /**
       * True when `phone` is Campus's proven owner phone (`app_users.phone`, Prakash 17 Nov): the
       * only phone the import records as proven (`recordImportedProof`, method `campus_import`).
       */
      phoneProven: boolean;
      /** Why the account has no phone, when it has none: the bundle's sign-in phone class. */
      noPhoneReason: string | null;
    }
  | { move: false; reason: string };

/**
 * One company. The phone rules, in order:
 *   1. Campus's proven owner phone → stored and recorded as proven.
 *   2. Otherwise a `good` sign-in phone → stored, NOT proven: the company confirms it on BadaBhai
 *      ("Confirm your number", #2879) before SMS sign-in sends it anything.
 *   3. Otherwise (shared, a candidate's number, not a mobile, missing) → no phone: e-mail sign-in
 *      stays and the placement team resolves it by hand (#2754 question 4).
 * A company with neither a phone nor an e-mail cannot sign in at all: an exception.
 */
export function decideCompany(company: CampusCompany, logins: readonly CampusLogin[]): CompanyDecision {
  const ownerEmail = logins.find(
    (l) => l.company_source_id === company.source_id && l.kind === "owner" && l.type === "email",
  );
  const email = cleanEmail(ownerEmail?.value) ?? cleanEmail(company.contact.email);

  const proven = campusPhoneToE164(company.proven_phone.value);
  const signIn =
    company.sign_in_phone.class === "good" ? campusPhoneToE164(company.sign_in_phone.value) : null;
  const phone = proven ?? signIn;

  if (phone === null && email === null) return { move: false, reason: "no_contact" };
  return {
    move: true,
    verification: company.approval_status === "approved" ? "verified" : "pending",
    email,
    phone,
    phoneProven: proven !== null,
    noPhoneReason: phone === null ? `sign_in_phone_${company.sign_in_phone.class}` : null,
  };
}

export type JobDecision = { move: true } | { move: false; reason: string };

/** Only active, unexpired jobs move (#2754 item 7). The rest are counted on the ledger. */
export function decideJob(job: CampusJob): JobDecision {
  if (job.status === "paused") return { move: false, reason: "job_paused" };
  if (job.status === "pending_approval") return { move: false, reason: "job_pending_approval" };
  if (job.past_expiry) return { move: false, reason: "job_past_expiry" };
  return { move: true };
}

/**
 * The audience every moved job gets: `both` — for RVM students, and for BadaBhai workers once an
 * admin turns the job's worker visibility on (ruling 17 Nov 2026, #2891). The posting is written
 * with that visibility OFF in the same transaction (`holdPostingFromWorkers`, #2891).
 */
export const IMPORTED_JOB_AUDIENCE = "both" as const;

/** Campus's application status to #2747's stage (#2754 Mapping). */
const STAGE_BY_CAMPUS_STATUS: Readonly<Record<string, ApplicantStage>> = {
  applied: "new",
  pending: "new",
  under_review: "new",
  shortlisted: "shortlist",
  interview_scheduled: "shortlist",
  on_hold: "shortlist",
  offered: "selected",
  selected: "selected",
  hired: "hired",
  rejected: "passed",
};

export type ApplicationDecision =
  | { move: true; stage: ApplicantStage; candidate: "rvm_student" | "external" }
  | { move: false; reason: string };

export function decideApplication(application: CampusApplication): ApplicationDecision {
  if (application.status === "withdrawn") return { move: false, reason: "application_withdrawn" };
  const stage = STAGE_BY_CAMPUS_STATUS[application.status];
  if (stage === undefined) return { move: false, reason: "application_status_unmapped" };
  if (application.candidate.kind === "external" && campusPhoneToE164(application.candidate.phone) === null) {
    // A BadaBhai applicant is a `workers` row, which needs a phone. No placeholder exists.
    return { move: false, reason: "applicant_no_phone" };
  }
  return { move: true, stage, candidate: application.candidate.kind };
}

export type BalanceDecision = { convert: true; credits: number } | { convert: false; reason: string };

/** Plan codes of Campus's free tier: its 5 CV views are not converted (welcome credits replace them). */
export const FREE_PLAN_CODES: ReadonlySet<string> = new Set(["free", "free_tier"]);

/**
 * One unused-plan line (#2754 Money defaults): unused CV views convert one for one.
 * - `cv_views_left_on_plan_jobs`, `cv_views_in_wallet`: `cv_views_left` credits.
 * - `paid_plan_never_posted`: the plan's full CV-view quota, from `planQuota`; a plan code with no
 *   known quota is an exception, never a guess.
 * - `payment_never_registered`: listed, not converted (#156 question 2's default).
 * - The free tier is never converted; a line with nothing left converts nothing.
 */
export function decideBalance(
  line: CampusUnusedPlan,
  planQuota: Readonly<Record<string, number>>,
): BalanceDecision {
  if (line.line === "payment_never_registered") {
    return { convert: false, reason: "payment_never_registered" };
  }
  if (line.plan_code && FREE_PLAN_CODES.has(line.plan_code)) {
    return { convert: false, reason: "free_tier_not_converted" };
  }
  if (line.line === "paid_plan_never_posted") {
    const quota = line.plan_code ? planQuota[line.plan_code] : undefined;
    if (quota === undefined) return { convert: false, reason: "plan_quota_unknown" };
    return quota > 0 ? { convert: true, credits: quota } : { convert: false, reason: "nothing_left" };
  }
  const left = line.cv_views_left ?? 0;
  return left > 0 ? { convert: true, credits: left } : { convert: false, reason: "nothing_left" };
}
