import type { QuestionPack, QuestionPackItem } from "@badabhai/ai-contracts";
import { loadQuestionPackCorpus, type PackRecord } from "@badabhai/db";

/**
 * CORPUS LOADERS FOR DATA-SHAPED TESTS — test-only, never imported by production code.
 *
 * A handful of tests exist to hold properties of the AUTHORED CORPUS rather than of the engine:
 * which questions the tail serves, what the two fill-gap multis capture, in what order. A
 * hand-built two-item pack cannot see any of that, so those tests load the real JSON through
 * `loadQuestionPackCorpus` and map it to the contract's item shape here, once.
 *
 * THE MAPPING IS NOT A CAST. The JSON omits every field it does not need (`parent_item_key`,
 * `ask_if`, `options`, …) and the engine reads them as `null`/`[]` — `PackRepository` does this
 * same mapping when it loads from Postgres. Casting instead makes `item.parent_item_key`
 * `undefined`, which `isServable` compares `!== null` and then treats as a follow-up whose parent
 * is unanswered: EVERY item becomes unservable and a walk closes on turn one with `complete`.
 * That is a silently green test, so the mapping is written out rather than asserted away.
 */
export function toCorpusItem(raw: Record<string, unknown>, displayOrder: number): QuestionPackItem {
  const options = (raw.options as Array<Record<string, unknown>> | undefined) ?? [];
  return {
    question_key: raw.question_key as string,
    prompt_text: raw.prompt_text as string,
    display_order: displayOrder,
    target_kind: (raw.target_kind as QuestionPackItem["target_kind"]) ?? "none",
    target_field: (raw.target_field as string | undefined) ?? null,
    target_skill_id: (raw.target_skill_id as string | undefined) ?? null,
    // The corpus carries three authoring types the contract does not (`city`, `salary`,
    // `duration`); the seed path narrows them the same way. Only `select` matters to selection.
    answer_type: (["city", "salary", "duration"].includes(raw.answer_type as string)
      ? "text"
      : raw.answer_type) as QuestionPackItem["answer_type"],
    is_mandatory: (raw.is_mandatory as boolean | undefined) ?? false,
    is_core: (raw.is_core as boolean | undefined) ?? false,
    max_asks: (raw.max_asks as number | undefined) ?? 2,
    min_turn: (raw.min_turn as number | undefined) ?? null,
    max_turn: (raw.max_turn as number | undefined) ?? null,
    ask_if: (raw.ask_if as QuestionPackItem["ask_if"]) ?? null,
    skip_if: (raw.skip_if as QuestionPackItem["skip_if"]) ?? null,
    parent_item_key: (raw.parent_item_key as string | undefined) ?? null,
    retry_text: (raw.retry_text as string | undefined) ?? null,
    why_text: (raw.why_text as string | undefined) ?? null,
    options: options.map((o) => ({
      option_key: o.option_key as string,
      label_text: o.label_text as string,
      value: (o.value_text ?? o.value_bool ?? null) as QuestionPackItem["options"][number]["value"],
      implies_skill_id: null,
      is_none_of_above: (o.is_none_of_above as boolean | undefined) ?? false,
    })),
  };
}

/** One corpus version of a pack, ready for the engine's own item shape. */
export function corpusPack(packId: string, version: number): QuestionPack {
  const record = loadQuestionPackCorpus().packs.find(
    (p: PackRecord) => p.pack_id === packId && p.version === version,
  );
  if (!record) throw new Error(`${packId}@${version} is not in the corpus`);
  return {
    pack_id: record.pack_id,
    version: record.version,
    family_id: record.family_id,
    locale: record.locale ?? "hi-IN",
    status: (record.status ?? "active") as QuestionPack["status"],
    content_hash: `corpus_${record.pack_id}_${record.version}`,
    items: (record.items as unknown as Array<Record<string, unknown>>).map(toCorpusItem),
  };
}

/** The universal fallback pack at one corpus version. */
export function universalPack(version: number): QuestionPack {
  return corpusPack("qp_universal", version);
}
