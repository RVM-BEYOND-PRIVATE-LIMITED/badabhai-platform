/**
 * The trainer pack's validator, driven in both directions.
 *
 * Every rule here exists because it is a plausible way to FILL A SLOT AND CLEAR THE GATE WITHOUT
 * MEASURING ANYTHING — which is precisely the defect E1 was ruled to close one layer down. So
 * each rule is asserted twice: it rejects the shape it is about, and it accepts the corrected
 * version. A validator that only ever refuses is as useless as one that only ever passes.
 *
 * The shipped pack is also checked as-is, because "six slots, all empty, zero problems" is the
 * state this tool must report today, and a tool that cannot describe the current state correctly
 * will not be trusted with the next one.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_PACK,
  SLOT_PREFIX,
  UNAUTHORED_PROVENANCE,
  render,
  validateSlot,
  validateTrainerPack,
  type PackCase,
  type PackEntry,
  type TrainerPack,
} from "./verify-trainer-pack";
import { DEFAULT_FIXTURE } from "./taxonomy-retrieval-eval";
import { loadEvalFixture } from "./taxonomy-eval-fixture";

const ENTRY: PackEntry = {
  skill_id: "skill_earthing_and_bonding",
  label_en: "Earthing and bonding",
  domains: ["jd_nco_7411_0100", "jd_nco_7412_0200"],
  existing_aliases: [
    { text: "earthing work", lang: "en" },
    { text: "अर्थ पिट", lang: "hi" },
  ],
  proposed_cases: [],
};

/** A correctly filled English slot — the shape everything below deviates from. */
const GOOD: PackCase = {
  case_id: "PR-earthing_and_bondi-1",
  query: "put the rod in the ground and connect the wire",
  lang: "en",
  category: "paraphrase_latin",
  job_domain_id: "jd_nco_7411_0100",
  expected_skill_id: "skill_earthing_and_bonding",
  provenance: "trainer:rvm",
  review_status: "reviewed",
};

const judge = (o: Partial<PackCase> = {}, ids: string[] = [], siblings: [string, string][] = []) =>
  validateSlot({ ...GOOD, ...o }, ENTRY, new Set(ids), new Map(siblings));

describe("validateSlot — would this case measure anything?", () => {
  it("accepts a well-formed, non-tautological phrase", () => {
    const v = judge();
    expect(v.problems).toEqual([]);
    expect(v.state).toBe("filled");
  });

  it("an empty slot is 'empty', not a problem — that is the shipped state", () => {
    // Failing on an unfilled pack would make this command unusable as a routine check, and the
    // pack explicitly says a slot left blank costs nothing.
    for (const q of ["", "   ", "\n"]) {
      const v = judge({ query: q });
      expect(v.state).toBe("empty");
      expect(v.problems).toEqual([]);
    }
  });

  it("REJECTS the skill's own alias — the mechanical case, one indirection along", () => {
    expect(judge({ query: "earthing work" }).problems.join()).toContain("existing alias");
    // ...and normalisation means case and punctuation do not launder it.
    expect(judge({ query: "  Earthing   Work! " }).problems.join()).toContain("existing alias");
    expect(judge({ query: "अर्थ पिट", lang: "hi" }).problems.join()).toContain("existing alias");
  });

  it("accepts a phrase that merely CONTAINS an alias word — that is a real paraphrase", () => {
    // The rule is equality after normalisation, not substring. "earthing" appearing inside a
    // longer sentence is exactly what a worker would say, and rejecting it would leave the
    // trainer with no way to describe the skill at all.
    expect(judge({ query: "earthing work ke liye rod lagana" }).problems).toEqual([]);
  });

  it("REJECTS a slot that duplicates its sibling", () => {
    const v = judge({}, [], [["PR-earthing_and_bondi-2", GOOD.query]]);
    expect(v.problems.join()).toContain("identical to PR-earthing_and_bondi-2");
  });

  it("...but an EMPTY sibling is not a duplicate", () => {
    expect(judge({}, [], [["PR-earthing_and_bondi-2", ""]]).problems).toEqual([]);
  });

  it("REJECTS review_status that is not 'reviewed' — otherwise the gate still ignores it", () => {
    // The most likely failure of all: a trainer writes the phrase and does not change the
    // status, the case looks authored, and `countsAsEvalCoverage` still returns false.
    for (const st of ["pending_review", "mechanical", undefined]) {
      expect(judge({ review_status: st }).problems.join()).toContain("must be \"reviewed\"");
    }
  });

  it("REJECTS provenance left as shipped, or set back to a corpus alias", () => {
    expect(judge({ provenance: UNAUTHORED_PROVENANCE }).problems.join()).toContain("name who authored it");
    expect(
      judge({ provenance: "corpus_alias:skill_earthing_and_bonding/en" }).problems.join(),
    ).toContain("derives back to mechanical");
  });

  it("REJECTS a Hindi slot answered in Latin script, and the reverse", () => {
    // The silent one. A transliterated answer still scores, so the Devanagari phrasing — the one
    // workers actually say — stays unmeasured while the report claims it was covered.
    expect(judge({ lang: "hi", query: "arth pit banana" }).problems.join()).toContain("Devanagari");
    expect(judge({ lang: "en", query: "ज़मीन में रॉड" }).problems.join()).toContain(
      "contains Devanagari",
    );
    expect(judge({ lang: "hi", query: "ज़मीन में रॉड गाड़कर तार जोड़ना" }).problems).toEqual([]);
  });

  it("REJECTS a slot re-pointed at another skill", () => {
    expect(judge({ expected_skill_id: "skill_something_else" }).problems.join()).toContain(
      "may not be re-pointed",
    );
  });

  it("REJECTS a domain this skill is not wired to, and names the ones it is", () => {
    // Retrieval is domain-scoped, so a case in the wrong scope cannot pass however good the
    // phrase is — and it would be read as a retrieval failure rather than a fixture error.
    const p = judge({ job_domain_id: "jd_nco_9999_0000" }).problems.join();
    expect(p).toContain("not one this skill is wired to");
    expect(p).toContain("jd_nco_7411_0100");
    expect(judge({ job_domain_id: "jd_nco_7412_0200" }).problems).toEqual([]);
  });

  it("REJECTS a case_id that collides with the shipped fixture", () => {
    expect(judge({}, [GOOD.case_id]).problems.join()).toContain("already exists in the fixture");
  });

  it("reports EVERY problem at once, not the first", () => {
    // A trainer fixing one line per round trip through a person is how six slots take six weeks.
    const v = judge({
      query: "earthing work",
      review_status: "pending_review",
      provenance: UNAUTHORED_PROVENANCE,
      job_domain_id: "jd_nope",
    });
    expect(v.problems.length).toBeGreaterThanOrEqual(4);
    expect(v.state).toBe("invalid");
  });
});

describe("validateTrainerPack — the gate, per skill", () => {
  const fixture = loadEvalFixture(DEFAULT_FIXTURE);
  const pack = (cases: PackCase[]): TrainerPack => ({
    kind: "e1-eval-coverage-trainer-pack",
    entries: [{ ...ENTRY, proposed_cases: cases }],
  });

  it("ONE valid slot clears the skill — the second is an invitation, not a requirement", () => {
    const v = validateTrainerPack(
      pack([GOOD, { ...GOOD, case_id: "PR-earthing_and_bondi-2", lang: "hi", query: "" }]),
      fixture,
    );
    expect(v.cleared).toBe(1);
    expect(v.skills[0]!.cleared).toBe(true);
  });

  it("an INVALID slot does not clear the skill", () => {
    const v = validateTrainerPack(pack([{ ...GOOD, review_status: "pending_review" }]), fixture);
    expect(v.cleared).toBe(0);
    expect(v.invalid).toBe(1);
  });

  it("ignores the mechanical cases the pack ships for context", () => {
    // `MX-*` rows are printed so the trainer can avoid repeating them. Validating them would
    // report the very thing the pack exists to explain as an error.
    const mech: PackCase = {
      ...GOOD,
      case_id: "MX-earthing_and_bondi-1",
      query: "earthing work",
      provenance: "corpus_alias:skill_earthing_and_bonding/en",
      review_status: "mechanical",
    };
    const v = validateTrainerPack(pack([mech, GOOD]), fixture);
    expect(v.invalid).toBe(0);
    expect(v.skills[0]!.slots.map((s) => s.caseId)).toEqual([GOOD.case_id]);
    expect(mech.case_id.startsWith(SLOT_PREFIX)).toBe(false);
  });
});

describe("the shipped pack, as it stands today", () => {
  it("is six skills, twelve empty slots, and zero problems", () => {
    // The state this tool must describe correctly before anyone trusts it with the next one.
    const real = JSON.parse(readFileSync(DEFAULT_PACK, "utf8")) as TrainerPack;
    const v = validateTrainerPack(real, loadEvalFixture(DEFAULT_FIXTURE));
    expect(v.skills).toHaveLength(6);
    expect(v.cleared).toBe(0);
    expect(v.awaiting).toBe(6);
    expect(v.invalid).toBe(0);
    expect(v.skills.flatMap((s) => s.slots)).toHaveLength(12);
    expect(v.skills.flatMap((s) => s.slots).every((s) => s.state === "empty")).toBe(true);
  });

  it("STILL SHIPS EMPTY — no phrase has been authored by engineering", () => {
    // The owner ruling, asserted rather than trusted: a phrase written by the same side that
    // scores it would clear the gate and measure nothing, which is E1's own argument one layer
    // up. If this test ever fails, someone filled in a slot who should not have.
    const real = JSON.parse(readFileSync(DEFAULT_PACK, "utf8")) as TrainerPack;
    for (const e of real.entries) {
      for (const c of e.proposed_cases.filter((x) => x.case_id.startsWith(SLOT_PREFIX))) {
        expect(c.query.trim(), `${c.case_id} has been filled in`).toBe("");
        expect(c.provenance).toBe(UNAUTHORED_PROVENANCE);
      }
    }
  });

  it("the report says what to do next, and never rejects a phrase for being a poor one", () => {
    const real = JSON.parse(readFileSync(DEFAULT_PACK, "utf8")) as TrainerPack;
    const text = render(validateTrainerPack(real, loadEvalFixture(DEFAULT_FIXTURE))).join("\n");
    expect(text).toContain("still awaiting a phrase 6");
    expect(text).toContain("pending_review` stays out of every metric");
  });
});
