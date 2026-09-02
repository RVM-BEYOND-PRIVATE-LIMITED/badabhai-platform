import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { TRADE_RESUME_MAPS } from "../../resume/trade-resume-map";
import { ENABLED_ROLE_DESCRIPTORS, ROLE_FORM_DESCRIPTORS } from "./role-registry";

/**
 * EVERY ENABLED ROLE IS CHECKED AGAINST THE PACK IT CLAIMS — the guard the twenty-role rollout
 * needs and did not have.
 *
 * ═══ THE FAILURE THIS EXISTS FOR ═══
 *
 * A descriptor names three things that live in a different repository layer entirely: a `packId`
 * in the JSON corpus, a `tenureQuestionKey` inside that pack, and (through the résumé map) a set
 * of `capability[].from` keys inside it too. Nothing type-checks any of them — they are strings on
 * one side and JSON on the other — so every one is a silent failure with a different symptom:
 *
 *   packId wrong           → 503 at the first worker routed to that form, reported to them as
 *                            "aapke liye koi form taiyaar nahi kiya gaya hai" — their own lack of
 *                            entitlement, for our typo. This exact shape hit `qp_cnc_turner`.
 *   tenureQuestionKey wrong → the gate is never hoisted to the front, so the depth questions it
 *                            gates stay unresolved-and-therefore-visible, and the headline's
 *                            years figure silently loses its fallback (#1377).
 *   capability `from` wrong → the row is simply absent from the sheet. The form still asks the
 *                            question and the answer is still stored; it just never prints, which
 *                            is the one failure a worker cannot report because they never see it.
 *
 * ═══ WHY IT IS WORTH ITS OWN FILE AT TWO ROLES ═══
 *
 * At two roles this could be read off by eye. At twenty-one it cannot, and the point of writing it
 * NOW is that every role added after this one is checked on the commit that adds it rather than on
 * the commit that notices. `role-registry.test.ts` covers the registry's INTERNAL coherence — no
 * duplicate ids, no self-veto — which is a property of the descriptors alone. This covers the
 * seam between the descriptors and the data, which is where the rollout's mistakes will actually
 * live.
 *
 * READS THE REAL CORPUS, never a fixture. A fixture would have to be kept in step with the packs,
 * which is the same class of drift one layer down.
 */

const PACK_DIR = join(__dirname, "../../../../../packages/db/data/question-packs/packs");

interface CorpusPack {
  pack_id: string;
  version: number;
  family_id: string;
  items: { question_key: string; answer_type: string; options?: unknown[] }[];
}

function loadPack(packId: string): CorpusPack {
  return JSON.parse(readFileSync(join(PACK_DIR, `${packId}.json`), "utf8")) as CorpusPack;
}

describe("every enabled role agrees with the pack corpus", () => {
  it("has at least one enabled role, so the table below is never vacuously empty", () => {
    // `it.each` over an empty array passes silently. This is the assertion that makes every
    // per-role check below evidence rather than an absence of evidence.
    expect(ENABLED_ROLE_DESCRIPTORS.length).toBeGreaterThan(0);
  });

  it.each(ENABLED_ROLE_DESCRIPTORS.map((d) => [d.kind, d] as const))("%s", (_kind, descriptor) => {
    const pack = loadPack(descriptor.packId);

    // The pack file is named for the id it declares, and belongs to the family the descriptor
    // routes through. `packFor` looks the pack up BY FAMILY, so a descriptor whose familyId
    // disagrees with its packId resolves to somebody else's questions.
    expect(pack.pack_id, "the pack file declares a different pack_id").toBe(descriptor.packId);
    expect(pack.family_id, "the pack belongs to a different family").toBe(descriptor.familyId);

    // The tier gate must exist, and must be a SELECT — `isFormQuestionVisible` compares its
    // stored value with `gte`/`lte`, and a free-text answer has no number to compare.
    const gate = pack.items.find((i) => i.question_key === descriptor.tenureQuestionKey);
    expect(
      gate,
      `tenureQuestionKey ${descriptor.tenureQuestionKey} is not in ${pack.pack_id}`,
    ).toBeDefined();
    expect(gate!.answer_type).toBe("single_select");
  });

  it.each(ENABLED_ROLE_DESCRIPTORS.map((d) => [d.kind, d] as const))(
    "%s — every sheet row names a question the pack actually asks",
    (_kind, descriptor) => {
      const pack = loadPack(descriptor.packId);
      const keys = new Set(pack.items.map((i) => i.question_key));
      const map = TRADE_RESUME_MAPS.find((m) => m.pack_id === descriptor.packId);

      // An enabled role with no résumé map renders a sheet with an empty capability section —
      // the form asks eighteen questions and prints none of the answers.
      expect(map, `no résumé map for ${descriptor.packId}`).toBeDefined();

      const orphans = map!.capability.map((row) => row.from).filter((from) => !keys.has(from));
      expect(orphans, `sheet rows with no question behind them in ${pack.pack_id}`).toEqual([]);
    },
  );

  it("the tier gate carries value_number and never value_text — the #776 trap", () => {
    // THE TRAP THE AUTHORING GUIDE NAMES AND THE CORPUS VALIDATOR DOES NOT CATCH. `gte`/`lte`
    // compare numbers; an option that carries `value_text` instead makes every gate in the pack
    // evaluate false FOREVER, silently. On the interview that means the depth questions are never
    // asked; on the form it means `isFormQuestionVisible` shows them all, which looks like the
    // form working. Nothing anywhere reports it.
    for (const descriptor of ENABLED_ROLE_DESCRIPTORS) {
      const pack = loadPack(descriptor.packId);
      const gate = pack.items.find((i) => i.question_key === descriptor.tenureQuestionKey);
      const options = (gate?.options ?? []) as { value_number?: unknown; value_text?: unknown }[];
      expect(options.length, `${descriptor.kind}: the tier gate offers no options`).toBeGreaterThan(
        1,
      );
      for (const option of options) {
        expect(
          typeof option.value_number,
          `${descriptor.kind}: a tier-gate option has no value_number`,
        ).toBe("number");
        expect(
          option.value_text,
          `${descriptor.kind}: a tier-gate option carries value_text, which kills every gate`,
        ).toBeUndefined();
      }
    }
  });

  it("no DECLARED role claims a pack that another role already owns", () => {
    // `assertRegistryIsCoherent` rejects duplicate `packId`s among descriptors. This is the other
    // direction: it also has to hold across the ROLES THAT ARE NOT YET ENABLED, because a
    // disabled role pointing at a shipped pack would start serving somebody else's questions the
    // moment its flag flips — a one-line change reviewed as "just enabling a role".
    const byPack = new Map<string, string[]>();
    for (const d of ROLE_FORM_DESCRIPTORS) {
      byPack.set(d.packId, [...(byPack.get(d.packId) ?? []), d.kind]);
    }
    const shared = [...byPack.entries()].filter(([, kinds]) => kinds.length > 1);
    expect(shared).toEqual([]);
  });
});
