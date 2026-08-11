import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { WorkerProfileDraftSchema } from "@badabhai/ai-contracts";
import type { QuestionPackItem } from "@badabhai/ai-contracts";

import { PackRegistryService } from "./pack-registry.service";
import { fakePackCache } from "./pack-cache.fake";
import type { PackHeadRow, PackItemRow, PackOptionRow } from "./pack.repository";
import { captureAnswer } from "./answer-capture";
import { recordAnswer } from "./answer-map";
import { projectProfile } from "./answer-map-projector";

/**
 * A CHIP'S TYPED VALUE MUST SURVIVE THE ROW → CONTRACT HOP.
 *
 * `question_pack_options` has three typed value columns precisely so an authored chip can say
 * "this one means the boolean true" rather than "this one means the five characters t-r-u-e". The
 * row → object mapper collapsed all three with `String(...)`, so `value_bool: true` reached the
 * engine as the STRING `"true"` — and every layer downstream decides what to do by looking at the
 * value's SHAPE.
 *
 * Four options across the shipped corpus carry `value_bool` (`relocation` in `qp_universal`,
 * `welding_position` in `qp_welding`), and the two of them cover both destinations, so this is not
 * a hypothetical:
 *
 *  - the review screen renders the worker's own answer as `true` instead of `Haan`;
 *  - the attribute lands in `worker_attributes.value_text` instead of `value_bool`, and the
 *    matcher's own inventory query — `attribute_key = ? AND value_bool` — can never see it;
 *  - `relocation_willingness` is `z.boolean()` on the draft, so `WorkerProfileDraftSchema.parse`
 *    THROWS on a worker who tapped "Haan, jaa sakta hoon". That happens in the extraction
 *    processor, long after the worker was told their interview was complete.
 */

const NOW = 1_700_000_000_000;

function optionRow(over: Partial<PackOptionRow> & { optionKey: string }): PackOptionRow {
  return {
    itemId: "item_relocation",
    displayOrder: 0,
    labelText: over.optionKey,
    valueText: null,
    valueNumber: null,
    valueBool: null,
    impliesSkillId: null,
    isNoneOfAbove: false,
    ...over,
  };
}

/**
 * The shipped `qp_universal` `relocation` item, reproduced as the rows the database holds.
 *
 * All three chips are `value_bool` since #731: `maybe` carried `value_text: "conditional"` against
 * a `boolean` field, which capture refused, so the worker tapped it and the profile recorded
 * nothing. Keeping this fixture faithful is the whole point of it — the string case it used to
 * supply for free is now covered deliberately, below.
 */
const RELOCATION_OPTIONS: PackOptionRow[] = [
  optionRow({ optionKey: "yes", labelText: "Haan, jaa sakta hoon", valueBool: true }),
  optionRow({ optionKey: "no", labelText: "Nahi, yahi rehna hai", valueBool: false }),
  optionRow({
    optionKey: "maybe",
    labelText: "Sahi kaam mile to soch sakta hoon",
    valueBool: true,
  }),
];

function registryServing(options: PackOptionRow[], over: Partial<PackItemRow> = {}) {
  const head: PackHeadRow = {
    packId: "qp_universal",
    version: 1,
    familyId: "fam_universal",
    locale: "hi-IN",
    contentHash: null,
  };
  const item: PackItemRow = {
    itemId: "item_relocation",
    questionKey: "relocation",
    displayOrder: 0,
    promptText: "Kya aap doosre sheher jaa sakte hain?",
    whyText: null,
    retryText: null,
    targetKind: "rfs",
    targetField: "relocation_willingness",
    targetSkillId: null,
    answerType: "single_select",
    isMandatory: false,
    isCore: false,
    maxAsks: 1,
    minTurn: null,
    maxTurn: null,
    askIf: null,
    skipIf: null,
    parentItemKey: null,
    ...over,
  };
  const repo = {
    findBindings: vi.fn(async () => [
      { familyId: "fam_universal", specificity: 0, isUniversal: true },
    ]),
    findActivePacks: vi.fn(async () => [head]),
    findPackHead: vi.fn(async () => head),
    findItems: vi.fn(async () => [item]),
    findOptions: vi.fn(async () => options),
  };
  return new PackRegistryService(
    { PROFILING_PACK_LOCALE: "hi-IN" } as never,
    repo as never,
    fakePackCache().cache,
  );
}

async function relocationItem(): Promise<QuestionPackItem> {
  const registry = registryServing(RELOCATION_OPTIONS);
  const pack = await registry.loadUniversal(NOW);
  const item = pack?.items.find((candidate) => candidate.question_key === "relocation");
  if (!item) throw new Error("the fixture pack served no relocation item");
  return item;
}

describe("a chip's typed value survives the row → contract hop", () => {
  it("keeps a boolean boolean instead of stringifying it", async () => {
    const item = await relocationItem();
    const byKey = new Map(item.options.map((option) => [option.option_key, option.value]));

    expect(byKey.get("yes")).toBe(true);
    // `false` is the one that a `?? label` fallback would silently swallow, so it is asserted
    // separately rather than trusted to travel with its opposite.
    expect(byKey.get("no")).toBe(false);
    // Since #731 the third chip is a boolean too, and it must not arrive as the string "true".
    expect(byKey.get("maybe")).toBe(true);
  });

  it("keeps a TEXT value text — the mapper must not coerce the other way", async () => {
    // Synthetic, and it has to be: #731 left the shipped corpus with no `value_text` chip on a
    // relocation-shaped item to borrow. The mapper is shared by every pack, so losing the string
    // case with the corpus edit that removed it would quietly halve what this file checks — a
    // `String(...)` collapse and a `Boolean(...)` collapse are different mutations.
    const registry = registryServing(
      [
        optionRow({ itemId: "item_shift", optionKey: "day", labelText: "Din", valueText: "day" }),
        optionRow({
          itemId: "item_shift",
          optionKey: "night",
          labelText: "Raat",
          valueText: "night",
        }),
      ],
      {
        itemId: "item_shift",
        questionKey: "shift_preference",
        targetKind: "attribute",
        targetField: "shift_preference",
      },
    );
    const item = (await registry.loadUniversal(NOW))?.items[0];
    if (!item) throw new Error("the fixture pack served no item");

    const byKey = new Map(item.options.map((option) => [option.option_key, option.value]));
    expect(byKey.get("day")).toBe("day");
    expect(byKey.get("night")).toBe("night");
  });

  it("captures the tapped chip as a boolean, which is what the review renders from", async () => {
    const item = await relocationItem();
    // The label is what `ProfilingSessionService.textFor` sends: the client taps a KEY and the
    // server resolves the worker's answer of record.
    const capture = captureAnswer("Haan, jaa sakta hoon", item);

    expect(capture.values).toHaveLength(1);
    expect(capture.values[0]?.valueNormalized).toBe(true);
  });

  it("builds a draft the schema accepts — the parse that used to throw in the queue", async () => {
    const item = await relocationItem();
    const capture = captureAnswer("Haan, jaa sakta hoon", item);
    let map = {};
    for (const value of capture.values) map = recordAnswer(map, value, 1);

    const projection = projectProfile(Object.values(map));
    const relocation = projection.draft.relocation_willingness?.value;

    expect(relocation).toBe(true);
    // The exact call `buildDraft` makes in the extraction processor. A string here is a ZodError
    // in a background job, on a worker who has already been told the interview is done.
    expect(() =>
      WorkerProfileDraftSchema.parse({ relocation_willingness: relocation ?? null }),
    ).not.toThrow();
  });

  it("routes an attribute chip to value_bool, where the matcher looks", async () => {
    // The shipped `qp_welding` `welding_position` item: same typed-boolean chips, the OTHER
    // destination. The projector tells the two apart by asking the crosswalk, so the target field
    // is what decides and this has to be a genuine attribute item rather than a re-labelled one.
    const registry = registryServing(
      [
        optionRow({ itemId: "item_wp", optionKey: "yes", labelText: "Haan", valueBool: true }),
        optionRow({ itemId: "item_wp", optionKey: "no", labelText: "Nahi", valueBool: false }),
      ],
      {
        itemId: "item_wp",
        questionKey: "welding_position",
        targetKind: "attribute",
        targetField: "welding_position",
      },
    );
    const item = (await registry.loadUniversal(NOW))?.items[0];
    if (!item) throw new Error("the fixture pack served no item");

    const capture = captureAnswer("Haan", item);
    let map = {};
    for (const value of capture.values) map = recordAnswer(map, value, 1);

    expect(projectProfile(Object.values(map)).attributes).toEqual([
      expect.objectContaining({
        attributeKey: "welding_position",
        valueKind: "boolean",
        value: true,
      }),
    ]);
  });
});
