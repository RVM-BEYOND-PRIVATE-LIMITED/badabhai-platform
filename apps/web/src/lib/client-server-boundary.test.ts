import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * BUILD-BLOCKER — the client/server transport boundary of the ops console.
 *
 * `src/lib/api.ts` is a SERVER-ONLY module: `opsHeaders()` reads
 * `process.env.INTERNAL_SERVICE_TOKEN`, which Next inlines only for `NEXT_PUBLIC_*`.
 * Import one of its FUNCTIONS into a `"use client"` component and nothing fails
 * loudly — `process.env.INTERNAL_SERVICE_TOKEN` is simply `undefined` in the browser,
 * `opsHeaders()` omits the header, and every write silently 401s against the API's
 * `InternalServiceGuard`. Reads keep working (they run in Server Components), so the
 * console looks healthy while every mutation is dead.
 *
 * That is exactly what happened to the three ops job-posting writes after commit
 * 922af4d1 guarded `POST/PATCH /job-postings` and `POST /job-postings/:id/close`:
 * `posting-create-form.tsx` and `posting-actions.tsx` were `"use client"` and called
 * `createJobPosting` / `updateJobPosting` / `closeJobPosting` directly. Typecheck,
 * lint, build and the whole test suite stayed green.
 *
 * TYPE imports are fine and stay allowed — they are erased at compile time and never
 * reach the bundle. The rule is about VALUE imports.
 *
 * NOTE ON SEVERITY: this was a functional break, not a secret leak. Next replaces a
 * non-public `process.env` read with `undefined` in the client bundle rather than
 * inlining the value, so the token was never shipped. The second test below pins that
 * the token identifier itself never appears in client source either, so the invariant
 * does not quietly depend on that Next behaviour.
 */

const SRC = resolve(fileURLToPath(import.meta.url), "..", "..");

/** Every .ts/.tsx file under src/, excluding tests. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out);
      continue;
    }
    if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue;
    out.push(full);
  }
  return out;
}

/** The "use client" directive must be the first statement to take effect. */
function isClientModule(source: string): boolean {
  return /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*["']use client["']/.test(source);
}

/**
 * Comments stripped, so an identifier is only reported when it appears in CODE.
 * Several client components legitimately NAME the token in a docstring to record
 * that they deliberately do not hold it — documenting the boundary must not trip
 * the check that enforces it.
 */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/**
 * Every import statement in `source` whose specifier resolves to the api module —
 * either through the `@/lib/api` alias or a relative path ending in `lib/api`.
 * Returned verbatim so the failure message can show the offending line.
 */
function apiImports(source: string): string[] {
  const statements = source.match(/^import\s[\s\S]*?from\s*["'][^"']+["'];?/gm) ?? [];
  return statements.filter((s) => /from\s*["'](?:@\/lib\/api|(?:\.\.?\/)+lib\/api)["']/.test(s));
}

/**
 * True when an import brings in only TYPES — either `import type { … }` /
 * `import type X` (the whole statement is erased), or a value-position brace list in
 * which EVERY specifier carries its own inline `type` modifier.
 */
function isTypeOnlyImport(statement: string): boolean {
  if (/^import\s+type\s/.test(statement)) return true;
  const braces = statement.match(/\{([\s\S]*)\}/);
  if (!braces?.[1]) return false;
  // A default or namespace binding before the brace is always a value import.
  if (!/^import\s*\{/.test(statement.replace(/\s+/g, " ").trim())) return false;
  return braces[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .every((s) => /^type\s/.test(s));
}

const CLIENT_MODULES = sourceFiles(SRC)
  .map((path) => ({ path, source: readFileSync(path, "utf8") }))
  .filter(({ source }) => isClientModule(source));

describe("ops console client/server boundary", () => {
  it("finds the client components (guards against a vacuous pass)", () => {
    // If this drops to 0 the two assertions below would pass trivially.
    expect(CLIENT_MODULES.length).toBeGreaterThan(0);
  });

  it('no "use client" module VALUE-imports from lib/api (it would 401 silently)', () => {
    const offenders: string[] = [];
    for (const { path, source } of CLIENT_MODULES) {
      for (const statement of apiImports(source)) {
        if (isTypeOnlyImport(statement)) continue;
        offenders.push(
          `${relative(SRC, path).split(sep).join("/")}\n    ${statement.replace(/\s+/g, " ")}`,
        );
      }
    }
    expect(
      offenders,
      offenders.length === 0
        ? ""
        : "A client component imports a FUNCTION from lib/api. Those functions attach " +
            "INTERNAL_SERVICE_TOKEN from process.env, which is undefined in the browser — " +
            "the call will 401 against InternalServiceGuard with no visible error. Move the " +
            'call into a "use server" action (see app/ops/job-postings/actions.ts), or make ' +
            "the import type-only:\n  " +
            offenders.join("\n  "),
    ).toEqual([]);
  });

  it('no "use client" module reads a server secret from process.env', () => {
    // Belt and braces for the rule above: even if some future module reached the
    // token without importing lib/api, reading it in client code is the bug.
    const offenders = CLIENT_MODULES.filter(({ source }) => {
      const code = codeOnly(source);
      return code.includes("INTERNAL_SERVICE_TOKEN") || /process\s*\.\s*env/.test(code);
    }).map(({ path }) => relative(SRC, path).split(sep).join("/"));
    expect(offenders).toEqual([]);
  });
});
