/**
 * A module that both EXPORTS something and has a `main()` must guard the call.
 *
 * WHY THIS IS A TEST. `packages/db/src` mixes two kinds of file with no naming convention
 * between them: CLI scripts that run on import, and modules other code imports. A file that
 * becomes both — which happens the moment someone exports one useful function out of a script —
 * runs its `main()` as a side effect of being imported.
 *
 * That is not theoretical. It happened twice in one afternoon while building the provenance
 * tooling, and the two failures looked nothing alike:
 *
 *   1. `verify-embedding-provenance.ts` imported `hostClass` from `audit-embedding-provenance.ts`
 *      and printed the entire audit report above its own output.
 *   2. `verify-embedding-provenance.test.ts` imported the module under test, which ran the
 *      script — red in CI on the absent DATABASE_URL, and green locally while silently opening a
 *      connection to PRODUCTION during a unit-test run, because the developer environment
 *      pointed there.
 *
 * The second is the one worth a permanent guard. A unit test that quietly talks to production is
 * both a correctness problem and a safety one, and nothing about the symptom points at the cause.
 *
 * A script with NO exports is exempt: nothing can import it, so an unguarded `main()` is exactly
 * what it should have, and demanding the ceremony everywhere would make the rule noise.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const SRC = join(__dirname);

/** Source files that are not tests and not type-only barrels. */
function sourceFiles(): string[] {
  return readdirSync(SRC).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "index.ts");
}

/** Does the file call `main()` at module scope — i.e. run on import? */
export function callsMainAtModuleScope(src: string): boolean {
  return /^main\(\)/m.test(src);
}

/** Does the file expose anything importable? */
export function hasExports(src: string): boolean {
  return /^export\s/m.test(src);
}

/** Is the `main()` call inside a `require.main === module` guard? */
export function guardsEntrypoint(src: string): boolean {
  return /if\s*\(\s*require\.main\s*===\s*module\s*\)/.test(src);
}

describe("script entrypoints", () => {
  const offenders: string[] = [];
  for (const file of sourceFiles()) {
    const src = readFileSync(join(SRC, file), "utf8");
    if (hasExports(src) && callsMainAtModuleScope(src) && !guardsEntrypoint(src)) offenders.push(file);
  }

  it("no module both exports something and runs main() on import", () => {
    expect(
      offenders,
      `these run their main() as a side effect of being imported: ${offenders.join(", ")}. ` +
        "Wrap the call in `if (require.main === module) { … }`, or stop exporting from the file.",
    ).toEqual([]);
  });

  it("the three provenance tools are guarded", () => {
    // Named individually as well as swept above, so a regression on one of them says which.
    for (const f of [
      "audit-embedding-provenance.ts",
      "verify-embedding-provenance.ts",
      "audit-schema-contract.ts",
    ]) {
      expect(guardsEntrypoint(readFileSync(join(SRC, f), "utf8")), f).toBe(true);
    }
  });

  it("the detectors themselves discriminate", () => {
    // Without this the sweep above would pass vacuously if a regex stopped matching.
    expect(callsMainAtModuleScope("main().catch(() => {});")).toBe(true);
    expect(callsMainAtModuleScope("if (require.main === module) {\n  main();\n}")).toBe(false);
    expect(hasExports("export function a() {}")).toBe(true);
    expect(hasExports("function a() {}\n// export nothing")).toBe(false);
    expect(guardsEntrypoint("if (require.main === module) { main(); }")).toBe(true);
    expect(guardsEntrypoint("main();")).toBe(false);
  });
});

/**
 * The build config must not inherit the typecheck config's widened scope.
 *
 * `tsconfig.json` deliberately covers the root-level ops runners — `adopt-migrations.ts` and its
 * neighbours connect to production and were outside the type checker entirely. `rootDir` had to
 * widen to `.` for that. `tsconfig.build.json` EXTENDS it, so without an explicit pin the build
 * inherits both changes and does two silent things at once: it ships the ops runners inside the
 * published package, and it moves every real output down a level to `dist/src/…`, which no
 * longer matches the `main`/`types`/`exports` paths in package.json.
 *
 * Caught by a downstream typecheck the same afternoon the widening landed — `@badabhai/api`
 * failed on a column that existed in the model and not in the stale `dist` the build had stopped
 * writing to. Nothing in this package failed; the breakage was entirely in its consumers.
 */
describe("tsconfig.build.json — the published layout is pinned, not inherited", () => {
  const build = JSON.parse(
    readFileSync(join(__dirname, "..", "tsconfig.build.json"), "utf8").replace(/^\s*\/\/.*$/gm, ""),
  ) as { compilerOptions?: { rootDir?: string }; include?: string[] };
  const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as {
    main: string;
    types: string;
  };

  it("pins rootDir to ./src, whatever tsconfig.json says", () => {
    expect(build.compilerOptions?.rootDir).toBe("./src");
  });

  it("emits src and only src", () => {
    expect(build.include).toEqual(["src/**/*"]);
  });

  it("keeps package.json's entrypoints consistent with that layout", () => {
    // `dist/index.js`, not `dist/src/index.js`. This is the assertion that actually fails if
    // rootDir drifts, because the two have to agree and only one of them is obvious.
    expect(pkg.main).toBe("./dist/index.js");
    expect(pkg.types).toBe("./dist/index.d.ts");
  });
});
