import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * ADR-0062 §3.6: ONLY the projector's token service and the later Candidates
 * search service may compute a name token. This static test scans the api
 * sources for the primitive and fails on any new importer — a careless caller
 * cannot grow a second decrypt-and-tokenise path.
 */
const ALLOWED = new Set([
  "name-token.service.ts",
  "name-token.service.test.ts",
  "name-token-static.test.ts",
]);

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      walk(full, out);
    } else if (full.endsWith(".ts")) {
      out.push(full);
    }
  }
}

describe("name-token computation sites (ADR-0062 §3.6 static guard)", () => {
  it("computeNameTokens is referenced only where allowed", () => {
    const root = join(__dirname, "..", "..");
    const files: string[] = [];
    walk(root, files);
    const offenders = files
      .filter((f) => readFileSync(f, "utf8").includes("computeNameTokens"))
      .map((f) => f.split(/[\\/]/).pop() as string)
      .filter((name) => !ALLOWED.has(name));
    expect(offenders).toEqual([]);
  });
});
