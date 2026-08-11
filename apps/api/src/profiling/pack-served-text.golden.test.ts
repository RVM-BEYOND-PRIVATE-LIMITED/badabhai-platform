import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { QuestionPack, QuestionPackItem } from "@badabhai/ai-contracts";
import { loadQuestionPackCorpus, type PackRecord } from "@badabhai/db";

import { replyClosure } from "./reply-closure";

/**
 * A PUBLISHED PACK VERSION'S SERVED TEXT IS FROZEN. IT MAY NEVER CHANGE WHAT A WORKER HEARS.
 *
 * Owner ruling 2026-08-08, accepting #708 narrowly. The problem it closes:
 *
 *  1. A session PINS `(pack_id, pack_version)` at retrieval and keeps serving that version, so a
 *     worker mid-interview never has the questions change under them. That is deliberate.
 *  2. Publishing a new version must not make the old one's strings stop being rendered.
 *  3. The TTS manifest is built from the corpus. If v1's audio is dropped from the render, every
 *     session still pinned to v1 asks questions with no clip behind them — silently, to workers
 *     who cannot read the screen.
 *
 * KEYED ON `pack_id@version`, AND THAT IS THE CORRECTION THIS FILE CARRIES. It was keyed on
 * `pack_id` alone, which was right while the ruling's own premise held — "the corpus is ONE FILE
 * PER `pack_id`, so publishing v2 means EDITING that file and v1 stops existing". The LATER #708
 * ruling (versioned layout) made that premise false: versions now sit beside each other as
 * `packs/<pack_id>@<version>.json`, `_published-versions.jsonl` is the ledger, and `replyClosure`
 * renders EVERY version on disk — so v1's clips survive v2 by construction.
 *
 * Under `pack_id` keying two coexisting versions collapse into one entry and the LAST one loaded
 * wins, which broke the guard in both directions: publishing a v2 that adds a question looked
 * exactly like editing v1's wording in place, and — the dangerous half — actually editing v1's
 * wording while a v2 existed became INVISIBLE, because v2's hash was what got compared. Keying on
 * the version restores the property the ruling is really about: a version, once published, says
 * the same words forever. Gating (`ask_if`/`skip_if`/`min_turn`/`max_turn`) and `display_order`
 * may still move freely within one — none of them is audible.
 *
 * WHY IT IS A HASH AND NOT A DIFF OF THE STRINGS. The strings themselves already have a reviewable
 * artifact — `reply-closure.json`, which is the render manifest. This file answers a different
 * question, per version: "did THIS version's audible surface change?" A hash per version is what
 * makes that answerable at a glance, and what keeps the failure message pointing at one pack
 * rather than at 433 clips.
 *
 * THE ENUMERATION IS `replyClosure`'S OWN, deliberately, minus the constants that belong to no
 * pack. A second list of "what counts as served" would drift from the one the renderer uses, and
 * the drift would be invisible until a worker met silence — a new producer added there is
 * automatically covered here.
 *
 * TO CHANGE A PACK'S WORDING ON PURPOSE: you do not. Publish a new VERSION beside the old one and
 * leave the old file alone; the new entry appears here with no predecessor to contradict. The
 * regenerate escape hatch exists for the re-keying migration and for a genuinely new pack:
 *   UPDATE_PACK_SERVED_TEXT=1 pnpm --filter @badabhai/api run test pack-served-text.golden
 * then re-render the audio (#701). The diff on this file is the review, and the render is the
 * cost. Neither should be a surprise.
 */

const GOLDEN_PATH = join(
  __dirname,
  "../../../../packages/db/data/question-packs/pack-served-text.json",
);

interface PackEntry {
  /** sha256 over this pack's sorted served strings — see `servedTextSha`. */
  readonly served_text_sha256: string;
  /** How many distinct strings that is, so a collapse to zero is visible in the diff. */
  readonly served_text_count: number;
}

interface GoldenFile {
  readonly schema_version: number;
  readonly pack_count: number;
  readonly packs: Record<string, PackEntry>;
}

function toQuestionPacks(): QuestionPack[] {
  const corpus = loadQuestionPackCorpus();
  return corpus.packs.map((p: PackRecord) => ({
    pack_id: p.pack_id,
    version: p.version,
    family_id: p.family_id,
    locale: p.locale ?? "hi-IN",
    status: (p.status ?? "active") as QuestionPack["status"],
    content_hash: `corpus_${p.pack_id}_${p.version}`,
    items: p.items as unknown as QuestionPackItem[],
  }));
}

/** Every string this pack can put in front of a worker, sorted so item order cannot move it. */
function servedTextOf(pack: QuestionPack): string[] {
  return replyClosure([pack])
    .filter((clip) => clip.producer !== "constant")
    .map((clip) => clip.text)
    .sort();
}

function servedTextSha(texts: readonly string[]): string {
  // Newline-joined with a trailing separator, so ["a\nb"] and ["a", "b"] cannot hash alike.
  return createHash("sha256")
    .update(texts.map((t) => `${t}\n`).join(""))
    .digest("hex");
}

/** `pack_id@version` — the unit a session actually pins, and therefore the unit that is frozen. */
const keyOf = (pack: QuestionPack): string => `${pack.pack_id}@${pack.version}`;

function build(): GoldenFile {
  const packs: Record<string, PackEntry> = {};
  for (const pack of toQuestionPacks()) {
    const texts = servedTextOf(pack);
    packs[keyOf(pack)] = {
      served_text_sha256: servedTextSha(texts),
      served_text_count: texts.length,
    };
  }
  // Key order is stable so a re-generate is a clean diff rather than a reshuffle.
  const sorted: Record<string, PackEntry> = {};
  for (const key of Object.keys(packs).sort()) sorted[key] = packs[key] as PackEntry;
  // SCHEMA 2 IS THE RE-KEYING. Bumped so the one-time migration is legible in the artifact
  // itself rather than looking like 101 packs all changing at once.
  return { schema_version: 2, pack_count: Object.keys(sorted).length, packs: sorted };
}

const serialize = (g: GoldenFile): string => `${JSON.stringify(g, null, 2)}\n`;

describe("a pack version may change gating and ordering, never the served text", () => {
  const built = build();

  it("regenerates BYTE-IDENTICALLY to the committed record", () => {
    if (process.env.UPDATE_PACK_SERVED_TEXT === "1") {
      mkdirSync(dirname(GOLDEN_PATH), { recursive: true });
      writeFileSync(GOLDEN_PATH, serialize(built), "utf8");
      return;
    }
    expect(existsSync(GOLDEN_PATH), `missing ${GOLDEN_PATH}`).toBe(true);
    expect(readFileSync(GOLDEN_PATH, "utf8")).toBe(serialize(built));
  });

  it("names the exact pack whose audible surface moved, and says what that costs", () => {
    // The assertion above already fails on any change; this one exists so the FAILURE is
    // actionable. A byte diff on a 101-entry file does not tell an author that sessions pinned to
    // the previous version are about to meet silence.
    if (process.env.UPDATE_PACK_SERVED_TEXT === "1") return;
    if (!existsSync(GOLDEN_PATH)) return;
    const committed = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as GoldenFile;

    const moved: string[] = [];
    for (const [key, entry] of Object.entries(built.packs)) {
      const before = committed.packs[key];
      // A NEW VERSION has no pinned sessions to strand — that is the whole point of publishing
      // beside the old file instead of over it. Only an EDIT to an already-published version
      // reaches the branch below.
      if (!before) continue;
      if (before.served_text_sha256 === entry.served_text_sha256) continue;
      moved.push(
        `${key}: served text changed in place ` +
          `(${before.served_text_count} -> ${entry.served_text_count} strings). Sessions pinned to ` +
          `this exact version will ask a string the corpus no longer renders audio for. Publish a ` +
          `NEW version beside it instead; a published version may change gating and ordering only.`,
      );
    }
    expect(moved).toEqual([]);
  });

  it("does not lose a version — a removed one strands every session pinned to it", () => {
    if (process.env.UPDATE_PACK_SERVED_TEXT === "1") return;
    if (!existsSync(GOLDEN_PATH)) return;
    const committed = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as GoldenFile;
    const dropped = Object.keys(committed.packs).filter((id) => !(id in built.packs));
    expect(dropped).toEqual([]);
  });

  it("actually enumerated something, so a green run cannot be vacuous", () => {
    // Without this, a loader returning zero packs would make every assertion above pass against
    // an empty record — which is exactly how a guard becomes the most reassuring test in the repo.
    expect(built.pack_count).toBeGreaterThanOrEqual(100);
    const counts = Object.values(built.packs).map((p) => p.served_text_count);
    expect(Math.min(...counts)).toBeGreaterThan(0);
  });
});
