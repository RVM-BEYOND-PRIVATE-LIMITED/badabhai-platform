import { Injectable } from "@nestjs/common";
import type { JobPosting } from "@badabhai/db";
import { ROLES } from "@badabhai/taxonomy";
import type { JobSpec } from "@badabhai/reach-engine";
import { JobPostingsRepository } from "../job-postings/job-postings.repository";
import type { JobSource } from "./reach.job-source";

/**
 * Real `JobSource` (ADR-0011 §4 SWAP POINT) — reads ops-created `job_postings`
 * (ADR-0012) and maps each row → the engine's demand-side `JobSpec`. Bound to
 * `JOB_SOURCE` outside dev/test (see `reach.module.ts`), replacing the dev-only
 * `StubJobSource`; the controller/service are untouched (the whole point of the port).
 *
 * IMPEDANCE (read honestly): `job_postings` is **stored-only** and was authored to
 * NOT carry ranking signals (schema comment / ADR-0012) — it has free-text
 * `roleTitle` / `locationLabel`, a banded vacancy, and a lifecycle, but NO canonical
 * role id, geo/centroid, pay band, experience floor, or urgency. So this mapper
 * derives only what is faithfully derivable and OMITS the rest; the RANK core
 * neutral-defaults every missing signal (sort-never-block, ADR-0006 §3), so a thin
 * posting still produces an honest ranked feed — just weighted on the signals that
 * exist (primarily role match + worker activity). We NEVER fabricate a demand signal.
 *
 * Reconciliation of ADR-0012 ("does not feed ranking") vs ADR-0011 ("JobSource reads
 * job_postings"): ranking stays **read-time + deterministic** off `worker_profiles`;
 * nothing is written back onto the posting and it gains no worker linkage. The posting
 * only contributes its id + weak demand signals to a read-only ops view.
 *
 * FACELESS (invariant): a `JobSpec` carries ONLY opaque id + demand signals. This
 * mapper NEVER copies `orgLabel` / `description` / `createdBy` (NON-PII by contract
 * but still not ranking signals, and not the feed's business).
 *
 * FOLLOW-UP (logged, not built here): richer demand signals (canonical role on the
 * posting, geo centroid, pay/experience bands) need an additive `job_postings`
 * enrichment — an ADR-0012 amendment / schema change, deliberately out of scope for
 * this read-time mapping fix.
 */

/** Normalize free text for a tolerant exact match: lowercase, collapse non-alnum. */
function normalizeRole(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Normalized {name | id | alias} → canonical role id, built once from the taxonomy.
 * The taxonomy is the canonical source the AI extraction also targets, so a posting
 * title that matches a role name lines up with the worker's `canonical_role_id`.
 */
const ROLE_LOOKUP: ReadonlyMap<string, string> = (() => {
  const m = new Map<string, string>();
  for (const role of ROLES) {
    m.set(normalizeRole(role.id), role.id);
    m.set(normalizeRole(role.name), role.id);
    // `aliases` is optional on the taxonomy Role type; none are defined today, so read
    // it defensively (future-proof) without depending on the narrowed const literal.
    const aliases = (role as { aliases?: readonly string[] }).aliases ?? [];
    for (const alias of aliases) m.set(normalizeRole(alias), role.id);
  }
  return m;
})();

/**
 * Canonicalize a free-text posting `roleTitle` → `[canonicalRoleId]`, or `[]` when it
 * matches no known role. `[]` is the honest "unknown role" — the engine neutral-defaults
 * the role signal (never drops the job/worker). We do NOT fuzzy-guess; an unrecognized
 * title contributes no role match rather than a fabricated one. (Free-text → canonical
 * is exactly the AI extraction's job; this exact-match is the deterministic read-time
 * floor until a posting carries a canonical role id.)
 */
export function canonicalizeRoleTitle(roleTitle: string | null | undefined): string[] {
  if (!roleTitle) return [];
  const id = ROLE_LOOKUP.get(normalizeRole(roleTitle));
  return id ? [id] : [];
}

/**
 * Map one `job_postings` row → `JobSpec`. Only `jobId` + `roleIds` are always set;
 * `city` is included when `locationLabel` is non-blank (lowercased to match the slug
 * convention the worker city signal uses). Every other demand field is intentionally
 * absent (the posting does not carry it) → engine neutral-defaults.
 */
export function mapPostingToJobSpec(posting: JobPosting): JobSpec {
  const spec: JobSpec = {
    jobId: posting.id,
    roleIds: canonicalizeRoleTitle(posting.roleTitle),
  };
  const city = posting.locationLabel?.toLowerCase().trim();
  if (city) spec.city = city;
  return spec;
}

@Injectable()
export class JobPostingsJobSource implements JobSource {
  constructor(private readonly postings: JobPostingsRepository) {}

  /**
   * Resolve one posting → `JobSpec`. Returns `null` (→ controller 404) when the id is
   * unknown OR the posting is `closed` (a closed posting is no longer recruiting). A
   * `draft` or `open` posting is servable so ops can review applicants for a posting
   * they just created, before flipping it open.
   */
  async getJobSpec(jobId: string): Promise<JobSpec | null> {
    const posting = await this.postings.findById(jobId);
    if (!posting || posting.status === "closed") return null;
    return mapPostingToJobSpec(posting);
  }

  /** All `open` postings → `JobSpec[]` (View B worker-feed candidate set). */
  async listOpenJobSpecs(): Promise<JobSpec[]> {
    const open = await this.postings.list("open");
    return open.map(mapPostingToJobSpec);
  }
}
