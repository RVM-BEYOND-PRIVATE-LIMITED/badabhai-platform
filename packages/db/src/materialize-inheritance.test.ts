/**
 * The dry-run's safety property, asserted against its own source.
 *
 * "Dry run does not mutate the database" is usually proved by discipline: a flag guards a write
 * branch, and everyone is careful. That fails the way flags fail — a mistyped argument, an early
 * return inside a transaction, a refactor that moves the guard.
 *
 * Here the capability is ABSENT rather than guarded, and this test reads the file to prove it.
 * A future authorized apply belongs in a separate guarded runner, the way
 * `decollide-skill-aliases.ts` is separate from `embed-skill-aliases.ts`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const SRC = readFileSync(join(__dirname, "materialize-inheritance-dry-run.ts"), "utf8");

/** Strip block/line comments so a rule is asserted about CODE, not about prose describing it. */
const code = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("inheritance dry-run — read-only by construction", () => {
  const body = code(SRC);

  // Deliberately a BLUNT substring check rather than a clever SQL parser. It has already
  // earned its keep by rejecting the word "truncated" in a log line — the log was reworded,
  // which is the right trade: a check that occasionally costs a word is worth more than one
  // that can be reasoned around.
  it.each(["insert", "update", "delete", "upsert", "onConflict", "truncate"])(
    "contains no %s anywhere in executable code",
    (verb) => {
      expect(body.toLowerCase()).not.toContain(verb.toLowerCase());
    },
  );

  it("issues only SELECTs", () => {
    const statements = [...body.matchAll(/dsql`([\s\S]*?)`/g)].map((m) => (m[1] ?? "").trim());
    expect(statements.length).toBeGreaterThan(0);
    for (const s of statements) expect(s.toUpperCase().startsWith("SELECT")).toBe(true);
  });

  it("opens no transaction — nothing exists that could be committed by mistake", () => {
    expect(body).not.toMatch(/\.transaction\s*\(/);
    expect(body.toUpperCase()).not.toContain("BEGIN");
    expect(body.toUpperCase()).not.toContain("COMMIT");
  });

  it("takes no --apply flag, so there is no write mode to reach", () => {
    expect(body).not.toContain("--apply");
    expect(body).not.toContain("enforceOpsGuard"); // nothing to guard: it cannot write
  });

  it("prints the no-runtime-effect notice, so a fan-out number cannot be read as relevance", () => {
    expect(SRC).toContain("NO_RUNTIME_EFFECT_NOTICE");
  });

  it("states plainly that nothing was written", () => {
    expect(SRC).toMatch(/NOTHING WAS WRITTEN/);
  });
});

describe("the notice itself", () => {
  it("says job_domain_skill is not a runtime matching input", async () => {
    const { NO_RUNTIME_EFFECT_NOTICE } = await import("./isco-inheritance");
    expect(NO_RUNTIME_EFFECT_NOTICE).toMatch(/not a runtime matching input/);
    expect(NO_RUNTIME_EFFECT_NOTICE).toMatch(/does not itself increase/);
    expect(NO_RUNTIME_EFFECT_NOTICE).toMatch(/ATTRIBUTE_TO_MATCH_SKILLS/);
  });
});
