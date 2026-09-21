import { readFileSync } from "node:fs";
import { join } from "node:path";

import { QuestionPackSchema, type QuestionPack } from "@badabhai/ai-contracts";

import { computeContentHash } from "../pack-cache.constants";

/**
 * The shipped question-pack corpus, loaded the way a live request would hold it.
 *
 * TEST SUPPORT ONLY — imported by the form suites, never by production code. It exists because
 * three suites need the REAL packs (#1503): a fixture pack cannot carry the property a regression
 * turns on, and `f455bb36` shipped past two suites precisely because both stubbed the universal
 * pack to `null` and never saw what appending it did.
 */

/** Anchored to this file rather than `process.cwd()`, like `role-corpus-parity.guard.test.ts`. */
export const PACK_DIR = join(__dirname, "../../../../../packages/db/data/question-packs/packs");

/** The universal pack's file — the one `f455bb36` appended to every trade form. */
export const UNIVERSAL_PACK_FILE = "qp_universal@2";

/**
 * `pack-registry.service.ts`'s `ANSWER_TYPE_ALIASES`, restated.
 *
 * RESTATED RATHER THAN IMPORTED, because importing the registry service pulls the config module
 * into a pure test. DRIFT IS LOUD, NOT SILENT: `QuestionPackSchema.parse` below rejects any raw
 * `answer_type` outside the contract's five, so a new database-only type that this map lacks
 * throws here instead of producing a pack production would never serve.
 */
const ANSWER_TYPE_ALIASES: Readonly<Record<string, string>> = {
  city: "text",
  salary: "number",
  duration: "number",
};

interface CorpusOption {
  readonly option_key: string;
  readonly label_text: string;
  readonly value_text?: string;
  readonly value_number?: number;
  readonly value_bool?: boolean;
}

interface CorpusItem {
  readonly question_key: string;
  readonly answer_type: string;
  readonly options?: readonly CorpusOption[];
}

interface CorpusPack {
  readonly pack_id: string;
  readonly family_id: string;
  readonly status: string;
  readonly items: readonly CorpusItem[];
}

/** The raw JSON of one corpus file, unparsed — for assertions that must not trust the loader. */
export function rawCorpusPack(file: string): CorpusPack {
  return JSON.parse(readFileSync(join(PACK_DIR, `${file}.json`), "utf8")) as CorpusPack;
}

/**
 * A corpus file → the `QuestionPack` a live request would hold.
 *
 * THE ROUND TRIP IS REPRODUCED, NOT APPROXIMATED. `pack-registry.service.toOption` reads one
 * contract `value` back out of three typed columns as `valueText ?? valueNumber ?? valueBool`, and
 * `toItem` folds `city`/`salary`/`duration` through the alias map. A loader that skipped either
 * would test a shape production never serves. `display_order` is the item's index, as the seeder
 * assigns it.
 */
export function packFromCorpus(file: string): QuestionPack {
  const raw = rawCorpusPack(file);
  const items = raw.items.map((item, index) => ({
    ...item,
    display_order: index,
    answer_type: ANSWER_TYPE_ALIASES[item.answer_type] ?? item.answer_type,
    options: (item.options ?? []).map((option) => ({
      ...option,
      // `??`, never a truthiness chain: `value_number: 0` is the fresher rung on every ladder and
      // `value_bool: false` is a real answer.
      value: option.value_text ?? option.value_number ?? option.value_bool ?? null,
    })),
  }));
  return QuestionPackSchema.parse({ ...raw, content_hash: computeContentHash(items), items });
}
