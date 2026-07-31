/**
 * Repo-wide source hygiene: no raw control characters in tracked source files.
 *
 * WHY THIS EXISTS — a real incident, 2026-07-31. A `\0` separator was typed as a
 * LITERAL NUL byte inside a template literal in `packages/taxonomy/src/match-skills.ts`
 * (`` `${a}\0${b}` ``). It compiled, it behaved correctly, and every test passed — but
 * ripgrep classifies any file containing a NUL as **binary and skips it silently**. So
 * every `grep` over that file returned nothing, including the consumer sweep that was
 * supposed to prove nothing else referenced the old shape. A search that silently finds
 * nothing is indistinguishable from a search that correctly finds nothing, which is what
 * makes this worth a CI gate rather than a code-review habit.
 *
 * A second, pre-existing instance was then found in `packages/reach-learn/src/dataset.ts`
 * using the same composite-key idiom. Both are now written as the ESCAPE `\u0000`, which
 * produces an identical runtime string while leaving the file as searchable text.
 *
 * THE RULE: use the escape, never the byte. If you genuinely need a NUL at runtime,
 * `"\u0000"` is the same value and costs nothing.
 *
 * Scanned: tracked text-source extensions across the repo. Tabs, newlines and carriage
 * returns are legal; everything else below 0x20, plus DEL, is not.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");

/** Text-source extensions. Binary assets (fonts, images, PDFs) are legitimately binary. */
const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".mjs", ".cjs", ".py", ".dart",
  ".md", ".json", ".sql", ".yml", ".yaml", ".css", ".html",
]);

/** Directories that are generated, vendored, or not ours. */
const SKIP_DIRS = new Set([
  "node_modules", ".git", ".next", "dist", "build", "coverage",
  ".turbo", ".venv", "__pycache__", ".dart_tool", ".claude", "worktrees",
]);

/** Legal control characters: tab, newline, carriage return. */
const ALLOWED_CONTROL = new Set([0x09, 0x0a, 0x0d]);

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // unreadable dir (permissions, race) — not this test's business
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) collectSourceFiles(full, out);
    else if (SOURCE_EXTENSIONS.has(entry.slice(entry.lastIndexOf(".")))) out.push(full);
  }
  return out;
}

/** Byte offset of the first illegal control character, or -1. */
function firstControlCharOffset(bytes: Buffer): number {
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    if ((b < 0x20 && !ALLOWED_CONTROL.has(b)) || b === 0x7f) return i;
  }
  return -1;
}

describe("source hygiene", () => {
  const files = collectSourceFiles(REPO_ROOT);

  it("finds source files to scan (guards against the scan itself silently doing nothing)", () => {
    // Without this, a broken walker would make every assertion below vacuously true —
    // the exact failure mode this whole test exists to prevent.
    expect(files.length).toBeGreaterThan(500);
  });

  it("no tracked source file contains a raw control character", () => {
    const offenders: string[] = [];
    for (const file of files) {
      let bytes: Buffer;
      try {
        bytes = readFileSync(file);
      } catch {
        continue;
      }
      const offset = firstControlCharOffset(bytes);
      if (offset === -1) continue;
      const relative = file.slice(REPO_ROOT.length + 1).split(sep).join("/");
      const line = bytes.subarray(0, offset).toString("utf8").split("\n").length;
      const code = `0x${bytes[offset]!.toString(16).padStart(2, "0")}`;
      offenders.push(`${relative}:${line} contains ${code}`);
    }

    expect(
      offenders,
      `Raw control characters found. ripgrep treats such a file as BINARY and skips it, so every ` +
        `grep over it silently returns nothing. Write the escape instead — "\\u0000" is the same ` +
        `runtime value and keeps the file searchable.\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });
});
