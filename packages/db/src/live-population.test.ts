/**
 * The live population, pinned — including the two things it could not explain.
 *
 * A measurement suite that only asserts the numbers it likes is a worse instrument than none.
 * Two assertions below pin FAILURES to reconcile, so a later reader cannot mistake this run for
 * a clean bill of health, and a future run that DOES reconcile has to change them deliberately.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { missingProvenance } from "./evidence-provenance";

const DOCS = join(__dirname, "..", "..", "..", "docs", "registers", "taxonomy-decisions");

interface Artifact {
  ai_spend_inr: number;
  bypass_rls: boolean;
  read_only: boolean;
  counts: Record<string, number>;
  recorded_previously: Record<string, Record<string, number | null>>;
  arrivals_workers: { day: string; n: number }[];
  departures: { table_name: string; day: string; app_name: string | null; n: number }[];
  departures_total: number;
  departures_via_dashboard: number;
  forensics_covers_tables: string[];
  forensics_coverage_caveat: string;
  candidate_readings_of_recorded_figures: Record<string, number>;
  predicates_yielding_one_worker: string[];
  jobs_by_created_at: { day: string; n: number }[];
  worker_profile_job_domain_matches: { status: string; layer: string | null; n: number }[];
  worker_profiles_with_embedding: number;
  ann_layer_matches: number;
  reconciliation: {
    workers_recorded_2026_08_24: number | null;
    workers_created_on_or_after_2026_08_24: number;
    workers_now: number;
    explained_by_arrivals: boolean;
  };
  historical_documents_edited: boolean;
  production_mutation_performed: boolean;
}

const art = JSON.parse(
  readFileSync(join(DOCS, "live-population-2026-08-26.json"), "utf8"),
) as Artifact;

describe("the measurement is worth believing", () => {
  it("read-only, bypassing RLS, no spend, no writes, no history edited", () => {
    expect(missingProvenance(art)).toEqual([]);
    expect(art.read_only).toBe(true);
    // A zero from a role without BYPASSRLS is indistinguishable from "not permitted to look".
    expect(art.bypass_rls).toBe(true);
    expect(art.ai_spend_inr).toBe(0);
    expect(art.production_mutation_performed).toBe(false);
    expect(art.historical_documents_edited).toBe(false);
  });
});

describe("the population as of 2026-08-26", () => {
  it("37 workers, 22 profiles, 19 jobs, 28 applications", () => {
    expect(art.counts["workers"]).toBe(37);
    expect(art.counts["worker_profiles"]).toBe(22);
    expect(art.counts["jobs"]).toBe(19);
    expect(art.counts["open_jobs"]).toBe(17);
    expect(art.counts["applications"]).toBe(28);
  });

  it("the relevance chain is still empty on every side", () => {
    expect(art.counts["job_posting_skill"]).toBe(0);
    expect(art.counts["worker_skill"]).toBe(0);
    expect(art.counts["job_reach"]).toBe(0);
  });

  it("nothing has been promoted: 111 provisional, 52 active, 2 deprecated", () => {
    expect(art.counts["skills_provisional"]).toBe(111);
    expect(art.counts["skills_active"]).toBe(52);
    expect(art.counts["skills_deprecated"]).toBe(2);
    expect(art.counts["match_skill_rows"]).toBe(18);
  });
});

describe("arrivals and departures", () => {
  it("every current worker arrived between 2026-08-21 and 2026-08-25", () => {
    const days = art.arrivals_workers.map((a) => a.day);
    expect(Math.min(...days.map((d) => Number(d.replace(/-/g, ""))))).toBeGreaterThanOrEqual(20260821);
    expect(art.arrivals_workers.reduce((n, a) => n + a.n, 0)).toBe(art.counts["workers"]);
  });

  it("all 311 recorded deletions came through the Supabase dashboard, none after 08-21", () => {
    expect(art.departures_total).toBe(311);
    expect(art.departures_via_dashboard).toBe(311);
    expect(art.departures.every((d) => d.day <= "2026-08-21")).toBe(true);
  });

  it("forensics covers workers and worker_profiles ONLY — silence elsewhere is not evidence", () => {
    // jobs went 25 -> 19 with no forensic record, because there is no trigger on jobs.
    expect([...art.forensics_covers_tables].sort()).toEqual(["worker_profiles", "workers"]);
    expect(art.forensics_coverage_caveat).toMatch(/absence of a TRIGGER/);
  });

  it("no job has been created since 2026-08-05, so 19 is not recent growth", () => {
    expect(art.jobs_by_created_at.every((j) => j.day <= "2026-08-05")).toBe(true);
  });
});

describe("the two things this run could NOT reconcile", () => {
  it('the recorded "1 worker [08-24]" does not reproduce, and no probed predicate yields it', () => {
    // 31 workers existed before 2026-08-24 and nothing was deleted after 08-21. Whatever the
    // figure counted, it was not `count(*) FROM workers`. Guessing a reading would be the exact
    // failure the provenance rule exists to prevent — so it stays unreconciled.
    expect(art.reconciliation.workers_recorded_2026_08_24).toBe(1);
    expect(art.reconciliation.explained_by_arrivals).toBe(false);
    expect(art.candidate_readings_of_recorded_figures["workers_before_0824"]).toBe(31);
    expect(art.predicates_yielding_one_worker).toEqual([]);
  });

  it("jobs 25 -> 19 and applications 92 -> 28 have no forensic record either", () => {
    expect(art.counts["jobs"]).toBeLessThan(art.recorded_previously["2026-08-24 (project-control)"]!["jobs"]!);
    expect(art.counts["applications"]).toBeLessThan(
      art.recorded_previously["2026-08-24 (project-control)"]!["applications"]!,
    );
    expect(art.forensics_covers_tables).not.toContain("jobs");
    expect(art.forensics_covers_tables).not.toContain("applications");
  });
});

describe("worker profiles ARE being matched to job domains, lexically", () => {
  it("10 profiles carry a job_domain_id", () => {
    expect(art.worker_profile_job_domain_matches.reduce((n, d) => n + d.n, 0)).toBe(10);
  });

  it("every match is lexical or worker-confirmed — the ANN layer never ran", () => {
    // This is what makes it consistent with DOMAIN_MATCH_ENABLED=false rather than a violation.
    expect(art.ann_layer_matches).toBe(0);
    expect(art.worker_profiles_with_embedding).toBe(0);
    for (const d of art.worker_profile_job_domain_matches) {
      expect(["l0_exact", "l2_trigram", null], d.status).toContain(d.layer);
    }
  });

  it("which is live taxonomy behaviour the 'nothing is connected' summary omits", () => {
    expect(art.worker_profile_job_domain_matches.length).toBeGreaterThan(0);
  });
});
