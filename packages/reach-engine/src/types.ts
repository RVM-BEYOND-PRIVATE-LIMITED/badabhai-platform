/**
 * Reach Engine — types for the deterministic day-one scoring + ranking core.
 *
 * Maps to the locked behaviour ("BadaBhai — The Matching Algorithm, in Plain
 * English"): REACH everyone relevant → RANK best-first → (PACE/PROTECT/LEARN are
 * surfaces/Phase-2). This package is the pure RANK core: given a job and a set of
 * workers, score each and order them best-first WITHOUT ever dropping anyone.
 *
 * All worker fields are optional — the engine works on partial profiles and never
 * drops a worker for a blank field (§3). Inputs are plain, contract-free types so
 * a Phase-2 caller maps `worker_profiles` → `WorkerSignals` at the boundary.
 */

/** A geographic point — a CITY CENTROID (ADR-0005), never a worker-precise point. */
export interface GeoPoint {
  lat: number;
  lng: number;
}

/** The demand side of a match: what a job needs. */
export interface JobSpec {
  jobId: string;
  /** Canonical role/trade ids the job accepts (e.g. ["vmc_operator"]). */
  roleIds: string[];
  /**
   * Canonical CLOSED-SET skill ids the job requires (ADR-0030 vocabulary, e.g.
   * ["skill_milling"]) — the demand side of the ADR-0033 skills-overlap factor.
   * OPTIONAL + additive: absent/empty means "job lists no skill requirements" and the
   * factor's weight is redistributed (pre-ADR-0033 ordering preserved — see scoring.ts).
   * These are opaque tokens compared by EXACT equality only — never embeddings, never
   * similarity, never a model call (invariant #4).
   */
  skillIds?: string[];
  /** City-centroid of the job, for travel distance. */
  location?: GeoPoint;
  /** City slug fallback when no coordinates are available. */
  city?: string;
  /** How far a worker may reasonably travel (km). Falls back to the option default. */
  maxTravelKm?: number;
  minExperienceYears?: number;
  maxExperienceYears?: number;
  /** Monthly pay the job offers (INR). */
  payMin?: number;
  payMax?: number;
  /** When the job needs someone. */
  neededBy?: "immediate" | "soon" | "flexible";
}

/**
 * What we know about a worker — the §3 relevance signals. EVERY field is optional:
 * a missing field lowers evidence (so a fuller profile ranks higher, §5) but never
 * removes the worker from the result (§3 sort-never-block).
 */
export interface WorkerSignals {
  workerId: string;
  roleId?: string | null;
  secondaryRoleIds?: string[];
  experienceYears?: number | null;
  expectedSalary?: number | null;
  /** City centroid (ADR-0005). */
  location?: GeoPoint | null;
  city?: string | null;
  /** The worker's own travel willingness (km). */
  travelRadiusKm?: number | null;
  availability?: "immediate" | "notice_period" | "not_looking" | "unknown" | null;
  /** Days since last active (recency). Lower = more active. */
  lastActiveDaysAgo?: number | null;
  /**
   * Canonical CLOSED-SET skill ids the worker holds (ADR-0030 vocabulary; the supply
   * side of the ADR-0033 skills-overlap factor). OPTIONAL + additive: absent/empty
   * scores 0 on the skills factor ONLY (per the 2026-06-19 CEO lock ruling) — it never
   * blocks, never penalizes any other factor, and the chat can confirm skills later.
   */
  skillIds?: string[];
}

/** The §3 signals the engine scores (+ `skills` since ADR-0033). */
export type ReachSignal =
  | "role"
  | "distance"
  | "skills"
  | "experience"
  | "pay"
  | "availability"
  | "activity";

/** One scored signal — explainable (the "why", surfaced to ops). */
export interface ScoreComponent {
  signal: ReachSignal;
  /** 0..1 contribution before weighting. Unknown signals use a neutral default. */
  raw: number;
  weight: number;
  reason: string;
}

/** A worker's relevance to a job. NEVER excludes — a poor fit scores low, not absent. */
export interface WorkerJobScore {
  workerId: string;
  jobId: string;
  /** 0..1 overall relevance. */
  score: number;
  components: ScoreComponent[];
}

/** A scored worker placed in the ordered feed/applicant list. */
export interface RankedWorker extends WorkerJobScore {
  /** 1-based position (best first). */
  rank: number;
  /** Top ~10–15% — the "hot tag". Ordering only; nothing is hidden. */
  hot: boolean;
  /** At/above the push-notify floor. Below still APPEARS (sort-never-block), just isn't pushed. */
  pushEligible: boolean;
}

/** Tunable dials (§12 — set in the build/learning phase; the shape stays fixed). */
export interface RankOptions {
  /** Fraction flagged hot (default 0.12 → ~12%). */
  hotFraction?: number;
  /** Min score to push-notify (default 0.4). */
  pushFloor?: number;
  /** Max travel km when neither the job nor the worker specifies one (default 50). */
  defaultMaxTravelKm?: number;
}
