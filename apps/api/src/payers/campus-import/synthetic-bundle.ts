/**
 * #2754 item 12 — a SYNTHETIC Campus export bundle in format v1, for tests and for the pilot of our
 * own dummy companies (ruling 17 Nov 2026: we test every feature on dummy companies before any real
 * company moves).
 *
 * It writes exactly what RVMBeyond_jobportal#156 writes (`serializeBundle`): one JSON object per
 * line, a trailing newline on a non-empty file, and a manifest listing each file's record count and
 * sha256. So the real reader, with every check on, reads it.
 *
 * Every company and person is fictional. Names say "BadaBhai pilot". Phones default to the 10-digit
 * shape only; a pilot that must receive real SMS codes passes its OWN team phones in `phones`. The
 * source ids are deterministic per `seed`, so a second build of the same seed is the same bundle
 * (which is how the import's idempotence is rehearsed).
 */
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CAMPUS_BUNDLE_FILES, CAMPUS_BUNDLE_FORMAT, CAMPUS_BUNDLE_VERSION } from "./bundle.schema";

type Rec = Record<string, unknown>;

export interface SyntheticBundleOptions {
  /** 3 to 5 companies for the pilot (ruling); tests may use 1. */
  companies: number;
  /** Changes every source id; the same seed gives the same bundle. */
  seed: string;
  /** Owner phones (10 digits) per company, in order. Missing entries get a fictional number. */
  phones?: readonly string[];
  /** Owner e-mails per company, in order. Missing entries get `pilot<n>@<seed>.invalid`. */
  emails?: readonly string[];
  generatedAt?: string;
}

/** A deterministic uuid-shaped id from the seed and a label. Not random, never a real Campus id. */
export function syntheticId(seed: string, label: string): string {
  const h = createHash("sha256").update(`${seed}:${label}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** A fictional 10-digit mobile for company `n`: starts with 6 and is derived from the seed. */
function fictionalPhone(seed: string, n: number): string {
  const digits = BigInt(`0x${createHash("sha256").update(`${seed}:phone:${n}`).digest("hex").slice(0, 12)}`);
  return `6${(digits % 1_000_000_000n).toString().padStart(9, "0")}`;
}

export function buildSyntheticBundle(opts: SyntheticBundleOptions): {
  manifest: Rec;
  texts: Record<string, string>;
} {
  if (!Number.isInteger(opts.companies) || opts.companies < 1 || opts.companies > 20) {
    throw new Error("companies must be an integer from 1 to 20");
  }
  const at = opts.generatedAt ?? "2026-11-17T12:00:00.000+05:30";
  const id = (label: string) => syntheticId(opts.seed, label);
  const files: Record<string, Rec[]> = Object.fromEntries(
    CAMPUS_BUNDLE_FILES.map((f) => [f, [] as Rec[]]),
  );

  for (let n = 1; n <= opts.companies; n += 1) {
    const companyId = id(`company:${n}`);
    const phone = opts.phones?.[n - 1] ?? fictionalPhone(opts.seed, n);
    const email = (opts.emails?.[n - 1] ?? `pilot${n}@${opts.seed}.invalid`).toLowerCase();
    // Company 3 is an email-first sign-up: no owner phone, so nothing is proven (the 17 Nov rule).
    const emailOnly = n === 3;
    // Company 2 is still pending approval on Campus.
    const approval = n === 2 ? "pending" : "approved";

    const jobActive = id(`job:${n}:active`);
    const jobPaused = id(`job:${n}:paused`);
    const jobExpired = id(`job:${n}:expired`);
    const job = (sourceId: string, status: string, pastExpiry: boolean, moving: number): Rec => ({
      source_id: sourceId,
      company_source_id: companyId,
      job_code: `PILOT-${n}-${status}`,
      title: `CNC Turner (BadaBhai pilot ${n})`,
      description: "A dummy job for the BadaBhai pilot. Not a real vacancy.",
      status,
      past_expiry: pastExpiry,
      created_at: at,
      updated_at: at,
      expires_at: pastExpiry ? "2026-11-01T00:00:00.000+05:30" : "2026-12-31T00:00:00.000+05:30",
      application_deadline: null,
      location: "Faridabad",
      job_type: "full_time",
      openings: 2,
      experience_min_months: 12,
      experience_max_months: 60,
      salary_min_lpa: 2,
      salary_max_lpa: 3.5,
      required_skills: ["CNC turning"],
      preferred_skills: [],
      cad_software_required: [],
      industry: null,
      required_domain: null,
      required_role: null,
      interview: { type: "direct", address: null, date: null },
      application_type: "direct",
      external_apply_url: null,
      listing_type: "standard",
      audience: { visibility_type: "all", allowed_location_ids: [], campus_location_ids: [] },
      plan: { plan_code: "starter", is_paid_posting: true, resume_quota: 20, resume_views_used: 2, cv_views_left: 18 },
      applications: { open: moving + 1, moving, held: 1 },
    });
    files["jobs.jsonl"]!.push(job(jobActive, "active", false, 2), job(jobPaused, "paused", false, 0), job(jobExpired, "active", true, 0));

    // Two applications move on the active job: an outside candidate the company already opened, and
    // a consenting RVM student. One RVM student without consent is held on Campus (counted only).
    files["applications.jsonl"]!.push(
      {
        source_id: id(`application:${n}:external`),
        job_source_id: jobActive,
        company_source_id: companyId,
        status: "shortlisted",
        applied_at: at,
        updated_at: at,
        interview_date: null,
        interview_attended_at: null,
        walk_in: false,
        company_unlocked_at: at,
        candidate: {
          source_id: id(`candidate:${n}:external`),
          kind: "external",
          name: `Pilot Candidate ${n}`,
          phone: fictionalPhone(`${opts.seed}:candidate`, n),
          email: null,
          city: "Faridabad",
          state: "Haryana",
        },
      },
      {
        source_id: id(`application:${n}:rvm`),
        job_source_id: jobActive,
        company_source_id: companyId,
        status: "applied",
        applied_at: at,
        updated_at: at,
        interview_date: null,
        interview_attended_at: null,
        walk_in: false,
        company_unlocked_at: null,
        candidate: { source_id: id(`candidate:${n}:rvm`), kind: "rvm_student", student_ref: id(`student:${n}`) },
      },
    );
    files["problems.jsonl"]!.push({ kind: "applications_held_no_consent", job_source_id: jobActive, detail: { count: 1 } });

    files["companies.jsonl"]!.push({
      source_id: companyId,
      name: `BadaBhai Pilot Company ${n}`,
      approval_status: approval,
      approved_at: approval === "approved" ? at : null,
      created_at: at,
      sign_in_phone: emailOnly
        ? { value: null, class: "missing", source: null }
        : { value: phone, class: "good", source: "owner_login" },
      proven_phone: emailOnly ? { value: null, verified_at: null } : { value: phone, verified_at: at },
      contact: { name: `Pilot Contact ${n}`, email, phone: emailOnly ? null : phone },
      profile: { industry: "Manufacturing", size: "11-50", city: "Faridabad", state: "Haryana", website: null, preferred_locale: "en", logo_url: null },
      gst: { gstin: null, gst_state_code: null, billing_address: { line1: null, line2: null, pincode: null }, gstins: [] },
      counts: { jobs: 3, applications_moving: 2, applications_held: 1 },
    });
    if (emailOnly) {
      files["problems.jsonl"]!.push({ kind: "sign_in_phone_missing", company_source_id: companyId, detail: { source: null } });
    }

    files["logins.jsonl"]!.push({ company_source_id: companyId, kind: "owner", type: "email", value: email, verified_at: at, source_id: id(`login:${n}:owner`) });
    if (!emailOnly) {
      files["logins.jsonl"]!.push({ company_source_id: companyId, kind: "owner", type: "phone", value: phone, verified_at: at, source_id: id(`login:${n}:owner`) });
    }

    files["unused_plans.jsonl"]!.push(
      { key: `campus:cv_views_left_on_plan_jobs:${companyId}:starter`, line: "cv_views_left_on_plan_jobs", company_source_id: companyId, plan_code: "starter", jobs: 1, live_jobs: 1, cv_views_left: 18, cv_views_left_live: 18, job_posts_left: null, paise: null },
      { key: `campus:cv_views_in_wallet:${companyId}:free`, line: "cv_views_in_wallet", company_source_id: companyId, plan_code: "free", jobs: null, live_jobs: null, cv_views_left: 5, cv_views_left_live: null, job_posts_left: null, paise: null },
    );
  }

  const texts: Record<string, string> = {};
  const fileInfo: Record<string, { records: number; sha256: string }> = {};
  for (const name of CAMPUS_BUNDLE_FILES) {
    const rows = files[name]!;
    const text = rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
    texts[name] = text;
    fileInfo[name] = { records: rows.length, sha256: createHash("sha256").update(text).digest("hex") };
  }
  const manifest: Rec = {
    format: CAMPUS_BUNDLE_FORMAT,
    version: CAMPUS_BUNDLE_VERSION,
    generated_at: at,
    read_only: true,
    source: { supabase_project_ref: "synthetic" },
    scope: { companies: "list", company_count: opts.companies },
    rules: { synthetic: true },
    counts: {
      companies: opts.companies,
      jobs: files["jobs.jsonl"]!.length,
      applications_moving: files["applications.jsonl"]!.length,
      applications_held: opts.companies,
      unused_plans: files["unused_plans.jsonl"]!.length,
      problems: files["problems.jsonl"]!.length,
    },
    files: fileInfo,
  };
  return { manifest, texts };
}

/** Write a synthetic bundle into an EMPTY (or new) folder, as Campus's `--out` does. */
export function writeSyntheticBundle(dir: string, opts: SyntheticBundleOptions): void {
  mkdirSync(dir, { recursive: true });
  if (readdirSync(dir).length > 0) throw new Error("the bundle folder must be empty or new");
  const { manifest, texts } = buildSyntheticBundle(opts);
  for (const [name, text] of Object.entries(texts)) writeFileSync(join(dir, name), text);
  writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}
