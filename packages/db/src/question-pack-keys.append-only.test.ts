import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { loadQuestionPackCorpus, QUESTION_PACK_DATA_DIR } from "./question-pack-corpus";

/**
 * MIDDLE WAY DoD §7.10 — question/option keys are append-only (P6).
 *
 * Renaming a `question_key` or `option_key` silently orphans every stored answer,
 * event payload, resume row and goldens that name the old key — and nothing else
 * fails loudly, because each reader just stops matching. The corpus validator
 * (`question-pack-corpus.test.ts`) checks the SHAPE of every key (slug filter,
 * length, duplicates) but cannot tell a rename from a fresh addition: both look
 * like valid keys.
 *
 * So this test pins the full key VOCABULARY against a committed snapshot. Adding
 * a question or option is a one-line snapshot regen (see below) with a reviewable
 * diff; deleting or renaming one fails here first, before any seed or migration.
 *
 * To regenerate after an intentional ADDITION (never for a rename — add the new
 * key, migrate readers, then remove the old one in a later release):
 *   UPDATE_PACK_KEYS_SNAPSHOT=1 pnpm --filter @badabhai/db exec vitest run src/question-pack-keys.append-only.test.ts
 */
const SNAPSHOT_PATH = join(__dirname, "pack-keys.snapshot.json");

function currentVocabulary(): { questions: string[]; options: string[] } {
  const corpus = loadQuestionPackCorpus(QUESTION_PACK_DATA_DIR);
  const questions = new Set<string>();
  const options = new Set<string>();
  for (const pack of corpus.packs) {
    const packTag = `${pack.pack_id}@${pack.version}`;
    for (const item of pack.items ?? []) {
      questions.add(`${packTag} :: ${item.question_key}`);
      for (const option of item.options ?? []) {
        options.add(`${packTag} :: ${item.question_key} :: ${option.option_key}`);
      }
    }
  }
  return { questions: [...questions].sort(), options: [...options].sort() };
}

describe("question/option keys are append-only (DoD §7.10)", () => {
  it("matches the committed vocabulary snapshot exactly", () => {
    const current = currentVocabulary();
    if (process.env.UPDATE_PACK_KEYS_SNAPSHOT === "1") {
      writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(current, null, 2)}\n`, "utf8");
    }
    const snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")) as typeof current;

    const missingQuestions = snapshot.questions.filter((k) => !current.questions.includes(k));
    const missingOptions = snapshot.options.filter((o) => !current.options.includes(o));
    expect(
      missingQuestions,
      `RENAMED OR DELETED question_keys (add-then-remove across releases, never rename in place):\n${missingQuestions.join("\n")}`,
    ).toEqual([]);
    expect(
      missingOptions,
      `RENAMED OR DELETED option_keys (add-then-remove across releases, never rename in place):\n${missingOptions.join("\n")}`,
    ).toEqual([]);

    // Additions are allowed, but the snapshot must move WITH the code that adds them —
    // a green suite with a stale snapshot would stop guarding the next rename.
    expect(
      current,
      "new keys added without regenerating the snapshot (re-run with UPDATE_PACK_KEYS_SNAPSHOT=1)",
    ).toEqual(snapshot);
  });
});
