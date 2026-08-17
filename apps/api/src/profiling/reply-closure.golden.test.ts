import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { QuestionPack, QuestionPackItem } from "@badabhai/ai-contracts";
import { loadQuestionPackCorpus, type PackRecord } from "@badabhai/db";

import {
  assertNoCollisions,
  checkedReplyClosure,
  clipId,
  normalizeReplyText,
  type ReplyClip,
} from "./reply-closure";
// THE SERVE SITES THEMSELVES, not a second copy of the list. See the completeness test at the
// bottom of this file for why these are read from where they are used rather than re-typed.
import { CHAT_OPENING_TEXT } from "../chat/chat-replies";
import { DISAMBIGUATION_PROMPT } from "./identify.service";
import {
  CLOSING_REPLY,
  DE_ESCALATION_REPLY,
  HARDSHIP_REPLIES,
  UNAVAILABLE_REPLY,
} from "./orchestrator.service";

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

/**
 * Every `(pack_id, version)` that has ever been published, one per line (#708).
 *
 * A LEDGER RATHER THAN A DERIVED SET, because the thing worth catching is a DISAPPEARANCE, and
 * nothing derived from the current corpus can see what used to be in it. It sits beside
 * `_families.jsonl` in the same directory and follows the same underscore-prefixed JSONL
 * convention for corpus sidecars.
 */
const VERSIONS_PATH = join(
  __dirname,
  "../../../../packages/db/data/question-packs/_published-versions.jsonl",
);

/** The ledger as `pack_id@version` strings; blank lines and `#` comments ignored. */
function readPublishedVersions(): string[] {
  if (!existsSync(VERSIONS_PATH)) return [];
  return readFileSync(VERSIONS_PATH, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

/**
 * The ledger's leading comment block, so `UPDATE_PACK_VERSIONS=1` cannot delete it.
 *
 * IT DID DELETE IT, WHICH IS WHY THIS EXISTS. The updater re-serialized whatever
 * `readPublishedVersions` returned — and that reader strips `#` lines by design, so running the
 * documented regeneration command silently dropped the 21-line header explaining what the ledger
 * is for, how to add a version, and that retiring one means hand-deleting its line. A file whose
 * own instructions are erased by following those instructions is a trap, and the header is the
 * only place the retire-by-hand rule is written down.
 *
 * Reads the block verbatim rather than holding a copy: the header is prose under review like the
 * rest of the corpus, and a second copy in a test file would drift from it.
 */
function readLedgerHeader(): string {
  if (!existsSync(VERSIONS_PATH)) return "";
  const lines = readFileSync(VERSIONS_PATH, "utf8").split(/\r?\n/);
  const end = lines.findIndex((line) => line.trim().length > 0 && !line.trim().startsWith("#"));
  const header = end === -1 ? lines : lines.slice(0, end);
  return header.length > 0 ? `${header.join("\n")}\n` : "";
}

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

  it("NO PUBLISHED PACK VERSION HAS DISAPPEARED — every ledger entry still renders", () => {
    // #708, and this replaces a guard that had the condition BACKWARDS.
    //
    // It asserted "no pack_id carries two versions", on the belief that the corpus is one file per
    // pack_id so a v2 would REPLACE v1. That belief is wrong, and I executed the loader rather than
    // reading it: `loadQuestionPackCorpus` reads EVERY `packs/*.json` and pushes each one, and
    // `validateQuestionPackCorpus` rejects only a duplicate `(pack_id, version)` PAIR. So:
    //
    //   v2 added as a second file  -> both load, v1's strings stay in the manifest  -> SAFE
    //                                 ...and the old guard FAILED THE BUILD on it.
    //   v1 edited in place, version bumped -> v1's strings exist nowhere            -> DANGEROUS
    //                                 ...and the old guard PASSED.
    //
    // It blocked the only safe way to publish a second version and waved through the one that
    // strands a pinned worker in silence.
    //
    // THE INVARIANT THAT ACTUALLY MATTERS is append-only: a session pins `(pack_id, version)` for
    // the length of an interview, so a version that has ever been published must keep resolving to
    // clips. Whether a version may EVER be retired is an ops question with a live-session query
    // behind it (owner ruling 2026-08-08: versioned layout — keep every live version on disk and
    // render them all). This test enforces the part that is checkable at build time, and the
    // ledger is the record of what has shipped.
    //
    // To publish a new version: add the file, then `UPDATE_PACK_VERSIONS=1 …` to append it here.
    // To RETIRE one: delete the ledger line by hand, which is a reviewable diff that says out loud
    // "no live session pins this any more" — exactly the claim that should never be made silently.
    const onDisk = new Set(toQuestionPacks().map((p) => `${p.pack_id}@${p.version}`));
    const ledger = readPublishedVersions();

    if (process.env.UPDATE_PACK_VERSIONS === "1") {
      // Header FIRST — see `readLedgerHeader`. Append-only over the union, never a replacement:
      // a version that has shipped stays in the ledger until somebody deletes its line by hand.
      writeFileSync(
        VERSIONS_PATH,
        `${readLedgerHeader()}${[...new Set([...ledger, ...onDisk])].sort().join("\n")}\n`,
        "utf8",
      );
      return;
    }

    expect(ledger.length, "the ledger is empty — regenerate it").toBeGreaterThan(0);
    const vanished = ledger.filter((entry) => !onDisk.has(entry));
    expect(
      vanished,
      "a published pack version no longer exists in the corpus; every session pinned to it is " +
        "being served strings that were never checked and never rendered — silence, at a question " +
        "the worker cannot read",
    ).toEqual([]);
  });

  it("the ledger KEEPS its header — regenerating must not erase its own instructions", () => {
    // The regression `readLedgerHeader` exists for. The retire-by-hand rule is written down in
    // exactly one place, and the documented `UPDATE_PACK_VERSIONS=1` command used to delete it.
    const header = readLedgerHeader();
    expect(header.startsWith("#"), "the ledger has lost its comment header").toBe(true);
    expect(header, "the retire-by-hand rule is written down nowhere else").toContain("RETIRING");
    // And the header is not mistaken for an entry.
    expect(readPublishedVersions().every((e) => /^qp_[a-z0-9_]+@\d+$/.test(e))).toBe(true);
  });

  it("the ledger bites — a vanished version is caught, a NEW one is not a failure", () => {
    // A guard that cannot fail is not a guard, and this one has two directions to get wrong.
    const onDisk = new Set(["qp_a@1", "qp_b@1"]);
    const vanished = (led: string[]) => led.filter((e) => !onDisk.has(e));
    // v1 retired without a ledger edit -> caught.
    expect(vanished(["qp_a@1", "qp_b@1", "qp_c@1"])).toEqual(["qp_c@1"]);
    // A second version added beside the first -> NOT a failure. This is the case the old guard
    // failed the build on, and it is the safe one.
    expect(vanished(["qp_a@1"])).toEqual([]);
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

  it("the COMMITTED manifest carries no id claimed by two different strings", () => {
    // `assertNoCollisions` over the bytes on disk, which is the input it is meaningful over
    // (#679): the closure's own output is deduplicated by construction, but this file is a
    // committed artifact that gets hand-edited and merged, and both languages read it to decide
    // which audio file answers to which id. A duplicated id here is a worker hearing the wrong
    // question — the exact failure the guard names, on the only list that can actually carry one.
    if (process.env.UPDATE_REPLY_CLOSURE === "1") return;
    const onDisk = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as GoldenFile;
    expect(() => assertNoCollisions(onDisk.clips)).not.toThrow();
  });

  it("every constant THE SERVE SITES ACTUALLY USE has a clip in the committed manifest", () => {
    // THE COMPLETENESS CLAIM, ENFORCED. `CONSTANT_REPLIES`' doc says "adding a seventh constant to
    // the orchestrator without adding it here is a test failure rather than a question a worker
    // hears in silence", and the unit test repeated it — but what that test asserted was
    // `new Set(CONSTANT_REPLIES).size === CONSTANT_REPLIES.length`, i.e. UNIQUENESS over a second
    // hand-typed copy of the same array. Nothing compared the strings the engine really serves
    // against the manifest, so a constant could drift out of the closure with the suite green.
    //
    // These are imported from the SERVE SITES — the orchestrator's own exports and the chat
    // module's, exactly as the code that puts them on screen reads them. Change
    // `DE_ESCALATION_REPLY`'s wording without regenerating and this fails, which is the whole
    // point: the de-escalation branch fires on an abusive turn and the changed string reaches the
    // worker with no rendered clip behind it — silence, on the voice form.
    if (process.env.UPDATE_REPLY_CLOSURE === "1") return;
    const ids = new Set(
      (JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as GoldenFile).clips.map((c) => c.id),
    );
    const served: ReadonlyArray<readonly [string, string]> = [
      ["DE_ESCALATION_REPLY", DE_ESCALATION_REPLY],
      ["CLOSING_REPLY", CLOSING_REPLY],
      ["UNAVAILABLE_REPLY", UNAVAILABLE_REPLY],
      ["DISAMBIGUATION_PROMPT", DISAMBIGUATION_PROMPT],
      ["CHAT_OPENING_TEXT", CHAT_OPENING_TEXT],
      ...HARDSHIP_REPLIES.map((text, i) => [`HARDSHIP_REPLIES[${i}]`, text] as const),
    ];
    for (const [name, text] of served) {
      expect(ids.has(clipId(normalizeReplyText(text))), `${name} has no clip in the manifest`).toBe(
        true,
      );
    }
  });
});
