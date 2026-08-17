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

import {
  batchScopeSkillIds,
  estimateTokens,
  hasFlag,
  pendingAliasWhere,
  requiredArg,
} from "./embed-skill-aliases";

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
  const rendered = (blocked: string[], scope: string[] | null, onlyActive = false): string => {
    const q = new PgDialect().sqlToQuery(pendingAliasWhere(blocked, scope, onlyActive));
    return `${q.sql} -- ${JSON.stringify(q.params)}`;
  };
  /**
   * The BOUND PARAMETERS, which is where a scoped id actually lands.
   *
   * Asserting `toContain("skill_a")` on the rendered SQL looks equivalent and is not: every
   * predicate references `"skill_alias"."skill_id"`, and `skill_alias` CONTAINS `skill_a` as
   * a substring. That assertion therefore passed with the scope predicate entirely absent —
   * vacuous in exactly the blast-radius test written to catch it. Mutation testing found it.
   */
  const params = (blocked: string[], scope: string[] | null, onlyActive = false): unknown[] =>
    new PgDialect().sqlToQuery(pendingAliasWhere(blocked, scope, onlyActive)).params;

  it("with no scope and nothing blocked, filters on NULL embeddings only", () => {
    const s = rendered([], null);
    expect(s).toContain("embedding");
    // No BOUND ids: the SQL always names the skill_id column, so only the params can say
    // whether anything was actually constrained.
    expect(params([], null)).toEqual([]);
  });

  it("with a scope, constrains skill_id — the blast-radius predicate", () => {
    expect(rendered([], ["skill_a", "skill_b"])).toContain("skill_id");
    expect(params([], ["skill_a", "skill_b"])).toEqual(["skill_a", "skill_b"]);
  });

  it("keeps the scope AND the blocked exclusion when both apply", () => {
    const p = params(["11111111-1111-1111-1111-111111111111"], ["skill_a"]);
    expect(p).toContain("skill_a");
    expect(p).toContain("11111111-1111-1111-1111-111111111111");
    expect(rendered(["11111111-1111-1111-1111-111111111111"], ["skill_a"])).toContain("embedding");
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

describe("argv parsing — the blast-radius surface", () => {
  // Two real, adversarially-found bugs live here, both of which a reading passes over:
  //
  //   `--reset-embeddings --batch=<dir>` did NOT trip the refusal, because the guard was
  //   `argv.includes("--batch")` and the `=` form is a different string. The global
  //   "NULL every embedding" then ran while the operator believed they had scoped it.
  //
  //   `--batch=<dir>` and a trailing `--batch` both yielded null, which meant UNSCOPED —
  //   and the "scope applied" log only prints when a scope exists, so the widened run was
  //   indistinguishable from the correct one in the output.

  describe("hasFlag", () => {
    it("sees both --flag and --flag=value", () => {
      expect(hasFlag(["--batch", "d"], "--batch")).toBe(true);
      expect(hasFlag(["--batch=d"], "--batch")).toBe(true);
      expect(hasFlag(["--plan"], "--batch")).toBe(false);
    });

    it("does not match a different flag that shares a prefix", () => {
      expect(hasFlag(["--batches=d"], "--batch")).toBe(false);
    });
  });

  describe("requiredArg", () => {
    it("reads both forms", () => {
      expect(requiredArg(["--batch", "dir"], "--batch")).toBe("dir");
      expect(requiredArg(["--batch=dir"], "--batch")).toBe("dir");
    });

    it("returns null only when the flag is genuinely absent", () => {
      expect(requiredArg(["--plan"], "--batch")).toBeNull();
    });

    it("THROWS on a trailing flag rather than silently running unscoped", () => {
      expect(() => requiredArg(["--plan", "--batch"], "--batch")).toThrow(/requires a value/);
    });

    it("THROWS when the next token is another flag, not a value", () => {
      expect(() => requiredArg(["--batch", "--plan"], "--batch")).toThrow(/requires a value/);
    });

    it("THROWS on an empty =value", () => {
      expect(() => requiredArg(["--batch="], "--batch")).toThrow(/no value/);
    });
  });
});

describe("estimateTokens", () => {
  it("is the chars/4 planning heuristic, never zero", () => {
    expect(estimateTokens("")).toBe(1);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("a".repeat(40))).toBe(10);
  });
});

// ===========================================================================
// Phase 7 Gate B: the active-only scope.
// ===========================================================================
describe("pendingAliasWhere — --only-active-skills", () => {
  const rendered = (blocked: string[], scope: string[] | null, onlyActive = false): string => {
    const q = new PgDialect().sqlToQuery(pendingAliasWhere(blocked, scope, onlyActive));
    return `${q.sql} -- ${JSON.stringify(q.params)}`;
  };

  it("is OFF by default — called with TWO arguments, as every existing caller does", () => {
    // Exercises the FUNCTION's own default, not the test helper's. The helper defaulted the
    // third argument to false and so passed it explicitly, which meant flipping the real
    // default to `true` — silently narrowing every existing caller — survived mutation.
    const q = new PgDialect().sqlToQuery(pendingAliasWhere([], null));
    expect(q.sql).not.toContain("status");
    const scoped = new PgDialect().sqlToQuery(pendingAliasWhere([], ["skill_a"]));
    expect(scoped.sql).not.toContain("status");
  });

  it("constrains to skills that are ACTIVE when asked", () => {
    const s = rendered([], null, true);
    expect(s).toContain("status = 'active'");
    expect(s.toLowerCase()).toContain("exists");
    expect(s).toContain("skill");
  });

  it("correlates the EXISTS to the alias row, not to a constant", () => {
    // A subquery that forgot the correlation (`WHERE s.skill_id = sa.skill_id`) would be
    // true whenever ANY active skill exists — i.e. always — and the scope would silently
    // do nothing while looking present in the SQL.
    const s = rendered([], null, true);
    expect(s).toMatch(/s\.skill_id\s*=\s*"?skill_alias"?\."?skill_id"?/);
  });

  it("COMPOSES with --batch rather than replacing it", () => {
    // Both scopes apply. If one silently won, an operator combining them would get a blast
    // radius they did not ask for — in either direction. Asserted on the BOUND PARAM: the
    // substring `skill_a` also occurs inside `"skill_alias"."skill_id"`, so the obvious
    // SQL-text assertion is vacuous and survived the "batch clause dropped" mutation.
    const q = new PgDialect().sqlToQuery(pendingAliasWhere([], ["skill_zebra"], true));
    expect(q.params).toEqual(["skill_zebra"]);
    expect(q.sql).toContain("status = 'active'");
  });

  it("COMPOSES with the blocked-id exclusion", () => {
    const s = rendered(["11111111-1111-1111-1111-111111111111"], null, true);
    expect(s).toContain("11111111-1111-1111-1111-111111111111");
    expect(s).toContain("status = 'active'");
  });

  it("still filters on NULL embeddings — resumability is not traded away", () => {
    expect(rendered([], null, true)).toContain("embedding");
  });

  it("targets skill.status, never job_domain_skill.status", () => {
    // The edge status is a different lifecycle and is already `active` for every row in
    // this corpus; scoping on it would select all 131 and defeat the point of the flag.
    const s = rendered([], null, true);
    expect(s).not.toContain("job_domain_skill");
  });

  it("names the SKILL table, so the predicate cannot bind to the alias's own columns", () => {
    const s = rendered([], null, true);
    expect(s).toMatch(/from\s+skill\s+s/i);
  });
});
