import "reflect-metadata";
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

/**
 * STATIC regression guards for the Contact Unlock privacy invariants
 * (ADR-0010 threat-model §6 — "a test that must exist"; closes TD41).
 *
 * These convert two CONVENTIONS into CI gates so a future change can't silently
 * break them:
 *  - BC-8: `UnlocksRepository` (the sole writer of the unlock tables) is imported
 *    ONLY from inside `apps/api/src/unlocks/`. No other module may reach it.
 *  - BC-5: there is EXACTLY ONE `decrypt(` site on the unlock path (the reveal
 *    handler in unlocks.service.ts) — a second decrypt is a new raw-phone exposure.
 *
 * They are intentionally source-text scans (not runtime), so they catch the leak
 * at author time, before it can ship.
 */

// File-relative (robust to how vitest is invoked): this test lives in
// apps/api/src/unlocks/, so its own dir is UNLOCKS_DIR and its parent is src/.
const UNLOCKS_DIR = __dirname;
const SRC_DIR = dirname(UNLOCKS_DIR);

/** All non-test .ts files under `dir` (recursive). */
function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...tsFiles(full));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("Contact Unlock — static privacy guards (ADR-0010 §6 / TD41)", () => {
  it("BC-8: only modules inside unlocks/ import UnlocksRepository (sole-writer)", () => {
    // Match any import that pulls from a `…unlocks.repository` module path.
    const importsRepo = /from\s+["'][^"']*unlocks\.repository["']/;
    const offenders = tsFiles(SRC_DIR)
      .filter((f) => !f.startsWith(UNLOCKS_DIR + sep) && f !== UNLOCKS_DIR)
      .filter((f) => importsRepo.test(readFileSync(f, "utf8")))
      .map((f) => relative(SRC_DIR, f));

    expect(
      offenders,
      `UnlocksRepository must be imported ONLY inside unlocks/. Offending files: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("BC-5: exactly one decrypt() site exists on the unlock path", () => {
    const sites: string[] = [];
    for (const f of tsFiles(UNLOCKS_DIR)) {
      const content = readFileSync(f, "utf8");
      const matches = content.match(/\.decrypt\(/g);
      if (matches) sites.push(`${relative(SRC_DIR, f)} ×${matches.length}`);
    }
    const total = sites.reduce((n, s) => n + Number(s.split("×")[1]), 0);
    expect(
      total,
      `Expected exactly ONE decrypt() site on the unlock path (the reveal handler). Found: ${sites.join(", ") || "none"}`,
    ).toBe(1);
  });
});
