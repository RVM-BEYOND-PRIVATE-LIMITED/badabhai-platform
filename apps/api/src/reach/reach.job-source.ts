import { Injectable } from "@nestjs/common";
import { isDevEnv } from "@badabhai/config";
import type { JobSpec } from "@badabhai/reach-engine";
import { ReachRepository, type JobSignalRow } from "./reach.repository";
import { roleIdsForTradeKey } from "../resume/trade-content";

/**
 * The `JobSource` port (ADR-0011 §4) — the seam over the real job entity. The
 * serving layer depends on THIS interface, never on the Drizzle types, so the real
 * read is a single provider swap with zero change to `reach.service.ts` /
 * `reach.controller.ts`. PRODUCTION binding: `JobsTableJobSource` over the live
 * ADR-0009 `jobs` table (see below). `StubJobSource` is retained for tests only.
 *
 * The port returns engine-typed `JobSpec`s only — opaque ids + demand-side signals.
 * It carries NO employer name or contact (faceless by construction, §invariants).
 */
export interface JobSource {
  /** One job mapped to the engine's demand-side type. `null` if absent. */
  getJobSpec(jobId: string): Promise<JobSpec | null>;
  /** All currently-open jobs as engine demand-side types (View B candidate set). */
  listOpenJobSpecs(): Promise<JobSpec[]>;
}

/** DI token for the `JobSource` port. */
export const JOB_SOURCE = Symbol("JOB_SOURCE");

/**
 * Deterministic alpha fixtures (ADR-0011 §4). These are `JobSpec`s ONLY — opaque
 * `jobId`, accepted `roleIds`, a city/centroid, and demand-side numbers. There is
 * deliberately NO employer name, contact, or any PII (faceless by construction).
 *
 * D6 DRIFT GUARD: every `jobId` MUST be a real UUID. `feed.shown.job_id` validates
 * as `uuidSchema`, so a non-UUID id would throw at `createEvent`. These are
 * hard-coded valid v4 UUIDs; `job_postings.id` (uuid) satisfies the same contract
 * at swap time. A test asserts each fixture id parses as a UUID.
 */
const STUB_JOBS: readonly JobSpec[] = [
  {
    jobId: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
    roleIds: ["vmc_operator"],
    city: "pune",
    location: { lat: 18.5204, lng: 73.8567 },
    maxTravelKm: 40,
    minExperienceYears: 2,
    payMin: 18000,
    payMax: 28000,
    neededBy: "immediate",
  },
  {
    jobId: "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e",
    roleIds: ["cnc_operator", "vmc_operator"],
    city: "nashik",
    location: { lat: 19.9975, lng: 73.7898 },
    maxTravelKm: 30,
    minExperienceYears: 1,
    payMin: 16000,
    payMax: 24000,
    neededBy: "soon",
  },
  {
    jobId: "2c3d4e5f-6a7b-4c8d-89e0-1f2a3b4c5d6e",
    roleIds: ["cnc_programmer"],
    city: "aurangabad",
    location: { lat: 19.8762, lng: 75.3433 },
    maxTravelKm: 50,
    minExperienceYears: 4,
    payMin: 30000,
    payMax: 45000,
    neededBy: "flexible",
  },
] as const;

/**
 * Alpha `JobSource` — serves the in-code `STUB_JOBS` fixtures, no table.
 *
 * SWAP POINT: when ADR-0010 (`job_postings`) merges, the `JOB_SOURCE` binding in
 * `reach.module.ts` flips to a `JobPostingsJobSource` provider that reads the table
 * and maps rows → `JobSpec`. The controller/service are untouched — one provider swap.
 *
 * Returned objects are defensively copied so a caller can never mutate the fixtures.
 */
@Injectable()
export class StubJobSource implements JobSource {
  async getJobSpec(jobId: string): Promise<JobSpec | null> {
    const found = STUB_JOBS.find((j) => j.jobId === jobId);
    return found ? structuredClone(found) : null;
  }

  async listOpenJobSpecs(): Promise<JobSpec[]> {
    return STUB_JOBS.map((j) => structuredClone(j));
  }
}

/**
 * D6 PRODUCTION GATE: the stub must never silently serve fixtures in a real
 * environment. `isDevEnv()` (from @badabhai/config) reads the RAW `NODE_ENV` and
 * FAILS CLOSED — true only for an explicit "development"/"test", false for unset /
 * "staging" / "production" / typos. So the real `JobPostingsJobSource` is required
 * outside dev/test; until it lands, booting `reach` outside dev/test throws here.
 */
export function createStubJobSourceOrThrow(): StubJobSource {
  if (!isDevEnv()) {
    throw new Error(
      "StubJobSource is dev/test-only (ADR-0011 D6): bind JobsTableJobSource to " +
        "JOB_SOURCE for non-dev environments — the alpha stub must never serve " +
        "fixtures in staging/production.",
    );
  }
  return new StubJobSource();
}

/**
 * Pure row→`JobSpec` mapper — the FACELESS BOUNDARY (ADR-0011 swap point / TD36c).
 * Takes only the demand-side signal projection (`JobSignalRow`) and emits engine
 * types. It NEVER receives or returns `title` / `area` / `payer_id` (the repository
 * projection already drops them), so an employer-y free-text or a billing linkage
 * can never reach a `JobSpec`, a `feed.shown` event, or a log.
 *
 *  - `roleIds` ← the trade→role bridge (`roleIdsForTradeKey`), so the RANK core's
 *    Role factor exact-matches a worker's `canonical_role_id`. A non-machining trade
 *    yields `[]` (no Phase-1 worker role) → role scores low, worker still shown.
 *  - `city` ← the coarse slug; the engine's Distance factor uses the city-slug
 *    fallback (no coordinates are stored or needed).
 *  - pay / experience / neededBy ← null becomes `undefined`, which the engine
 *    neutral-defaults (a blank never drops or penalizes anyone).
 *  - `skillIds` (ADR-0033) is deliberately ABSENT: the `jobs` entity carries no
 *    skill-id column (the canonicalized ids live on the separate `job_postings`
 *    entity, TAX-6 — no join path, TD37), so the engine redistributes the skills
 *    weight and a jobs-table job's ordering is exactly the non-skills factors'.
 *    Do NOT invent ids here; demand-side ids arrive via a future additive migration.
 */
export function jobSignalRowToJobSpec(row: JobSignalRow): JobSpec {
  return {
    jobId: row.jobId,
    roleIds: roleIdsForTradeKey(row.tradeKey),
    city: row.city,
    minExperienceYears: row.minExperienceYears ?? undefined,
    maxExperienceYears: row.maxExperienceYears ?? undefined,
    payMin: row.payMin ?? undefined,
    payMax: row.payMax ?? undefined,
    neededBy: row.neededBy ?? undefined,
  };
}

/**
 * The real `JobSource` (ADR-0011 §4 swap executed) — serves the live ADR-0009
 * `jobs` entity via the faceless `ReachRepository` projection. Replaces the alpha
 * `StubJobSource` in `reach.module.ts`. Controller/service are untouched.
 */
@Injectable()
export class JobsTableJobSource implements JobSource {
  constructor(private readonly repo: ReachRepository) {}

  async getJobSpec(jobId: string): Promise<JobSpec | null> {
    const row = await this.repo.findJobSignalRowById(jobId);
    return row ? jobSignalRowToJobSpec(row) : null;
  }

  async listOpenJobSpecs(): Promise<JobSpec[]> {
    const rows = await this.repo.listOpenJobSignalRows();
    return rows.map(jobSignalRowToJobSpec);
  }
}
