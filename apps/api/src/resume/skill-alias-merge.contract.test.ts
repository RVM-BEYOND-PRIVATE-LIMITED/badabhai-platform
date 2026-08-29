import { SKILL_CORPUS, WEDGE_ALIASES, skillIdForPhrase } from "@badabhai/taxonomy";
import { describe, expect, it } from "vitest";

import { buildResumeRenderInput } from "./resume-render-input";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * ONE SKILL, ONE CHIP — the alias layer's own moat, proved against every ratified term (R16 §3).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * WHAT WAS WRONG. `DraftProfile` carries a worker's skills in two arrays that nothing joins:
 * `skills` (canonical ids) and `skill_labels` (the words he said). The résumé merged them by
 * comparing STRINGS, so a phrase and its own canonical label both survived and the sheet listed
 * one competence twice.
 *
 * THE FRAMING THAT NEEDED CORRECTING. This was reported as a defect waiting behind
 * `SKILL_CANONICALIZE_ENABLED` — "arming it makes the worker double-render". It is not waiting.
 * The Python lexicon's labels and `SKILL_CORPUS.labelEn` drifted long ago, and the deterministic
 * detector writes a label into `skill_labels` and the id of the SAME lexicon row into `skills`.
 * Four of the five ids it can emit already print twice, with the flag off, on the branch most
 * existing profiles take. Arming the alias layer would have been a fifth road into a defect that
 * ships today.
 *
 * WHY THE 22 ARE THE RIGHT PROOF SET. §8.2 calls the alias table the moat and the thing no model
 * does without hand-seeding, and these are the terms an RVM domain owner ratified one by one on
 * 2026-07-16. They are also the phrases MOST likely to trigger the bug: vernacular that no
 * English label normalises to, arriving beside the very id it resolves to. If `kharad` and
 * "Turning (lathe operation)" both print, the moat is actively making the résumé worse.
 *
 * A NOTE ON THE COUNT, because the directive says "the turner's 22": the 22 ratified aliases are
 * the WEDGE set across 16 distinct skill ids covering the seven launch roles — turning, milling,
 * drilling, threading, grinding, setting, programming, measurement, maintenance and the adjacent
 * welding/fitting anchors. Exactly TWO of them are turner terms (`kharad`, `kharad ka kaam`).
 * They are all exercised here anyway: the mechanism is per-phrase and the turner has no special
 * case in it.
 */

const RATIFIED = WEDGE_ALIASES.filter((w) => w.ratified);

/** The worker's own phrase and the canonical id it resolves to, both on one snapshot. */
function renderWith(skillIds: string[], phrases: string[]) {
  return buildResumeRenderInput(
    { skills: skillIds, skill_labels: phrases },
    "Ramesh Kumar Yadav",
    "classic",
    null,
    false,
    "worker",
  );
}

describe("R16 §3 — a ratified alias and its own canonical id print ONE chip", () => {
  it("the proof set is the ratified 22, not a sample", () => {
    // Vacuity, first. Every assertion below is per-row, so an empty set would pass all of them
    // in silence — which is how a table-driven proof becomes the most reassuring test in a repo.
    expect(RATIFIED.length).toBe(22);
    expect(new Set(RATIFIED.map((w) => w.skillId)).size).toBe(16);
    // And the index must actually resolve them, or the de-dupe below has nothing to work with.
    for (const w of RATIFIED) {
      expect(skillIdForPhrase(w.alias.text), `${w.alias.text} does not resolve`).toBe(w.skillId);
    }
  });

  it.each(RATIFIED.map((w) => [w.alias.text, w.skillId] as const))(
    "%s + its id → one chip",
    (phrase, skillId) => {
      const chips = renderWith([skillId], [phrase]).skills;
      // The canonical label is printed once and the worker's phrase is not printed beside it.
      expect(chips.length, `"${phrase}" duplicated: ${JSON.stringify(chips)}`).toBe(1);
      expect(chips[0]).not.toBe(phrase);
    },
  );

  it("a phrase whose skill is NOT already present is still printed", () => {
    // The other direction, and the one a de-dupe is most likely to break. Dropping a phrase the
    // worker gave, when nothing else on the sheet says it, deletes a real skill from his résumé.
    const chips = renderWith(["skill_milling"], ["kharad"]).skills;
    expect(chips).toContain("kharad");
    expect(chips.length).toBe(2);
  });

  it("an unreviewed phrase is never dropped", () => {
    // The index resolves reviewed terms only. Anything it does not recognise must survive
    // untouched — a de-dupe that guesses would silently delete the vocabulary the growth loop
    // exists to discover.
    const chips = renderWith(["skill_turning"], ["ghisai ka kaam bhi karta hu"]).skills;
    expect(chips).toContain("ghisai ka kaam bhi karta hu");
  });

  it("the LIVE flag-off double-render is closed too, not only the alias path", () => {
    // MEASURED BEFORE THE FIX, and this is the case that was shipping. `signals.py` writes the
    // Python lexicon's label into `skill_labels` and the id of the same row into `skills`; the
    // two label tables disagree for four of the five ids it can emit, so a string de-dupe let
    // every one of them through.
    const drifted: ReadonlyArray<readonly [string, string]> = [
      ["skill_fixture_setup", "fixture setup"],
      ["skill_program_editing", "program editing"],
      ["skill_cam_software", "CAM software"],
      ["skill_tool_offset_setting", "tool offset setting"],
    ];
    for (const [id, pythonLabel] of drifted) {
      const chips = renderWith([id], [pythonLabel]).skills;
      expect(chips.length, `${id} + "${pythonLabel}" → ${JSON.stringify(chips)}`).toBe(1);
    }
  });

  it("the two label tables really do disagree — the premise, asserted", () => {
    // If this ever goes green by the labels converging, the test above stops proving anything
    // and should be re-derived rather than deleted.
    const corpus = new Map(SKILL_CORPUS.map((s) => [s.skillId, s.labelEn]));
    expect(corpus.get("skill_fixture_setup")).not.toBe("fixture setup");
    expect(corpus.get("skill_program_editing")).not.toBe("program editing");
  });
});
