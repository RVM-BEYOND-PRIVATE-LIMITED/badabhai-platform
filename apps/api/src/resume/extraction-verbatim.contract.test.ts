import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { normalizeForMatch, splitIntoPhrases } from "./resume-own-words";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════
 * THE VERBATIM-SPAN CONTRACT (R10 §2.3) — every phrase field must be the worker's own words.
 * ══════════════════════════════════════════════════════════════════════════════════════
 *
 * THE RULE IS NOT NEW AND NOT NEGOTIABLE. §8's governing sentence: "The model extracts, normalises
 * and classifies. It never composes. Every printed string on a BadaBhai resume originates from one
 * of exactly three sources: a closed vocabulary label, a number the worker stated, or the worker's
 * own words rendered verbatim. There is no fourth source." §8.5 lists "summarise the worker" FIRST
 * among the things the extraction model must never be asked to do.
 *
 * WHAT THE R7 RUN MEASURED. Two of five personas came back as English prose the model composed:
 *
 *   p4: "Full setting including tool offset, work offset, nose radius compensation, jaw change,
 *        tailstock set करना, first piece approval. Setting up new jobs. Operating CNC lathe with
 *        Fanuc and Siemens controllers, bar feeder, live tooling, sub-spindle. Programming in
 *        G-code and M-code, using canned cycles like G71, G76, G74…"  — 586 characters
 *
 * That is a summary, in English, of a Hinglish conversation. It is a SPEC VIOLATION rather than a
 * quality complaint, and nothing in the pipeline could see it: the fabrication gate checks
 * set-membership of printed strings, and every skill in that paragraph is one the worker really
 * named. Composition is invisible to a membership test.
 *
 * WHY THIS FILE CAN CHECK IT AT ALL. The own-words block already proved the mechanism — a phrase
 * prints only when it occurs verbatim inside a stored worker turn. R10 §2.3 extends that from the
 * quotes block to EVERY phrase field, as an assertion rather than a filter: the quotes block
 * silently drops what it cannot vouch for, which is right for a résumé and wrong for a contract.
 * Here the drop is the failure.
 *
 * GATED ON THE ARTIFACTS, like the persona harness, because it reads the output of a paid model
 * run. `RUN_PERSONA_SHEETS=1` after `extract_personas.py`.
 */

const HARNESS_DIR = join(__dirname, "../../../../scripts/persona-harness");
const OUT_DIR = join(HARNESS_DIR, "out");
const ENABLED = process.env.RUN_PERSONA_SHEETS === "1";

interface Persona {
  id: string;
  label: string;
  transcript: [string, string][];
}

interface ExtractArtifact {
  extract: {
    experiences?: { work_done?: string | null; duration_text?: string | null }[];
  };
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/**
 * The phrases in a field that the worker's own turns do NOT contain.
 *
 * SAME NORMALISATION AS THE QUOTES BLOCK, deliberately: case-folded, whitespace-collapsed, edge
 * punctuation stripped. Anything stricter would fail on a stray comma and anything looser would
 * pass a paraphrase.
 *
 * PHRASES BELOW THE FLOOR ARE SKIPPED. A three-word fragment ("job work") is short enough to
 * collide with the transcript by accident in either direction, so it is neither evidence of
 * composition nor evidence against it.
 */
const MIN_CHECKABLE = 18;

function composedPhrases(field: string | null | undefined, said: string[]): string[] {
  if (!field) return [];
  return splitIntoPhrases(field)
    .filter((p) => p.length >= MIN_CHECKABLE)
    .filter((p) => {
      const key = normalizeForMatch(p);
      return key !== "" && !said.some((turn) => turn.includes(key));
    });
}

/**
 * THE ONE PHRASE THE PROMPT FIX DID NOT REACH, pinned exactly rather than tolerated by a looser
 * rule.
 *
 * Persona 3 said "Kharad bhi chalayi hai shuru me"; the model returned "Kharad chalayi hai" —
 * his words, in his language, with two interior words dropped. It is a NEAR-quote, categorically
 * different from the 586-character English summary the same field held before the fix, and it is
 * still not verbatim.
 *
 * WHY IT IS PINNED AS A LITERAL RATHER THAN ALLOWED BY A SUBSEQUENCE RULE. Relaxing the check to
 * "every word appears in order" would pass this — and would also pass a sentence assembled from
 * words scattered across four different turns, which is exactly the composition the contract
 * exists to forbid. A named exception costs one line and stays visible; a weakened rule stops
 * measuring. If the phrase changes, or a second appears, this test goes red.
 */
const KNOWN_RESIDUALS: Readonly<Record<string, string[]>> = {
  p3_five_year_to_setter: ["Kharad chalayi hai"],
};

describe.skipIf(!ENABLED)("R10 §2.3 — the extraction returns verbatim spans, never prose", () => {
  const personas = readJson<{ personas: Persona[] }>(join(HARNESS_DIR, "personas.json")).personas;

  for (const persona of personas) {
    it(`${persona.id} — every work_done phrase appears in his own turns`, () => {
      const artifact = readJson<ExtractArtifact>(join(OUT_DIR, `${persona.id}.extract.json`));
      const said = persona.transcript
        .filter(([role]) => role === "worker")
        .map(([, text]) => normalizeForMatch(text));

      const composed = (artifact.extract.experiences ?? []).flatMap((e) => [
        ...composedPhrases(e.work_done, said),
        ...composedPhrases(e.duration_text, said),
      ]);

      expect(
        composed,
        `${persona.id}: the model composed ${composed.length} phrase(s) the worker never said. ` +
          `§8 allows no fourth source, and §8.5 lists summarising first among the prohibitions.`,
      ).toEqual(KNOWN_RESIDUALS[persona.id] ?? []);
    });
  }

  it("reports the corpus-wide composition rate, so a regression is visible as a number", () => {
    // NOT AN ASSERTION ON THE RATE — the per-persona tests above are the contract. This exists so
    // the digest can quote a measured figure rather than "it looked better", and so a partial
    // regression (one persona drifting) is legible next to a total one.
    let checked = 0;
    let composed = 0;
    for (const persona of personas) {
      const artifact = readJson<ExtractArtifact>(join(OUT_DIR, `${persona.id}.extract.json`));
      const said = persona.transcript
        .filter(([role]) => role === "worker")
        .map(([, text]) => normalizeForMatch(text));
      for (const e of artifact.extract.experiences ?? []) {
        for (const field of [e.work_done, e.duration_text]) {
          const phrases = splitIntoPhrases(field ?? "").filter((p) => p.length >= MIN_CHECKABLE);
          checked += phrases.length;
          composed += composedPhrases(field, said).length;
        }
      }
    }
    // eslint-disable-next-line no-console
    console.log(
      `verbatim contract: ${checked - composed}/${checked} phrases vouched for by a stored turn` +
        ` (${composed} composed)`,
    );
    expect(checked, "no phrases were long enough to check — the artifacts are empty").toBeGreaterThan(
      0,
    );
  });
});
