/**
 * P1-B's rules, tested without a database.
 *
 * The point of these is adversarial: each one asks whether the rule can be SATISFIED BY A LIE —
 * an understated delta, a phantom addition, an unreviewed skill — because that is the only
 * failure mode that matters. A rule nobody can cheat is worth more than a rule that passes.
 */
import { describe, expect, it } from "vitest";

import { slugDigest, overallDigest, type ParityBaseline } from "./verify-path-b-parity";
import {
  checkCollisions,
  checkNewSkills,
  checkReconstruction,
  type CandidateRow,
  type StageBDelta,
} from "./verify-stage-b-parity";

const row = (domain_id: string, skill_id: string, text: string, embedding_model: string | null = "gemini-embedding-001"): CandidateRow =>
  ({ domain_id, skill_id, text, embedding_model });

/** A two-slug baseline built from real rows, so digests are genuine rather than hand-written. */
const BASE_ROWS: CandidateRow[] = [
  row("welding", "skill_tig", "tig welding"),
  row("welding", "skill_arc", "arc welding"),
  row("grinding", "skill_grind", "ghisai"),
];

function baselineOf(rows: readonly CandidateRow[]): ParityBaseline {
  const bySlug = new Map<string, CandidateRow[]>();
  for (const r of rows) bySlug.set(r.domain_id, [...(bySlug.get(r.domain_id) ?? []), r]);
  const slugs = [...bySlug.entries()]
    .map(([domainId, rs]) => ({
      domainId,
      candidates: rs.length,
      skills: new Set(rs.map((r) => r.skill_id)).size,
      digest: slugDigest(rs),
    }))
    .sort((a, b) => a.domainId.localeCompare(b.domainId));
  return { kind: "path-b-parity", target: { host_class: "test", database: "t" }, slugs, digest: overallDigest(slugs) };
}

const BASE = baselineOf(BASE_ROWS);
const emptyDelta: StageBDelta = { kind: "stage-b-delta", stage: "B", added: [], removed: [], new_skills: [] };

describe("P1-B R1/R2 — the baseline must reconstruct from the declared delta", () => {
  it("PASSES when nothing changed and nothing is declared", () => {
    const { r1, r2 } = checkReconstruction(BASE, BASE_ROWS, emptyDelta);
    expect(r1.pass).toBe(true);
    expect(r2.pass).toBe(true);
  });

  it("PASSES for a purely additive stage whose additions are all declared", () => {
    const added = [row("welding", "skill_tig", "tig se jodna")];
    const current = [...BASE_ROWS, ...added];
    const { r1, r2 } = checkReconstruction(BASE, current, { ...emptyDelta, added });
    expect(r1.pass).toBe(true);
    expect(r2.pass).toBe(true);
  });

  it("FAILS when an addition is NOT declared — the delta cannot understate what moved", () => {
    const current = [...BASE_ROWS, row("welding", "skill_tig", "tig se jodna")];
    const { r1 } = checkReconstruction(BASE, current, emptyDelta);
    expect(r1.pass).toBe(false);
    expect(r1.detail.join("\n")).toContain("MISMATCH");
  });

  it("FAILS when a baseline row silently disappears", () => {
    const current = BASE_ROWS.filter((r) => r.text !== "arc welding");
    const { r1 } = checkReconstruction(BASE, current, emptyDelta);
    expect(r1.pass).toBe(false);
  });

  it("PASSES a removal that IS enumerated with a reviewer — the approved-exception path", () => {
    const gone = row("welding", "skill_arc", "arc welding");
    const current = BASE_ROWS.filter((r) => r.text !== "arc welding");
    const delta: StageBDelta = {
      ...emptyDelta,
      removed: [{ ...gone, reviewed_by: "product owner", reason: "duplicate election" }],
    };
    const { r1, r2 } = checkReconstruction(BASE, current, delta);
    expect(r1.pass).toBe(true);
    expect(r2.pass).toBe(true);
  });

  it("FAILS a declared removal that is actually still present — a stale file is not evidence", () => {
    const delta: StageBDelta = {
      ...emptyDelta,
      removed: [{ ...row("welding", "skill_arc", "arc welding"), reviewed_by: "x", reason: "y" }],
    };
    const { r2 } = checkReconstruction(BASE, BASE_ROWS, delta);
    expect(r2.pass).toBe(false);
    expect(r2.detail.join("\n")).toContain("declared removed but STILL present");
  });

  it("FAILS a phantom addition — declaring a row that does not exist", () => {
    const delta: StageBDelta = { ...emptyDelta, added: [row("welding", "skill_tig", "never written")] };
    const { r2 } = checkReconstruction(BASE, BASE_ROWS, delta);
    expect(r2.pass).toBe(false);
    expect(r2.detail.join("\n")).toContain("declared added but NOT present");
  });

  it("FAILS a MUTATION disguised as parity — same count, different embedding_model", () => {
    // The digest covers the model, so a silent re-embed onto a new model cannot pass by count.
    const current = BASE_ROWS.map((r) =>
      r.text === "arc welding" ? { ...r, embedding_model: "gemini-embedding-2" } : r,
    );
    const { r1 } = checkReconstruction(BASE, current, emptyDelta);
    expect(r1.pass).toBe(false);
  });
});

describe("P1-B R3 — a new skill in a slug needs a named reviewer", () => {
  const baselineSkills = new Map<string, Set<string>>([
    ["welding", new Set(["skill_tig", "skill_arc"])],
    ["grinding", new Set(["skill_grind"])],
  ]);

  it("PASSES when no new skill entered any slug", () => {
    const r = checkNewSkills(BASE, BASE_ROWS, emptyDelta, baselineSkills);
    expect(r.pass).toBe(true);
  });

  it("FAILS an undeclared new skill", () => {
    const current = [...BASE_ROWS, row("welding", "skill_brazing", "brazing")];
    const r = checkNewSkills(BASE, current, emptyDelta, baselineSkills);
    expect(r.pass).toBe(false);
    expect(r.detail.join("\n")).toContain("UNREVIEWED new skill in slug: welding / skill_brazing");
  });

  it("FAILS a declared new skill with an empty reviewed_by — a signature is the whole point", () => {
    const current = [...BASE_ROWS, row("welding", "skill_brazing", "brazing")];
    const delta: StageBDelta = {
      ...emptyDelta,
      new_skills: [{ skill_id: "skill_brazing", domain_id: "welding", reviewed_by: "   ", note: "n" }],
    };
    expect(checkNewSkills(BASE, current, delta, baselineSkills).pass).toBe(false);
  });

  it("PASSES a properly reviewed new skill", () => {
    const current = [...BASE_ROWS, row("welding", "skill_brazing", "brazing")];
    const delta: StageBDelta = {
      ...emptyDelta,
      new_skills: [{ skill_id: "skill_brazing", domain_id: "welding", reviewed_by: "product owner", note: "distinct process" }],
    };
    expect(checkNewSkills(BASE, current, delta, baselineSkills).pass).toBe(true);
  });

  it("does NOT flag a skill that gains extra aliases — recall change, not reachability change", () => {
    const current = [...BASE_ROWS, row("welding", "skill_tig", "tig se jodna")];
    expect(checkNewSkills(BASE, current, emptyDelta, baselineSkills).pass).toBe(true);
  });
});

describe("P1-B R4 — no cross-skill alias collision inside a slug", () => {
  it("PASSES a corpus where every (slug, text) maps to one skill", () => {
    expect(checkCollisions(BASE_ROWS).pass).toBe(true);
  });

  it("FAILS when two skills share a text in the SAME slug — the 2026-08-21 defect", () => {
    const current = [...BASE_ROWS, row("welding", "skill_arc", "tig welding")];
    const r = checkCollisions(current);
    expect(r.pass).toBe(false);
    expect(r.detail.join("\n")).toContain("COLLISION welding");
    expect(r.detail.join("\n")).toContain("skill_arc, skill_tig");
  });

  it("is case-insensitive — 'GD&T' and 'gd&t' are the same phrase to a reader", () => {
    const current = [row("m", "skill_a", "GD&T"), row("m", "skill_b", "gd&t")];
    expect(checkCollisions(current).pass).toBe(false);
  });

  it("does NOT flag the same text across DIFFERENT slugs — scoping is what a slug is for", () => {
    const current = [row("welding", "skill_a", "reading"), row("grinding", "skill_b", "reading")];
    expect(checkCollisions(current).pass).toBe(true);
  });

  it("does NOT flag one skill holding the same text twice (different lang rows)", () => {
    const current = [row("welding", "skill_a", "reading"), row("welding", "skill_a", "reading")];
    expect(checkCollisions(current).pass).toBe(true);
  });
});
