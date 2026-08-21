/**
 * The alias move in `retag-skills.ts` must not destroy a paid embedding.
 *
 * THE DEFECT THIS PINS. The move is an insert-then-delete keyed on
 * `deterministicAliasId(terminal, text, lang)`. That id collides with a row the SEED already
 * wrote whenever the successor's own corpus declares the predecessor's alias text — which is
 * not an edge case: `skill_drawing_reading` declares "CAD", "technical drawing" and "read
 * engineering drawings", and `skill_cad_interpretation` holds all three EMBEDDED in production
 * today (verified 2026-08-19; all three are among the 76 rows stamped
 * `gemini-embedding-001` in `phase-9-provenance-stamp.json`).
 *
 * With `onConflictDoNothing` the sequence was: insert skipped, because the seed's UNEMBEDDED
 * row already owns the id -> DELETE the predecessor unconditionally. Net effect: three paid,
 * provenance-stamped vectors destroyed, and the surviving rows carry `embedding IS NULL`, which
 * BOTH retrieval paths filter out. Nothing errors. Nothing logs. The only symptom is a coverage
 * hole that looks like a taxonomy problem.
 *
 * These are source-level assertions rather than a live upsert, deliberately: the runner refuses
 * to start against a production database, and the property worth pinning is that the DELETE is
 * never reachable without the vector having been carried first.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { deterministicAliasId } from "./skill-alias-id";

const SRC = readFileSync(join(__dirname, "retag-skills.ts"), "utf8");

/**
 * The alias-move block: from the insert through the delete that follows it, with comments
 * stripped.
 *
 * Comments are removed because the block now EXPLAINS the destructive behaviour it replaced,
 * naming `ON CONFLICT DO NOTHING` in prose. A guard that forbids describing the bug it
 * prevents is a guard that gets deleted the first time someone documents it properly — the
 * same trap `deploy-workflow-taxonomy.guard.test.ts` had to be rewritten to avoid.
 */
function aliasMoveBlock(): string {
  const start = SRC.indexOf("deterministicAliasId(terminal");
  expect(start, "the alias move block moved or was renamed").toBeGreaterThan(-1);
  const end = SRC.indexOf("moved += 1;", start);
  expect(end, "the delete/counter that closes the alias move is gone").toBeGreaterThan(start);
  return SRC.slice(start, end)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");
}

describe("retag alias move — the vector must survive the id collision", () => {
  it("does not use onConflictDoNothing for the alias move", () => {
    // The exact call that made the delete destructive.
    expect(aliasMoveBlock()).not.toMatch(/onConflictDoNothing/);
  });

  it("carries the embedding across on conflict", () => {
    const block = aliasMoveBlock();
    expect(block).toMatch(/onConflictDoUpdate/);
    expect(block).toMatch(/embedding:\s*a\.embedding/);
    expect(block).toMatch(/embeddingModel:\s*a\.embeddingModel/);
    expect(block).toMatch(/embeddedAt:\s*a\.embeddedAt/);
  });

  it("only fills a HOLE — an existing vector is never overwritten by a predecessor's", () => {
    // Without the guard the move would be able to replace a terminal's own, possibly newer,
    // embedding with one from a skill being retired. `isNull` is the whole safety property.
    expect(aliasMoveBlock()).toMatch(/setWhere:\s*isNull\(skillAliases\.embedding\)/);
  });

  it("the delete still follows the upsert, so the move is still a move", () => {
    // The lazy fix would be to stop deleting. That leaves the alias on the deprecated skill
    // and the live path keeps emitting the deprecated id — the thing the runner exists to stop.
    const block = aliasMoveBlock();
    expect(block).toMatch(/\.delete\(skillAliases\)/);
    expect(block.indexOf("onConflictDoUpdate")).toBeLessThan(block.indexOf(".delete(skillAliases)"));
  });

  it("still refuses to move a row onto itself", () => {
    // `terminal === a.skillId` would make insert-then-delete a pure deletion.
    expect(SRC).toMatch(/terminal === a\.skillId/);
  });

  it("the header explains the change, so the next reader inherits the reason", () => {
    // Asserting the presence of the explanation, not the absence of the old phrase. The
    // header SHOULD name `ON CONFLICT DO NOTHING` — as history. What must not come back is
    // the call itself, which the comment-stripped assertions above cover.
    const header = SRC.slice(0, SRC.indexOf("*/"));
    expect(header).toMatch(/carried onto the existing row IF AND ONLY IF that\s+\*\s+row has none/);
  });
});

describe("deterministicAliasId — why the collision is the normal case, not a rare one", () => {
  it("depends only on (skill_id, text, lang), so a move to a seeded terminal always collides", () => {
    const a = deterministicAliasId("skill_drawing_reading", "CAD", "en");
    const b = deterministicAliasId("skill_drawing_reading", "CAD", "en");
    expect(a).toBe(b);
    // Different owner -> different id, which is why the DELETE targets a DIFFERENT row than
    // the one the insert conflicts with. That asymmetry is what made the loss possible.
    expect(deterministicAliasId("skill_cad_interpretation", "CAD", "en")).not.toBe(a);
  });

  it("reproduces the three production ids this defect would have destroyed", () => {
    // Pinned as literals: if the id derivation ever changes, the historical record of WHICH
    // rows were at risk must not silently change with it.
    const sha1Uuid = (skillId: string, text: string, lang: string): string => {
      const h = createHash("sha1").update(`skill_alias:${skillId}:${lang}:${text}`).digest("hex");
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
    };
    const at_risk: Record<string, string> = {
      CAD: "02776ee2-3322-5846-8538-c04d2a2b19ec",
      "technical drawing": "0c6caf0d-9d88-5030-8e47-c238a5620840",
      "read engineering drawings": "580d7d5b-4d12-54ee-811c-ff954e880388",
    };
    for (const [text, id] of Object.entries(at_risk)) {
      expect(deterministicAliasId("skill_cad_interpretation", text, "en"), text).toBe(id);
      expect(sha1Uuid("skill_cad_interpretation", text, "en"), text).toBe(id);
    }
  });
});
