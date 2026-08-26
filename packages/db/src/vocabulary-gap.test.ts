/**
 * The vocabulary gap — and the assertion that makes the finding hard to lose.
 *
 * The finding is counter-intuitive enough to be worth pinning: the match vocabulary is not too
 * small. It is WIDER than the demand surface, because `TRADE_KEYS` is a closed 15-value union and
 * `TRADE_TO_MATCH_SKILL` is total over it. Eleven `mskill_*` cannot be required by any job the
 * platform is able to accept.
 *
 * The trap the first draft fell into is asserted directly: judging "needs new vocabulary" from
 * the attribute bridge reports `assembly` as a gap while `assembly_technician` is already routed
 * to `mskill_fitter`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  MATCH_SKILLS,
  TRADE_KEYS,
  TRADE_TO_MATCH_SKILL,
  type TradeKey,
} from "@badabhai/taxonomy";

import { missingProvenance } from "./evidence-provenance";
import { FAMILIES } from "./q1-disposition-triage";
import {
  demandReachableMatchSkills,
  familyGaps,
  newVocabularyRequired,
  unreachableMatchSkills,
} from "./vocabulary-gap";

const DOCS = join(__dirname, "..", "..", "..", "docs", "registers", "taxonomy-decisions");

describe("the demand surface is closed, and that is the whole argument", () => {
  it("TRADE_TO_MATCH_SKILL is TOTAL over TRADE_KEYS — no job is unroutable", () => {
    for (const t of TRADE_KEYS) {
      expect(TRADE_TO_MATCH_SKILL[t], t).toBeDefined();
    }
    expect(Object.keys(TRADE_TO_MATCH_SKILL).sort()).toEqual([...TRADE_KEYS].sort());
  });

  it("15 trades reach 7 match skills, leaving 11 no job can ever require", () => {
    const reachable = demandReachableMatchSkills();
    expect(TRADE_KEYS).toHaveLength(15);
    expect(reachable.size).toBe(7);
    expect(MATCH_SKILLS).toHaveLength(18);
    expect(unreachableMatchSkills()).toHaveLength(11);
  });

  it("the unreachable eleven include the whole welding and plumbing vocabulary", () => {
    // Not dead vocabulary — unreachable, which is different and is a statement about the TRADE
    // taxonomy rather than about the match one.
    const u = unreachableMatchSkills();
    for (const id of ["mskill_mig_welder", "mskill_tig_welder", "mskill_arc_welder", "mskill_plumber"]) {
      expect(u, id).toContain(id);
    }
  });
});

describe("familyGaps keeps the two sides apart", () => {
  const gaps = familyGaps(
    [
      { family: "assembly", label: "Assembly", skillIds: ["skill_a", "skill_b"] },
      { family: "battery", label: "Battery", skillIds: ["skill_c"] },
    ],
    { skill_a: [], skill_b: [], skill_c: [] },
    { assembly: ["assembly_technician"], battery: [] },
  );
  const assembly = gaps.find((g) => g.family === "assembly")!;
  const battery = gaps.find((g) => g.family === "battery")!;

  it("a family with no attribute mapping can still be SERVED from the demand side", () => {
    // The exact trap: assembly's skills map to nothing and its jobs reach mskill_fitter.
    expect(assembly.attributeSideMatchSkills).toEqual([]);
    expect(assembly.demandSideMatchSkills).toEqual(["mskill_fitter"]);
  });

  it("a family with no trade key can receive no job at all", () => {
    expect(battery.tradeKeys).toEqual([]);
    expect(battery.demandSideMatchSkills).toEqual([]);
    expect(battery.newVocabularyWouldBeReachable).toBe(false);
  });

  it("newVocabularyRequired judges the DEMAND side — attribute-side emptiness is not a gap", () => {
    // Judged on the attribute side, `assembly` would be reported as requiring a new concept.
    expect(newVocabularyRequired(gaps)).toEqual([]);
  });

  it("and it DOES fire when postable demand reaches nothing", () => {
    const broken = familyGaps(
      [{ family: "x", label: "X", skillIds: ["s"] }],
      { s: [] },
      { x: ["not_a_real_trade_key"] },
    );
    expect(newVocabularyRequired(broken).map((g) => g.family)).toEqual(["x"]);
  });
});

// ---------------------------------------------------------------------------
interface Family {
  family: string;
  promotableSkills: number;
  matched: number;
  intentionallyUnmatched: number;
  attributeSideMatchSkills: string[];
  tradeKeys: string[];
  demandSideMatchSkills: string[];
  newVocabularyWouldBeReachable: boolean;
}
interface Artifact {
  ai_spend_inr: number;
  trade_keys: number;
  match_skills_defined: number;
  match_skills_reachable_by_any_job: string[];
  match_skills_unreachable: string[];
  families: Family[];
  families_without_postable_demand: string[];
  skills_in_families_without_postable_demand: number;
  new_vocabulary_required: string[];
  live_jobs_by_trade: { trade_key: string; status: string; jobs: number; match_skill: string | null }[];
  live_trade_keys_without_match_skill: string[];
  relevance_chain: { job_posting_skill: number; worker_skill: number; job_reach: number };
  trade_key_attribution_is_analytical: string;
  production_mutation_performed: boolean;
}

const art = JSON.parse(readFileSync(join(DOCS, "vocabulary-gap.json"), "utf8")) as Artifact;

describe("the measured answer", () => {
  it("carries provenance, cost nothing, wrote nothing", () => {
    expect(missingProvenance(art)).toEqual([]);
    expect(art.ai_spend_inr).toBe(0);
    expect(art.production_mutation_performed).toBe(false);
  });

  it("NO new mskill vocabulary is required", () => {
    expect(art.new_vocabulary_required).toEqual([]);
  });

  it("because every live trade key already routes to an existing match skill", () => {
    expect(art.live_trade_keys_without_match_skill).toEqual([]);
    for (const j of art.live_jobs_by_trade) expect(j.match_skill, j.trade_key).not.toBeNull();
  });

  it("9 of 13 families have promotable supply and NO postable demand — 75 skills", () => {
    expect(art.families_without_postable_demand).toHaveLength(9);
    expect(art.skills_in_families_without_postable_demand).toBe(75);
    expect(Object.keys(FAMILIES)).toHaveLength(13);
  });

  it("and the relevance chain is empty on BOTH sides, so today the gap costs nothing", () => {
    // A match skill is consulted when a posting requires it AND a worker carries it.
    expect(art.relevance_chain.job_posting_skill).toBe(0);
    expect(art.relevance_chain.worker_skill).toBe(0);
    expect(art.relevance_chain.job_reach).toBe(0);
  });

  it("the trade-key attribution is labelled analytical, not ratified", () => {
    expect(art.trade_key_attribution_is_analytical).toMatch(/not a ratified mapping/);
    expect(art.trade_key_attribution_is_analytical).toMatch(/no runtime path reads it/);
  });
});

describe("nothing was invented", () => {
  it("MATCH_SKILLS is still 18 and no mskill_* was added", () => {
    expect(MATCH_SKILLS).toHaveLength(18);
    expect(art.match_skills_defined).toBe(18);
  });

  it("every family's attribute-side mapping comes from the existing 18", () => {
    const known = new Set(MATCH_SKILLS.map((m) => m.skillId));
    for (const f of art.families) {
      for (const m of f.attributeSideMatchSkills) expect(known, `${f.family} -> ${m}`).toContain(m);
      for (const m of f.demandSideMatchSkills) expect(known, `${f.family} -> ${m}`).toContain(m);
    }
  });

  it("the trade union itself is unchanged at 15", () => {
    expect(art.trade_keys).toBe(15);
    const sample: TradeKey = "assembly_technician";
    expect(TRADE_KEYS).toContain(sample);
  });
});
