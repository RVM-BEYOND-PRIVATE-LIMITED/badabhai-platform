import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  corpusSkillsForPackAttributes,
  PACK_ATTRIBUTE_SKILLS,
} from "../match/pack-attribute-skills";
import { buildFresherRows } from "./resume-fresher-rows";
import { applyTranscriptVeto, CAPABILITY_TERMS } from "./resume-transcript-veto";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * NO TRADE'S DICTIONARY MAY REACH ANOTHER TRADE'S WORKER (R12 §2.3).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * THE CLASS THIS GUARDS, not the three instances. `TRADE_RESUME_MAPS` was pack-keyed from the
 * start; three other dictionaries carrying turner vocabulary were keyed by ATTRIBUTE NAME alone,
 * so they applied to any worker whose bag happened to hold that key. That is 143 lines of trade
 * content — about 5% of the trade-specific volume and 100% of its risk surface, because it is
 * the only part that can be applied to the WRONG worker.
 *
 * A per-instance test would have been three assertions that the three known dictionaries are
 * scoped. This drives the check from the SHIPPED PACK CORPUS instead: every pack, every question,
 * every option, fed through every module. A fourth dictionary added later without scoping, or a
 * new pack that reuses a turner attribute key, fails here without anybody remembering to add a
 * case — which is the only kind of guard that survives the packet that wrote it.
 *
 * THE COLLISION IS REAL AND MEASURED, so this is not a hypothetical class. Across all 143 packs
 * today: `drawing_reading` is in three, `measuring_tools` in two, `material_worked` in two. And
 * a milling pack — the next one on the roadmap — shares far more attribute names with turning
 * than `qp_machining` does.
 *
 * WHAT THIS DELIBERATELY DOES NOT ASSERT: that the turner's own dictionary is CORRECT. That is
 * `trade-resume-map.test.ts`, `resume-transcript-veto.test.ts` and the RVM redline. This asserts
 * only that it stays the turner's.
 */

const PACK_DIR = join(__dirname, "../../../../packages/db/data/question-packs/packs");

interface PackItem {
  question_key: string;
  answer_type?: string;
  options?: { option_key: string }[] | null;
}
interface Pack {
  pack_id: string;
  items: PackItem[];
}

/** Every shipped pack, deduped by `pack_id` (versions sit beside each other as separate files). */
function loadPacks(): Pack[] {
  const byId = new Map<string, Pack>();
  for (const file of readdirSync(PACK_DIR).filter((f) => f.endsWith(".json"))) {
    const pack = JSON.parse(readFileSync(join(PACK_DIR, file), "utf8")) as Pack;
    // Later versions of a pack carry the same id and the same question keys; one entry per id is
    // enough, and taking the first keeps the iteration deterministic.
    if (!byId.has(pack.pack_id)) byId.set(pack.pack_id, pack);
  }
  return [...byId.values()];
}

const PACKS = loadPacks();

/** A worker who answered EVERY option of EVERY question in one pack — the maximal probe. */
function everyAnswer(pack: Pack): Record<string, string[]> {
  const bag: Record<string, string[]> = {};
  for (const item of pack.items) {
    const keys = (item.options ?? []).map((o) => o.option_key);
    if (keys.length > 0) bag[item.question_key] = keys;
  }
  return bag;
}

describe("R12 §2.3 — a trade dictionary is reachable ONLY from its own pack", () => {
  it("the corpus actually contains the collisions this guard exists for", () => {
    // THE FIXTURE MUST CONTAIN THE THING THE DETECTOR DETECTS (R12 §0). Both HIGH findings of
    // the R8 re-verification were tools validated against data that lacked what they looked for
    // — the discarded-interview query was checked against three workers, none of them
    // discarded. So before asserting that nothing collides, assert that something COULD.
    //
    // THIS ASSERTION CORRECTED THE R11 REPORT ON ITS FIRST RUN. That report named three
    // colliding keys — `drawing_reading`, `measuring_tools`, `material_worked` — against "the
    // dictionaries" as a group. Per dictionary the truth is narrower, and the difference matters
    // because it is what each one can actually reach:
    //     CAPABILITY_TERMS (veto)      drawing_reading only
    //     PACK_ATTRIBUTE_SKILLS (reach) drawing_reading + measuring_tools
    //     WORKSHOP_MACHINES (fresher)   nothing — its two keys are turner-only
    // `material_worked` collides with `qp_welding` in the CORPUS but appears in no dictionary,
    // so it was never reachable. Characterising a set instead of computing it, again.
    //
    // ── AND THEN MILLING LANDED (R13 §3.1) ────────────────────────────────────────────────
    //
    // `qp_vmc_milling` shares TEN attribute names with the turner, and the veto gazetteer's
    // collision set went from one key to five. The scoping change was made in R12 on the
    // strength of a single live collision that did nothing; one pack later it governs four
    // more, every one of them a real behaviour dictionary applied to a real worker.
    //
    // Read the growth as the measurement it is: this is what "the trade's vocabulary escaped
    // the map" would have cost had the second entry been written before R12 §2. Nothing here
    // is a milling defect — the numbers are larger and the guard holds.
    const collisionsFor = (owned: Set<string>) =>
      [
        ...new Set(
          PACKS.filter((p) => p.pack_id !== "qp_cnc_turning").flatMap((p) =>
            p.items.map((i) => i.question_key).filter((k) => owned.has(k)),
          ),
        ),
      ].sort();

    expect(
      collisionsFor(new Set(Object.keys(CAPABILITY_TERMS.qp_cnc_turning ?? {}))),
      "the veto gazetteer shares no key with another pack — this guard would pass vacuously",
    ).toEqual([
      "drawing_reading",
      "programming_level",
      "quality_work",
      "setting_operation",
      "troubleshooting",
    ]);

    expect(
      collisionsFor(new Set(Object.keys(PACK_ATTRIBUTE_SKILLS.qp_cnc_turning ?? {}))),
      "the reach map shares no key with another pack — this guard would pass vacuously",
    ).toEqual([
      "controller_brand",
      "drawing_reading",
      "measuring_tools",
      "programming_level",
      "setting_operation",
      "workholding",
    ]);
  });

  it.each(PACKS.map((p) => p.pack_id))(
    "the transcript veto withdraws nothing from a %s worker",
    (packId) => {
      const owner = Object.keys(CAPABILITY_TERMS).includes(packId);
      // A transcript that denies EVERYTHING, so the only reason a veto does not fire is scoping.
      const said = [
        "Nahi sir, setting nahi karta.",
        "Naya programme nahi likhta.",
        "Drawing dekha hai par padhta nahi.",
        "Quality checking nahi karta.",
        "Troubleshoot nahi kar pata.",
      ];
      const pack = PACKS.find((p) => p.pack_id === packId)!;
      const { vetoes } = applyTranscriptVeto({
        packId,
        attributes: everyAnswer(pack),
        workerSaid: said,
      });
      if (owner) {
        // The owner's own pack MUST still be vetoable, or scoping has turned the feature off —
        // the failure mode a "does it stay quiet" test alone would call a pass.
        expect(vetoes.length, `${packId} owns a gazetteer but nothing vetoed`).toBeGreaterThan(0);
      } else {
        expect(
          vetoes.map((v) => `${v.attributeKey}.${v.slug}`),
          `${packId} is not the author of any gazetteer, so nothing may be withdrawn from its worker`,
        ).toEqual([]);
      }
    },
  );

  it.each(PACKS.map((p) => p.pack_id))("the fresher block is empty for a %s worker", (packId) => {
    const pack = PACKS.find((p) => p.pack_id === packId)!;
    const rows = buildFresherRows(packId, everyAnswer(pack));
    if (packId === "qp_cnc_turning") {
      expect(rows.length, "the turner's own fresher block must still build").toBe(1);
    } else {
      expect(rows, `${packId} has no authored fresher vocabulary`).toEqual([]);
    }
  });

  it.each(PACKS.map((p) => p.pack_id))("match reach is empty for a %s worker", (packId) => {
    const pack = PACKS.find((p) => p.pack_id === packId)!;
    const answers = Object.entries(everyAnswer(pack)).map(([attributeKey, optionKeys]) => ({
      packId,
      attributeKey,
      optionKeys,
    }));
    const skills = corpusSkillsForPackAttributes(answers);
    if (Object.keys(PACK_ATTRIBUTE_SKILLS).includes(packId)) {
      expect(skills.length, `${packId} owns a skill map but derived nothing`).toBeGreaterThan(0);
    } else {
      expect(skills, `${packId} is not the author of any skill map`).toEqual([]);
    }
  });

  it("A HYPOTHETICAL PACK THAT REUSES EVERY TURNER KEY still reaches nothing", () => {
    // THE PROBE THE CORPUS CANNOT PROVIDE TODAY, AND ITS ABSENCE WAS A REAL HOLE.
    //
    // Removing the veto's scoping and re-running the corpus-driven cases above left them GREEN.
    // The reason is the §0 sub-pattern in person: `drawing_reading` is the veto gazetteer's only
    // colliding key, it is `boolean` in `qp_machining` and `qp_toolmaking`, and a boolean answer
    // yields `[]` from `slugsOf` — so no shipped pack can currently supply a value that reaches
    // the gazetteer at all. The probe could not express the thing the guard detects, and a
    // deliberately broken build passed it.
    //
    // So this case supplies what the corpus cannot: a pack that reuses EVERY turner attribute
    // key with turner-shaped values. That is not a contrivance — it is the milling pack, which
    // §1.1's estimate says will naturally reuse six of the turner's fourteen keys, arriving a
    // packet early as a test fixture. This is the case that goes red when the scoping is
    // removed, and it names the attribute when it does.
    const turnerKeys = {
      ...CAPABILITY_TERMS.qp_cnc_turning,
    };
    const bag: Record<string, string[]> = {};
    for (const [attributeKey, spec] of Object.entries(turnerKeys)) {
      bag[attributeKey] = Object.keys(spec.slugs);
    }
    // Every turner slug, claimed, and a transcript denying all of it.
    const { attributes, vetoes } = applyTranscriptVeto({
      packId: "qp_hypothetical_milling",
      attributes: bag,
      workerSaid: [
        "Nahi sir, setting nahi karta.",
        "Naya programme nahi likhta.",
        "Drawing dekha hai par padhta nahi.",
        "Quality checking nahi karta.",
        "Troubleshoot nahi kar pata.",
      ],
    });
    expect(
      vetoes.map((v) => `${v.attributeKey}.${v.slug}`),
      "a turner's gazetteer withdrew a claim from a worker who never answered the turner pack",
    ).toEqual([]);
    // The attribute map must come back UNTOUCHED, not merely un-vetoed — an identity check, so a
    // silent rewrite that happens to withdraw nothing still fails.
    expect(attributes).toBe(bag);

    // The same hypothetical pack against the other two dictionaries.
    expect(
      buildFresherRows("qp_hypothetical_milling", {
        iti_workshop_machines: ["conventional_lathe", "milling"],
        trade_test_status: "passed",
      }),
    ).toEqual([]);
    expect(
      corpusSkillsForPackAttributes(
        Object.entries(PACK_ATTRIBUTE_SKILLS.qp_cnc_turning ?? {}).map(([attributeKey, opts]) => ({
          packId: "qp_hypothetical_milling",
          attributeKey,
          optionKeys: Object.keys(opts),
        })),
      ),
      "a turner's reach map gave skills to a worker who never answered the turner pack",
    ).toEqual([]);
  });

  it("a null pack — a worker whose answers came only from the finishing form — reaches nothing", () => {
    // The form writes `worker_attributes` rows with no `pack_id`. Those keys are all
    // trade-independent, so no dictionary here should cover them; asserted rather than assumed,
    // because "no dictionary covers it" is exactly the kind of claim that stops being true.
    const bag = everyAnswer(PACKS.find((p) => p.pack_id === "qp_cnc_turning")!);
    expect(
      applyTranscriptVeto({ packId: null, attributes: bag, workerSaid: ["Nahi karta"] }).vetoes,
    ).toEqual([]);
    expect(buildFresherRows(null, bag)).toEqual([]);
    expect(
      corpusSkillsForPackAttributes(
        Object.entries(bag).map(([attributeKey, optionKeys]) => ({
          packId: null,
          attributeKey,
          optionKeys,
        })),
      ),
    ).toEqual([]);
  });

  it("every dictionary's outer key is a pack that actually ships", () => {
    // The other direction. A dictionary keyed on a pack id that does not exist is scoped to
    // nothing at all — silently dead rather than silently over-reaching, and just as invisible.
    const shipped = new Set(PACKS.map((p) => p.pack_id));
    for (const packId of Object.keys(CAPABILITY_TERMS)) expect(shipped).toContain(packId);
    for (const packId of Object.keys(PACK_ATTRIBUTE_SKILLS)) expect(shipped).toContain(packId);
  });
});
