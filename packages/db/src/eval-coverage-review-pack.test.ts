/**
 * The E1 trainer pack — asserted on the property that makes it trustworthy.
 *
 * This runner exists because six skills need ground truth, and the one thing it must never do
 * is supply it. So the assertions below are mostly refusals: no slot carries a query, no slot
 * is pre-marked `reviewed`, and the set it describes is the set the promotion gate enforces
 * rather than a list somebody typed into this file.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildPack,
  findSkill,
  mechanicalEvidence,
  orderedDomains,
} from "./eval-coverage-review-pack";
import { evalCoverage } from "./promote-skills";
import { loadTaxonomyCorpus, TAXONOMY_DATA_DIR } from "./taxonomy-corpus";
import { loadEvalFixture, reviewStatusOf } from "./taxonomy-eval-fixture";

const FIXTURE = loadEvalFixture(join(TAXONOMY_DATA_DIR, "eval", "retrieval-v2.jsonl"));
const CORPUS = loadTaxonomyCorpus(TAXONOMY_DATA_DIR);
const PACK = buildPack();

describe("the pack describes the gate, not a list", () => {
  it("covers exactly the skills evalCoverage demotes", () => {
    // Same function `promote-skills` calls. A hardcoded list would have been right once.
    const { demoted } = evalCoverage(FIXTURE);
    expect(PACK.entries.map((e) => e.skill_id)).toEqual(demoted);
    expect(PACK.gate_state.demoted).toBe(demoted.length);
  });

  it("finds every demoted skill in one of the two corpora", () => {
    // Non-empty `missing` means the fixture and the corpus disagree; the runner exits 1 rather
    // than handing a trainer a short list, so this is the test that keeps that path honest.
    expect(PACK.missing).toEqual([]);
    for (const e of PACK.entries) expect(findSkill(e.skill_id, CORPUS)).toBeDefined();
  });

  it("reports the coverage numbers the gate actually computed", () => {
    const { covered, demoted } = evalCoverage(FIXTURE);
    expect(PACK.gate_state).toMatchObject({
      fixture_cases: FIXTURE.cases.length,
      covered_by_reviewed: covered.size,
      demoted: demoted.length,
      blocks_live_promotions: 0,
    });
  });
});

describe("the pack does not author ground truth", () => {
  it("ships every paraphrase slot EMPTY", () => {
    // The property the whole runner exists to preserve. A generated paraphrase would re-open
    // the hole E1 closed, one layer up: self-certifying evidence unlocking a promotion.
    const slots = PACK.entries.flatMap((e) =>
      e.proposed_cases.filter((c) => c.review_status === "pending_review"),
    );
    expect(slots.length).toBeGreaterThan(0);
    for (const c of slots) {
      expect(c.query).toBe("");
      expect(c.provenance).toBe("pending_reviewer_authorship");
    }
    expect(PACK.slots_awaiting_trainer).toBe(slots.length);
  });

  it("marks nothing `reviewed`", () => {
    // Only a human sets that. Every case the runner emits is `mechanical` (tautological, and
    // already in the fixture) or `pending_review` (empty).
    for (const c of PACK.entries.flatMap((e) => e.proposed_cases)) {
      expect(["mechanical", "pending_review"]).toContain(c.review_status);
    }
  });

  it("only puts a query on a case whose query IS an existing alias", () => {
    for (const e of PACK.entries) {
      const aliases = new Set(e.existing_aliases.map((a) => a.text));
      for (const c of e.proposed_cases.filter((x) => x.query !== "")) {
        expect(aliases.has(c.query)).toBe(true);
      }
    }
  });

  it("shows the trainer the phrases they must not reuse", () => {
    // A slot with no visible alias list invites a paraphrase that repeats one, which measures
    // nothing — the exact failure that made these six mechanical-only in the first place.
    for (const e of PACK.entries) expect(e.existing_aliases.length).toBeGreaterThan(0);
  });
});

describe("scope selection", () => {
  it("opens the slot in the domain the mechanical case already used", () => {
    // The reviewed case then measures the same scope the mechanical one only claimed.
    for (const e of PACK.entries) {
      const mech = mechanicalEvidence(FIXTURE.cases, e.skill_id);
      expect(mech.length).toBeGreaterThan(0);
      for (const c of e.proposed_cases.filter((x) => x.review_status === "pending_review")) {
        expect(c.job_domain_id).toBe(mech[0]!.job_domain_id);
      }
    }
  });

  it("prefers the mechanical domain even when it is not the strongest edge", () => {
    const multi = PACK.entries.find((e) => e.domains.length > 1);
    expect(multi).toBeDefined();
    const mech = mechanicalEvidence(FIXTURE.cases, multi!.skill_id)[0]!;
    expect(orderedDomains(multi!.skill_id, CORPUS, mech.job_domain_id).domains[0]).toBe(
      mech.job_domain_id,
    );
  });

  it("lists every trade the skill is wired to, not only the scoped one", () => {
    for (const e of PACK.entries) {
      const edges = CORPUS.edges
        .filter((x) => x.skill_id === e.skill_id)
        .map((x) => x.job_domain_id);
      expect([...e.domains].sort()).toEqual([...new Set(edges)].sort());
    }
  });
});

describe("the committed artifact", () => {
  it("is what the runner produces today", () => {
    // The pack in `data/taxonomy/eval/review-pack/` is the thing a trainer opens. If the corpus
    // or the fixture moves under it, the file on disk is describing a state that no longer
    // exists — regenerate it (delete and re-run; the runner refuses to overwrite).
    const onDisk = JSON.parse(
      readFileSync(
        join(TAXONOMY_DATA_DIR, "eval", "review-pack", "e1-eval-coverage-trainer-pack.json"),
        "utf8",
      ),
    );
    expect(onDisk.entries.map((e: { skill_id: string }) => e.skill_id)).toEqual(
      PACK.entries.map((e) => e.skill_id),
    );
    expect(onDisk.gate_state).toEqual(PACK.gate_state);
    expect(onDisk.slots_awaiting_trainer).toBe(PACK.slots_awaiting_trainer);
  });

  it("says out loud that it was built without vectors", () => {
    // Absent competitors must read as "not computed", never as "this skill has no near
    // neighbours". The growth corpus has no vectors anywhere — production is 0% seeded — so
    // `false` is the honest value here and will stay so until after the D2 embed run.
    expect(PACK.competitors_available).toBe(false);
    for (const e of PACK.entries) expect(e.competing_skills).toEqual([]);
  });
});

describe("the six, and why they cost nothing today", () => {
  it("are all covered by a mechanical case and none by a reviewed one", () => {
    for (const e of PACK.entries) {
      const own = FIXTURE.cases.filter(
        (c) =>
          c.expected_skill_id === e.skill_id || (c.acceptable_skill_ids ?? []).includes(e.skill_id),
      );
      expect(own.length).toBeGreaterThan(0);
      expect(own.every((c) => reviewStatusOf(c) === "mechanical")).toBe(true);
    }
  });

  it("are all still `provisional`, so nothing live is waiting on them", () => {
    for (const e of PACK.entries) expect(e.status).toBe("provisional");
  });
});
