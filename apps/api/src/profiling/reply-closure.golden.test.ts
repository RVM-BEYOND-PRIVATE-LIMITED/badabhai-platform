import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { QuestionPack, QuestionPackItem } from "@badabhai/ai-contracts";
import { loadQuestionPackCorpus, type PackRecord } from "@badabhai/db";

import { checkedReplyClosure, type ReplyClip } from "./reply-closure";

/**
 * THE CLOSURE, OVER THE REAL 466-ITEM CORPUS — committed as a golden artifact.
 *
 * WHY THIS FILE EXISTS. `reply-closure.test.ts` beside it proves the closure's RULES on two
 * hand-built items. Nothing ran it over the actual packs, so the number the plan quotes — 433
 * clips — was asserted by nothing, and `replyClosure` had zero callers outside that unit suite. An
 * enumeration with no consumer and no committed output is a claim, not a fact.
 *
 * WHAT THE ARTIFACT IS FOR. It is the render manifest: `tts_render.py` reads it, spends real money
 * per clip, and the resulting audio ships inside the APK. So it must be REVIEWABLE — a diff on this
 * file is the diff on what a worker will hear, and on what the render will cost. Deriving it at
 * render time instead would make both invisible until after the spend.
 *
 * THE FILE IS CANONICAL; `apps/ai-service/app/tts_data/` holds a byte-identical MIRROR, because the
 * ai-service image is built from the `apps/ai-service` context alone and `packages/` does not exist
 * at runtime in that container. Same arrangement, and the same reasoning, as the profiling lexicon.
 * Both sides check it: this file from TS, `test_reply_closure_parity.py` from Python.
 *
 * TO REGENERATE after a corpus or wording change:
 *   UPDATE_REPLY_CLOSURE=1 pnpm --filter @badabhai/api run test reply-closure.golden
 * then copy the file to the mirror (the mirror test names the exact command).
 */

const GOLDEN_PATH = join(
  __dirname,
  "../../../../packages/db/data/question-packs/reply-closure.json",
);
const MIRROR_PATH = join(__dirname, "../../../ai-service/app/tts_data/reply-closure.json");

/** The corpus row shape → the contract shape `replyClosure` consumes. */
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

interface GoldenFile {
  /** Bumped only when the SHAPE changes, never when the corpus does. */
  schema_version: number;
  clip_count: number;
  producers: Record<string, number>;
  clips: ReplyClip[];
}

function build(): GoldenFile {
  const packs = toQuestionPacks();
  const clips = checkedReplyClosure(packs);
  const producers: Record<string, number> = {};
  for (const c of clips) producers[c.producer] = (producers[c.producer] ?? 0) + 1;
  return { schema_version: 1, clip_count: clips.length, producers, clips };
}

/** Stable, diff-friendly, and identical to what the Python side will read. */
const serialize = (g: GoldenFile): string => `${JSON.stringify(g, null, 2)}\n`;

describe("the reply closure, over the REAL question-pack corpus", () => {
  const built = build();

  it("regenerates BYTE-IDENTICALLY to the committed manifest", () => {
    if (process.env.UPDATE_REPLY_CLOSURE === "1") {
      for (const p of [GOLDEN_PATH, MIRROR_PATH]) {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, serialize(built), "utf8");
      }
      return;
    }
    expect(existsSync(GOLDEN_PATH), `missing ${GOLDEN_PATH}`).toBe(true);
    // A stale manifest is a render that pays for clips nobody will hear and misses clips the
    // engine can serve. Byte comparison, not a deep-equal: the Python side reads these bytes.
    expect(readFileSync(GOLDEN_PATH, "utf8")).toBe(serialize(built));
  });

  it("the ai-service MIRROR is byte-identical to the canonical file", () => {
    if (process.env.UPDATE_REPLY_CLOSURE === "1") return;
    expect(existsSync(MIRROR_PATH), `missing ${MIRROR_PATH}`).toBe(true);
    expect(readFileSync(MIRROR_PATH, "utf8")).toBe(readFileSync(GOLDEN_PATH, "utf8"));
  });

  it("covers every pack in the corpus — a missing pack is a silent worker", () => {
    // Guards the loader wiring rather than the closure: if `loadQuestionPackCorpus` ever returned
    // an empty list the two assertions above would still pass, against an empty manifest.
    expect(toQuestionPacks().length).toBeGreaterThanOrEqual(100);
  });

  it("carries all five producers, so no reply KIND is missing wholesale", () => {
    // The count can drift with the corpus; the producer SET cannot drift innocently. A zero here
    // means an entire category of thing the engine says has no audio — e.g. every clarify turn.
    expect(Object.keys(built.producers).sort()).toEqual(
      ["clarify", "constant", "prompt", "retry", "why"].sort(),
    );
    for (const [producer, n] of Object.entries(built.producers)) {
      expect(n, `producer ${producer} contributed nothing`).toBeGreaterThan(0);
    }
  });

  it("holds a few hundred clips — a floor, so the manifest cannot be shrunk to green", () => {
    // Deliberately a FLOOR and not the exact number: pinning 433 would turn every authored
    // `retry_text` into a failing build, and the plan calls for ~20 more. Deleting half the
    // corpus to make something pass still fails here.
    expect(built.clip_count).toBeGreaterThan(300);
    expect(built.clip_count).toBe(built.clips.length);
  });

  it("every clip id is unique and every text is non-empty", () => {
    expect(new Set(built.clips.map((c) => c.id)).size).toBe(built.clips.length);
    expect(built.clips.every((c) => c.text.trim().length > 0)).toBe(true);
  });
});
