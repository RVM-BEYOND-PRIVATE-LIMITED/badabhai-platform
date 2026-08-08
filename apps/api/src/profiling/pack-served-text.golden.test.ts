import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { QuestionPack, QuestionPackItem } from "@badabhai/ai-contracts";
import { loadQuestionPackCorpus, type PackRecord } from "@badabhai/db";

import { replyClosure } from "./reply-closure";

/**
 * A PACK'S v2 MAY CHANGE GATING AND ORDERING. IT MAY NOT CHANGE WHAT A WORKER HEARS.
 *
 * Owner ruling 2026-08-08, accepting #708 narrowly. The problem it closes:
 *
 *  1. A session PINS `(pack_id, pack_version)` at retrieval and keeps serving that version, so a
 *     worker mid-interview never has the questions change under them. That is deliberate.
 *  2. The corpus is ONE FILE PER `pack_id`. Publishing v2 means EDITING that file — v1 stops
 *     existing.
 *  3. The TTS manifest is built from the corpus. So v1's audio is dropped from the render the
 *     moment v2 lands, and every session still pinned to v1 asks questions with no clip behind
 *     them — silently, to workers who cannot read the screen.
 *
 * The ruling makes (3) impossible rather than detectable: if the served STRINGS never change
 * across a version bump, the pinned v1 and the rendered v2 say the same words, and the clip a v1
 * session resolves is the clip v2 rendered. Gating (`ask_if`/`skip_if`/`min_turn`/`max_turn`) and
 * `display_order` may move freely — none of them is audible.
 *
 * WHY IT IS A HASH AND NOT A DIFF OF THE STRINGS. The strings themselves already have a reviewable
 * artifact — `reply-closure.json`, which is the render manifest. This file answers a different
 * question, per pack: "did THIS pack's audible surface change?" A hash per pack is what makes that
 * question answerable at a glance, and what keeps the failure message pointing at one pack rather
 * than at 433 clips.
 *
 * THE ENUMERATION IS `replyClosure`'S OWN, deliberately, minus the constants that belong to no
 * pack. A second list of "what counts as served" would drift from the one the renderer uses, and
 * the drift would be invisible until a worker met silence — a new producer added there is
 * automatically covered here.
 *
 * TO CHANGE A PACK'S WORDING ON PURPOSE:
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

function build(): GoldenFile {
  const packs: Record<string, PackEntry> = {};
  for (const pack of toQuestionPacks()) {
    const texts = servedTextOf(pack);
    packs[pack.pack_id] = {
      served_text_sha256: servedTextSha(texts),
      served_text_count: texts.length,
    };
  }
  // Key order is stable so a re-generate is a clean diff rather than a reshuffle.
  const sorted: Record<string, PackEntry> = {};
  for (const key of Object.keys(packs).sort()) sorted[key] = packs[key] as PackEntry;
  return { schema_version: 1, pack_count: Object.keys(sorted).length, packs: sorted };
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
    const versionOf = new Map(toQuestionPacks().map((p) => [p.pack_id, p.version]));
    for (const [packId, entry] of Object.entries(built.packs)) {
      const before = committed.packs[packId];
      if (!before) continue; // a NEW pack has no pinned sessions to strand.
      if (before.served_text_sha256 === entry.served_text_sha256) continue;
      moved.push(
        `${packId} (now v${versionOf.get(packId)}): served text changed ` +
          `(${before.served_text_count} -> ${entry.served_text_count} strings). A session pinned ` +
          `to the previous version will ask a string this corpus no longer renders audio for. ` +
          `A version bump may change gating and ordering only.`,
      );
    }
    expect(moved).toEqual([]);
  });

  it("does not lose a pack — a removed pack_id strands every session pinned to it", () => {
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
