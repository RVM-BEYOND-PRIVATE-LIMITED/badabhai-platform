import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AiModule } from "./ai.module";
import { AiAlertsRepository } from "./ai-alerts.repository";
import { AiAlertsService } from "./ai-alerts.service";
import { AiService } from "./ai.service";

const AI_DIR = __dirname;

/** Non-comment source of a file in this directory. */
function code(file: string): string {
  return readFileSync(join(AI_DIR, file), "utf8").replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
}

/**
 * DI WIRING REGRESSION GUARD (B13, #2567) — mirrors `admin-static-guards.test.ts`, for
 * the failure the E2E caught that no unit suite did: `AiCostRecorder` took its new
 * `AiAlertsService` dependency as an `import type`, which erases the constructor's
 * `design:paramtypes` entry — so the API process exited during startup while
 * typecheck, lint and every hand-constructed unit test stayed green.
 *
 * A runtime `design:paramtypes` assertion is NOT available here: vitest's esbuild
 * transform does not emit decorator metadata, so even a correct import reads as
 * `undefined` in this runner. What IS checkable — and what actually broke — is the
 * source spelling, exactly the layer `admin-static-guards.test.ts` already pins.
 * Asserts the Nest module METADATA (eager, no container boot) plus the import shapes
 * the injector reads at boot.
 */
const getMeta = (key: string, target: unknown): unknown[] =>
  (Reflect.getMetadata(key, target as object) as unknown[] | undefined) ?? [];

describe("AiModule wiring (DI regression guard)", () => {
  it("provides the alerts repository + service, and exports the service for admin/health", () => {
    const providers = getMeta("providers", AiModule).map((p) =>
      typeof p === "function" ? p.name : (p as { provide?: unknown }).provide,
    );
    expect(providers).toContain("AiAlertsService");
    expect(providers).toContain("AiAlertsRepository");

    const exported = getMeta("exports", AiModule);
    expect(exported).toContain(AiAlertsService);
  });

  it("AiCostRecorder value-imports AiAlertsService (never `import type` — that kills the boot)", () => {
    const src = code("ai-cost-recorder.service.ts");
    // The VALUE import is what survives emit into `design:paramtypes`. A type-only
    // import compiles, typechecks and passes every hand-built unit test — and the API
    // process exits during startup because the erased param resolves to nothing.
    expect(src).toMatch(/import\s*\{\s*AiAlertsService\s*\}\s*from\s*"\.\/ai-alerts\.service"/);
    expect(src).not.toMatch(/import\s+type\s*\{[^}]*AiAlertsService[^}]*\}/);
  });

  it("AiCostRecorder's alerts dependency is @Optional (pre-existing constructions keep working)", () => {
    expect(code("ai-cost-recorder.service.ts")).toContain("@Optional() private readonly alerts?");
  });

  it("HealthService reaches the GLOBAL alerts service via value import + @Optional (no module edge)", () => {
    // AiModule is @Global, so the type resolves without an import edge in
    // health.module.ts (the AiService idiom). Same import-shape rule as above.
    const src = readFileSync(
      join(AI_DIR, "..", "health", "health.service.ts"),
      "utf8",
    ).replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
    expect(src).toMatch(/import\s*\{\s*AiAlertsService\s*\}\s*from\s*"\.\.\/ai\/ai-alerts\.service"/);
    expect(src).not.toMatch(/import\s+type\s*\{[^}]*AiAlertsService[^}]*\}/);
    expect(src).toContain("@Optional() private readonly alerts?");
  });

  it("the providers reference the real classes (no accidental shadowing)", () => {
    const providers = getMeta("providers", AiModule);
    expect(providers).toContain(AiService);
    expect(providers).toContain(AiAlertsService);
    expect(providers).toContain(AiAlertsRepository);
  });
});
