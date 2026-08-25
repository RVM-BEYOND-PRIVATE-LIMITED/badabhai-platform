/**
 * Trainer phrases must not carry a SIBLING skill's lexical identity.
 *
 * ===========================================================================
 * THE DEFECT THIS PINS
 * ===========================================================================
 * A trainer phrase exists to prove a skill is findable from language that is NOT its own alias.
 * `countsAsEvalCoverage` already refuses the obvious cheat — a query that IS the skill's alias,
 * which asks the index whether a string matches itself.
 *
 * It does not catch the opposite mistake, and the 2026-08-21 v3 run found two of them. TP-36
 * ended "before shearing" while `skill_shearing_machine_operation` is an edge of the same
 * domain; TP-19 said "on the mig machine" while `skill_mig_welding` is an edge of the same
 * domain. Both retrieved the sibling instead of the target, at 0.7216 and 0.6923.
 *
 * Those were author errors, not retrieval errors — the index did exactly what the words asked.
 * A phrase naming a sibling's identity cannot measure anything, because there is no correct
 * answer for retrieval to find.
 *
 * ===========================================================================
 * WHAT IT DOES *NOT* ASSERT
 * ===========================================================================
 * It does not require a phrase to avoid the target's own vocabulary — describing the right
 * concept in its own words is the point. And it does not require R@1 to pass: genuine sibling
 * AMBIGUITY (TP-27, TP-08, TP-01, TP-15) is evidence worth keeping, and those cases stay
 * exactly as authored. The rule is narrow on purpose — a phrase may not contain the LABEL or an
 * ALIAS of a DIFFERENT skill wired to the SAME domain.
 */
import { describe, expect, it } from "vitest";

import { loadEvalFixture } from "./taxonomy-eval-fixture";
import { loadTaxonomyCorpus } from "./taxonomy-corpus";

const FIXTURE = "data/taxonomy/eval/retrieval-v3.jsonl";

const corpus = loadTaxonomyCorpus();
const fixture = loadEvalFixture(FIXTURE);

/** skill_id -> every string that identifies it (label_en, label_hi, all aliases). */
const identity = new Map<string, string[]>();
for (const s of corpus.skills) {
  const xs = [s.label_en, s.label_hi, ...(s.aliases ?? []).map((a) => a.text)]
    .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    .map((x) => x.trim().toLowerCase());
  identity.set(s.skill_id, [...new Set(xs)]);
}

/** domain -> skills wired to it. */
const siblings = new Map<string, string[]>();
for (const e of corpus.edges) {
  siblings.set(e.job_domain_id, [...(siblings.get(e.job_domain_id) ?? []), e.skill_id]);
}

const trainer = fixture.cases.filter((c) => c.case_id.startsWith("TP-"));

describe("trainer phrase hygiene", () => {
  it("the pack is present", () => {
    expect(trainer.length).toBeGreaterThanOrEqual(41);
  });

  it("no trainer query contains the label or an alias of a SIBLING skill in its own domain", () => {
    const leaks: string[] = [];
    for (const c of trainer) {
      const q = c.query.toLowerCase();
      for (const sib of siblings.get(c.job_domain_id) ?? []) {
        if (sib === c.expected_skill_id) continue;
        for (const token of identity.get(sib) ?? []) {
          // Substring, not word-boundary: "mig machine" leaked via a bare "mig", and
          // Devanagari has no word boundaries \b can see.
          if (token.length >= 3 && q.includes(token)) {
            leaks.push(`${c.case_id} (${c.job_domain_id}) contains ${JSON.stringify(token)} of sibling ${sib}`);
          }
        }
      }
    }
    expect(leaks).toEqual([]);
  });

  it("no trainer query is an exact echo of its OWN skill's label or alias", () => {
    const echoes = trainer.filter((c) => {
      const own = identity.get(c.expected_skill_id ?? "") ?? [];
      return own.includes(c.query.trim().toLowerCase());
    });
    expect(echoes.map((c) => c.case_id)).toEqual([]);
  });

  it("the two rewritten cases carry their new text and an explanatory note", () => {
    const byId = new Map(trainer.map((c) => [c.case_id, c]));
    const tp36 = byId.get("TP-36");
    const tp19 = byId.get("TP-19");
    expect(tp36?.query).toBe("scribing the profile onto the plate with a template before fabrication");
    expect(tp19?.query).toBe("replacing the worn contact tip and nozzle on the torch");
    for (const c of [tp36, tp19]) expect(c?.notes ?? "").toMatch(/Rewritten 2026-08-21/);
  });

  it("the four genuine sibling-ambiguity cases are UNCHANGED", () => {
    // These miss R@1 and that is the finding. Rewriting them would delete the evidence.
    const byId = new Map(trainer.map((c) => [c.case_id, c]));
    expect(byId.get("TP-27")?.query).toBe("mounting contactors and breakers in the panel");
    expect(byId.get("TP-08")?.query).toBe("पानी की मोटर खोलकर सील बदलना");
    expect(byId.get("TP-01")?.query).toBe("load test to see how long the cell holds charge");
    expect(byId.get("TP-15")?.query).toBe("इनडोर का फिल्टर और कॉइल धोना");
  });
});
