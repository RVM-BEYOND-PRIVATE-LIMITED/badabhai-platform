/**
 * `--batch` scope for the skill-alias embedding runner.
 *
 * The interesting failure here is not "does it embed?" — it is "does it embed MORE than it
 * was asked to?". Without a scope the runner takes every `embedding IS NULL` row in the
 * table, so a bug that drops the scope predicate does not fail loudly; it quietly embeds
 * the shipped catalogue alongside the batch and nobody notices until a bill or a mixed
 * vector space says so. Every test below is aimed at that.
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, afterAll } from "vitest";

import { batchScopeSkillIds, estimateTokens, pendingAliasWhere } from "./embed-skill-aliases";

const dirs: string[] = [];
function batchDir(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), "embed-scope-"));
  dirs.push(d);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(d, name), body, "utf8");
  return d;
}
const skillLine = (id: string): string =>
  JSON.stringify({ kind: "skill", skill_id: id, label_en: id, label_hi: null, aliases: [] });

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("batchScopeSkillIds", () => {
  it("returns the accepted skill ids, deduped and sorted", () => {
    const d = batchDir({
      "accepted-skills.jsonl": [skillLine("skill_b"), skillLine("skill_a"), skillLine("skill_b")].join("\n"),
    });
    expect(batchScopeSkillIds(d)).toEqual(["skill_a", "skill_b"]);
  });

  it("tolerates the '#' provenance header the corpus files carry", () => {
    const d = batchDir({
      "accepted-skills.jsonl": ["# batch: something", "", skillLine("skill_a")].join("\n"),
    });
    expect(batchScopeSkillIds(d)).toEqual(["skill_a"]);
  });

  it("REFUSES a blocked batch rather than scoping to nothing", () => {
    // The whole point. A blocked batch has blocked-skills.jsonl and no accepted file.
    // Returning [] here would read in a log as "scoped, embedded 0" — indistinguishable
    // from success, while the operator believes a gate-rejected batch was handled.
    const d = batchDir({ "blocked-skills.jsonl": skillLine("skill_a") });
    expect(() => batchScopeSkillIds(d)).toThrow(/blocked-skills\.jsonl instead/);
  });

  it("REFUSES an empty accepted file rather than degrading to the whole table", () => {
    const d = batchDir({ "accepted-skills.jsonl": "# header only\n" });
    expect(() => batchScopeSkillIds(d)).toThrow(/refusing an empty --batch scope/);
  });

  it("refuses malformed JSON and a line with no skill_id, naming the line", () => {
    const bad = batchDir({ "accepted-skills.jsonl": `${skillLine("skill_a")}\n{not json` });
    expect(() => batchScopeSkillIds(bad)).toThrow(/line 2: not valid JSON/);
    const noId = batchDir({ "accepted-skills.jsonl": JSON.stringify({ kind: "skill", label_en: "x" }) });
    expect(() => batchScopeSkillIds(noId)).toThrow(/line 1: missing skill_id/);
  });

  it("refuses a directory that is not a batch", () => {
    const d = mkdtempSync(join(tmpdir(), "embed-scope-empty-"));
    dirs.push(d);
    mkdirSync(join(d, "nested"), { recursive: true });
    expect(() => batchScopeSkillIds(d)).toThrow(/does not exist/);
  });
});

describe("pendingAliasWhere", () => {
  // Assert on the COMPILED SQL + bound params, not on object identity: the risk is a
  // predicate silently missing from the WHERE, and only the rendered query shows that.
  const rendered = (blocked: string[], scope: string[] | null): string => {
    const q = new PgDialect().sqlToQuery(pendingAliasWhere(blocked, scope));
    return `${q.sql} -- ${JSON.stringify(q.params)}`;
  };

  it("with no scope and nothing blocked, filters on NULL embeddings only", () => {
    const s = rendered([], null);
    expect(s).toContain("embedding");
    expect(s).not.toContain("skill_id");
  });

  it("with a scope, constrains skill_id — the blast-radius predicate", () => {
    const s = rendered([], ["skill_a", "skill_b"]);
    expect(s).toContain("skill_id");
    expect(s).toContain("skill_a");
    expect(s).toContain("skill_b");
  });

  it("keeps the scope AND the blocked exclusion when both apply", () => {
    const s = rendered(["11111111-1111-1111-1111-111111111111"], ["skill_a"]);
    expect(s).toContain("skill_a");
    expect(s).toContain("11111111-1111-1111-1111-111111111111");
    expect(s).toContain("embedding");
  });

  it("an EMPTY scope selects NOTHING — it must never mean 'everything'", () => {
    // batchScopeSkillIds refuses to produce this, but the predicate is public and a future
    // caller could. `null` means unscoped; `[]` means "no skills", and the difference has
    // to survive here too or the refusal upstream is the only thing holding the line.
    //
    // Drizzle compiles `inArray(x, [])` to the constant `false` rather than emitting a
    // degenerate `IN ()`, so the guarantee shows up as a contradiction in the WHERE — the
    // safe direction. Asserting on `skill_id` would test the rendering, not the semantics.
    const empty = rendered([], []);
    expect(empty).toMatch(/\bfalse\b/);
    // and it is strictly narrower than the unscoped predicate, which has no contradiction
    expect(rendered([], null)).not.toMatch(/\bfalse\b/);
  });
});

describe("estimateTokens", () => {
  it("is the chars/4 planning heuristic, never zero", () => {
    expect(estimateTokens("")).toBe(1);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("a".repeat(40))).toBe(10);
  });
});
