/**
 * D-7B — the two hops that must never be collapsed into one.
 *
 * ===========================================================================
 * SEMANTIC REPLACEMENT IS NOT MATCHING EQUIVALENCE
 * ===========================================================================
 *   skill_chassis_fitting  --replaced_by-->  skill_mechanical_assembly    hop 1: TAXONOMY
 *   skill_mechanical_assembly  --bridge-->   mskill_fitter                hop 2: MATCHING
 *
 * Hop 1 says two concepts are the same trade knowledge. Hop 2 says a worker may be offered a
 * Fitter's vacancy. They are authored in different files by different decisions, and a
 * crosswalk author who only considers hop 1 decides hop 2 without noticing.
 *
 * The shorthand "`skill_chassis_fitting.replaced_by` is `mskill_fitter`" is FALSE and is the
 * specific error these tests exist to prevent: it hides the hop where the claim is created, so
 * the widening becomes invisible.
 *
 * ===========================================================================
 * WHAT IS AND IS NOT ASSERTED
 * ===========================================================================
 * These tests do not say the widening is wrong. Chassis fitting genuinely IS mechanical
 * assembly work, so hop 1 is defensible and hop 2 may well be intended. They assert only that
 * it is VISIBLE and DELIBERATE — that no future edit can create a posting-level claim as a
 * side effect of a taxonomy tidy-up.
 *
 * Production state is read from the committed artifact (`measured_at` included); code state is
 * read from the corpora directly.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ATTRIBUTE_TO_MATCH_SKILLS, auditCrosswalk, SKILL_CORPUS } from "@badabhai/taxonomy";
import type { CrosswalkSkill } from "@badabhai/taxonomy";

import { missingProvenance } from "./evidence-provenance";

interface ChainArtifact {
  kind: string;
  skill_id: string;
  status: string;
  replaced_by: string | null;
  successor_status: string | null;
  successor_in_skill_corpus: boolean | null;
  subject_match_skills: string[] | null;
  successor_match_skills: string[] | null;
  match_skills_gained_by_retag: string[];
  crosswalk_widening: boolean;
  stored_worker_skill_rows_on_chain: number;
  worker_skill_total: number;
  job_reach_total: number;
  retag_predicate_rows: { skill_id: string; replaced_by: string }[];
  owner_decision_required: boolean;
  successor_already_reachable_domains: number;
  reachability_above_floor: { alias: string; job_domain_id: string; top_skill: string; score: number }[];
}

const chain = JSON.parse(
  readFileSync(
    join(__dirname, "..", "..", "..", "docs", "registers", "taxonomy-decisions", "d7b-crosswalk-chain.json"),
    "utf8",
  ),
) as ChainArtifact;

/** Both corpora. `skill_chassis_fitting` lives in the growth half — requirement 5. */
interface GrowthRow {
  skill_id: string;
  status?: string;
  replaced_by?: string | null;
}
const growth: GrowthRow[] = readFileSync(
  join(__dirname, "..", "data", "taxonomy", "skills.jsonl"),
  "utf8",
)
  .split(/\r?\n/)
  .filter((l) => l.trim() !== "" && !l.startsWith("#"))
  .map((l) => JSON.parse(l) as GrowthRow);

const union: CrosswalkSkill[] = [
  ...SKILL_CORPUS.map((s) => ({ skillId: s.skillId, status: s.status, replacedBy: s.replacedBy })),
  ...growth.map((r) => ({ skillId: r.skill_id, status: r.status, replacedBy: r.replaced_by ?? undefined })),
];

describe("the two hops are distinct", () => {
  // REQUIREMENT 1. A `replaced_by` value naming an mskill_* would mean someone wrote a match
  // claim into the taxonomy replacement column. The schema would not stop them: it is a
  // self-FK to `skill`, and `mskill_*` rows live in that same table.
  it("no replaced_by anywhere names an mskill_*", () => {
    const bad = union.filter((s) => s.replacedBy?.startsWith("mskill_"));
    expect(bad.map((s) => s.skillId)).toEqual([]);
  });

  it("the subject's replaced_by is the SUCCESSOR SKILL, not a match skill", () => {
    expect(chain.replaced_by).toBe("skill_mechanical_assembly");
    expect(chain.replaced_by?.startsWith("mskill_")).toBe(false);
  });

  // REQUIREMENT 2. Traversal is explicit: the successor is looked up, then the bridge is
  // consulted for the successor. Two lookups, never one.
  it("the match claim comes from the SUCCESSOR's bridge entry, never the subject's", () => {
    expect(chain.subject_match_skills).toBeNull();
    expect(chain.successor_match_skills).toEqual(["mskill_fitter"]);
    // The bridge is keyed on SKILL_CORPUS members; the subject is not one, so it has no entry
    // at all — which is exactly why the claim can only arrive via the successor.
    expect(Object.keys(ATTRIBUTE_TO_MATCH_SKILLS)).not.toContain(chain.skill_id);
    expect(ATTRIBUTE_TO_MATCH_SKILLS["skill_mechanical_assembly"]).toEqual(["mskill_fitter"]);
  });
});

describe("the widening is visible, not silent", () => {
  // REQUIREMENTS 3 and 4. The audit must SURFACE the gained claim rather than let a
  // replacement quietly confer it.
  it("re-tagging is recorded as CREATING mskill_fitter", () => {
    expect(chain.crosswalk_widening).toBe(true);
    expect(chain.match_skills_gained_by_retag).toEqual(["mskill_fitter"]);
  });

  it("and it is flagged as needing an owner decision", () => {
    expect(chain.owner_decision_required).toBe(true);
  });

  // REQUIREMENT 5. The subject is a growth-corpus skill, which is why the first D-7 audit —
  // scoped to SKILL_CORPUS alone — could not see it. The audit universe must stay the union.
  it("the subject is in the GROWTH corpus, so the audit universe must be the union", () => {
    expect(SKILL_CORPUS.some((s) => s.skillId === chain.skill_id)).toBe(false);
    expect(growth.some((r) => r.skill_id === chain.skill_id)).toBe(true);

    const overUnion = auditCrosswalk(union, ATTRIBUTE_TO_MATCH_SKILLS);
    expect(overUnion.widening).toContain(chain.skill_id);

    // Proof that the narrower scope is blind to it — this is the regression, stated directly.
    const overCorpusOnly = auditCrosswalk(
      SKILL_CORPUS.map((s) => ({ skillId: s.skillId, status: s.status, replacedBy: s.replacedBy })),
      ATTRIBUTE_TO_MATCH_SKILLS,
    );
    expect(overCorpusOnly.widening).not.toContain(chain.skill_id);
  });

  // REQUIREMENT 6. If someone adds the subject to SKILL_CORPUS and gives it a bridge entry,
  // that is a disposition and must be made deliberately — this fails and forces the edit here.
  it("fails if the subject gains a DIRECT bridge entry without an explicit disposition", () => {
    expect(chain.skill_id in ATTRIBUTE_TO_MATCH_SKILLS).toBe(false);
  });
});

describe("the blast radius, as measured", () => {
  it("the artifact carries provenance", () => {
    expect(missingProvenance(chain)).toEqual([]);
  });

  // The honest scope of the risk: real structurally, empty today.
  it("no stored worker row is on the chain right now", () => {
    expect(chain.stored_worker_skill_rows_on_chain).toBe(0);
    expect(chain.worker_skill_total).toBe(0);
    expect(chain.job_reach_total).toBe(0);
  });

  it("the retag runner would act on this row today — it is LIVE, not dormant", () => {
    // status='deprecated' AND replaced_by IS NOT NULL is the runner's own predicate.
    expect(chain.status).toBe("deprecated");
    expect(chain.replaced_by).not.toBeNull();
    expect(chain.retag_predicate_rows.map((r) => r.skill_id)).toContain(chain.skill_id);
  });
});

describe("HOP 0 — the route that needs no retag", () => {
  // THE FINDING THAT REVERSED THIS BRIEF. Retrieval never reads `replaced_by`; it filters
  // `s.status='active'`, which hides the deprecated subject's own exact-match alias and
  // promotes the nearest ACTIVE neighbour — the bridged successor. The guard is the mechanism.
  it("the subject's own phrase already resolves to the successor, above the floor", () => {
    expect(chain.successor_already_reachable_domains).toBeGreaterThan(0);
    for (const r of chain.reachability_above_floor) {
      expect(r.top_skill).toBe("skill_mechanical_assembly");
      expect(r.score).toBeGreaterThanOrEqual(0.75);
    }
  });

  it("it is reachable on more than one job domain, so it is not a single-scope accident", () => {
    const domains = new Set(chain.reachability_above_floor.map((r) => r.job_domain_id));
    expect(domains.size).toBeGreaterThanOrEqual(3);
  });

  // Containment check, pinned: "forbid the retag" was offered as an interim and does not work.
  it("so containment cannot rely on withholding the retag", () => {
    // The route exists while the subject is deprecated and its aliases remain retrievable-
    // adjacent. The retag is not in that sentence.
    expect(chain.status).toBe("deprecated");
    expect(chain.successor_already_reachable_domains).toBeGreaterThan(0);
  });
});

describe("D-7A and D-7C protections are untouched", () => {
  // REQUIREMENT 7. Task 18 holds skill_boring; Task 19 covers the three neutral deprecations.
  const report = auditCrosswalk(union, ATTRIBUTE_TO_MATCH_SKILLS);

  it("skill_boring is still recorded as widening, and still corpus-deprecated only", () => {
    expect(report.widening).toContain("skill_boring");
    expect(ATTRIBUTE_TO_MATCH_SKILLS["skill_boring"]).toEqual([]);
    expect(ATTRIBUTE_TO_MATCH_SKILLS["skill_turning"]).toEqual(["mskill_cnc_turner"]);
  });

  it("the widening set is still exactly the two known ones", () => {
    expect(report.widening).toEqual(["skill_boring", "skill_chassis_fitting"]);
  });

  it("the three D-7C skills remain match-set neutral", () => {
    for (const id of ["skill_gdt_reading", "skill_cad_interpretation", "skill_dimensional_inspection"]) {
      const f = report.findings.find((x) => x.skillId === id);
      expect(f?.gained, id).toEqual([]);
      expect(f?.lost, id).toEqual([]);
    }
  });
});
