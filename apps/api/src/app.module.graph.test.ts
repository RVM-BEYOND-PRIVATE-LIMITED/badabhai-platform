import "reflect-metadata";
import { describe, expect, it } from "vitest";

import { AppModule } from "./app.module";

/**
 * NO MODULE MAY IMPORT `undefined`.
 *
 * WHAT THIS CAUGHT, and why it is worth its own file. Adding one module edge —
 * `ProfilingModule → VoiceModule`, for the voice form's synchronous transcription leg — closed a
 * triangle (`voice → chat → profiling → voice`) whose every edge is real. Module metadata is
 * evaluated at REQUIRE time, so `voice.module.ts` ran while `chat.module.ts` was still
 * mid-evaluation and its `imports` array literally held `undefined` where `ChatModule` should be.
 * Nest refuses to build that graph: `UndefinedModuleException`, at boot, in every environment.
 *
 * Typecheck passed. Lint passed. The build passed. **3853 unit tests passed** — including the
 * per-module boot tests, because those assert `@Module` METADATA and metadata is exactly what was
 * wrong. The only job that failed was E2E, which is the one that actually starts the application,
 * and it takes minutes and a database and a Redis to say so.
 *
 * This says the same thing in milliseconds and with no infrastructure. It is deliberately NOT a
 * `Test.createTestingModule` boot: this repo's vitest does not emit `design:paramtypes`, so a
 * testing-module boot resolves constructor dependencies as `undefined` and passes regardless.
 * `UndefinedModuleException` is thrown in `scanForModules`, BEFORE any dependency is resolved —
 * so walking the imports arrays reproduces exactly the check that failed, and nothing else.
 */

/** `forwardRef()` yields `{ forwardRef: () => Module }`; a dynamic module yields `{ module }`. */
function resolveEntry(entry: unknown): { resolved: unknown; kind: string } {
  if (entry === undefined || entry === null) return { resolved: entry, kind: "undefined" };
  const ref = entry as { forwardRef?: () => unknown; module?: unknown };
  if (typeof ref.forwardRef === "function") {
    return { resolved: ref.forwardRef(), kind: "forwardRef" };
  }
  if (ref.module !== undefined) return { resolved: ref.module, kind: "dynamic" };
  return { resolved: entry, kind: "static" };
}

const nameOf = (m: unknown): string => (m as { name?: string })?.name ?? String(m);

/** Every module reachable from `AppModule`, with the path that reached it. */
function walk(root: unknown): { module: unknown; path: string[] }[] {
  const seen = new Set<unknown>();
  const out: { module: unknown; path: string[] }[] = [];
  const queue: { module: unknown; path: string[] }[] = [{ module: root, path: [nameOf(root)] }];

  while (queue.length > 0) {
    const current = queue.shift() as { module: unknown; path: string[] };
    if (seen.has(current.module)) continue;
    seen.add(current.module);
    out.push(current);

    const imports =
      (Reflect.getMetadata("imports", current.module as object) as unknown[] | undefined) ?? [];
    for (const entry of imports) {
      const { resolved } = resolveEntry(entry);
      // An undefined entry is reported by the caller, not followed.
      if (resolved === undefined || resolved === null) continue;
      queue.push({ module: resolved, path: [...current.path, nameOf(resolved)] });
    }
  }
  return out;
}

describe("the module graph resolves — the check that only E2E used to make", () => {
  it("has no module importing `undefined` at any depth", () => {
    const offenders: string[] = [];

    for (const { module, path } of walk(AppModule)) {
      const imports =
        (Reflect.getMetadata("imports", module as object) as unknown[] | undefined) ?? [];
      imports.forEach((entry, index) => {
        const { resolved, kind } = resolveEntry(entry);
        if (resolved === undefined || resolved === null) {
          // The message names the index and the path, because that is exactly what Nest's own
          // `UndefinedModuleException` reports and what a reader needs to find the require cycle.
          offenders.push(
            `${nameOf(module)}.imports[${index}] is ${String(resolved)} (${kind}) — reached via ` +
              path.join(" -> "),
          );
        }
      });
    }

    expect(offenders).toEqual([]);
  });

  it("actually walked the graph, so an empty pass cannot be vacuous", () => {
    // Without this, a `walk` that silently returned nothing would make the assertion above the
    // most reassuring test in the repository.
    const modules = walk(AppModule);
    expect(modules.length).toBeGreaterThan(20);
    expect(modules.map(({ module }) => nameOf(module))).toContain("ProfilingModule");
    expect(modules.map(({ module }) => nameOf(module))).toContain("VoiceModule");
  });
});
