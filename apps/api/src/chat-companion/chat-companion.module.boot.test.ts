import "reflect-metadata";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AiModule } from "../ai/ai.module";
import { AiCostRecorder } from "../ai/ai-cost-recorder.service";
import { AiService } from "../ai/ai.service";
import { AuthModule } from "../auth/auth.module";
import { AppConfigModule } from "../config/config.module";
import { ConsentModule } from "../consent/consent.module";
import { ConsentRepository } from "../consent/consent.repository";
import { DatabaseModule } from "../database/database.module";
import { EventsModule } from "../events/events.module";
import { JobsModule } from "../jobs/jobs.module";
import { JobsRepository } from "../jobs/jobs.repository";
import { MatchModule } from "../match/match.module";
import { WorkerSkillsRepository } from "../match/worker-skills.repository";
import { ResumeModule } from "../resume/resume.module";
import { ResumeService } from "../resume/resume.service";
import { ResumeRerenderService } from "../resume/resume-rerender.service";
import { WorkersModule } from "../workers/workers.module";
import { WorkersRepository } from "../workers/workers.repository";
import { AppModule } from "../app.module";
import { ChatCompanionModule } from "./chat-companion.module";
import { ChatCompanionController } from "./chat-companion.controller";

/**
 * DI WIRING GUARD (ADR-0044) — the repo's boot-test convention: assert the eager @Module
 * METADATA, because vitest emits no design:paramtypes and a real testing module cannot resolve
 * class tokens. Every collaborator the companion's providers inject from ANOTHER module must be
 * exported by a module it imports, or @Global — otherwise the API dies at startup while every
 * unit test stays green.
 */
const getMeta = (key: string, target: unknown): unknown[] =>
  (Reflect.getMetadata(key, target as object) as unknown[] | undefined) ?? [];
const isGlobal = (target: unknown): boolean =>
  Reflect.getMetadata("__module:global__", target as object) === true;

describe("ChatCompanionModule wiring", () => {
  it("is registered in AppModule", () => {
    expect(getMeta("imports", AppModule)).toContain(ChatCompanionModule);
  });

  it("registers its controller and its providers", () => {
    expect(getMeta("controllers", ChatCompanionModule)).toEqual([ChatCompanionController]);
    const providers = getMeta("providers", ChatCompanionModule).map((p) => (p as { name: string }).name);
    expect(providers.sort()).toEqual([
      "CareerTalkHandler",
      "ChatCompanionPolicy",
      "ChatCompanionRepository",
      "ChatCompanionService",
      // ADR-0046 T7 — the edit path plus ITS OWN instances of the five section writers and the
      // repositories they need (provisioned here, not imported — see the module docblock).
      "CompanionEditService",
      // ADR-0046 T6 — the v2 turn pipeline and its handlers.
      "CompanionHandlerRegistry",
      // ADR-0046 T5 — the v2 Redis stores (memory + the pending edit card).
      "CompanionMemoryStore",
      "CompanionV2Orchestrator",
      "EditProposalStore",
      "EditResumeHandler",
      // ADR-0046 P2 — the faltu strike handler and its Redis store.
      "FaltuHandler",
      "FaltuStore",
      "JobsDeferredHandler",
      // ADR-0046 P2/N1 — the consent-gated new-résumé handler.
      "NewResumeHandler",
      "PhaseOffHandler",
      "ProfilesRepository",
      "ResumeImportRepository",
      "ResumeSuggestionReader",
      "UnclearHandler",
      "WorkerAttributesRepository",
      "WorkerEmploymentRepository",
      "WorkerEmploymentService",
      "WorkerLanguagesRepository",
      "WorkerLanguagesService",
      "WorkerOccupationsRepository",
      "WorkerOccupationsService",
      "WorkerPreferencesService",
      "WorkerQualificationsRepository",
      "WorkerQualificationsService",
    ]);
  });

  it("imports the modules whose EXPORTS it injects", () => {
    const imports = getMeta("imports", ChatCompanionModule);
    expect(imports).toContain(AuthModule); // WorkerAuthGuard + ConsentGuard
    expect(imports).toContain(ResumeModule);
    expect(getMeta("exports", ResumeModule)).toContain(ResumeService);
    // ADR-0046 O6 — the edit confirm's LLM-free re-render when no regeneration was queued.
    expect(getMeta("exports", ResumeModule)).toContain(ResumeRerenderService);
    expect(imports).toContain(JobsModule);
    expect(getMeta("exports", JobsModule)).toContain(JobsRepository);
    // ADR-0046 P2/N1 — the new-résumé handler reads the worker's consent through the same
    // repository the guard and the off-request gates use. Imported, not re-provisioned: unlike
    // the section writers, `ConsentModule` has no chat edge.
    expect(imports).toContain(ConsentModule);
    expect(getMeta("exports", ConsentModule)).toContain(ConsentRepository);
  });

  it("reaches the rest through @Global modules — pinned, so demoting one fails here, not at boot", () => {
    for (const [name, mod] of [
      ["AppConfigModule", AppConfigModule],
      ["DatabaseModule", DatabaseModule],
      ["EventsModule", EventsModule],
      ["WorkersModule", WorkersModule],
      ["MatchModule", MatchModule],
      // ADR-0046 T6 — the v2 orchestrator injects `AiService` (the ONLY way this module may
      // reach a model: API → AiService → ai-service, never a direct call). @Global + exported,
      // so no import edge is added to this leaf module.
      ["AiModule", AiModule],
    ] as const) {
      expect(isGlobal(mod), `${name} must stay @Global`).toBe(true);
    }
    expect(getMeta("exports", WorkersModule)).toContain(WorkersRepository);
    expect(getMeta("exports", MatchModule)).toContain(WorkerSkillsRepository);
    expect(getMeta("exports", AiModule)).toContain(AiService);
    // ADR-0046 O12 — the v2 emitters inject `AiCostRecorder` (classify in the orchestrator,
    // edit-parse in the edit service). @Global + exported, so no import edge is added.
    expect(getMeta("exports", AiModule)).toContain(AiCostRecorder);
  });

  it("does NOT import the chat, profiles or profiling modules — a leaf with no route to a chat writer", () => {
    const names = getMeta("imports", ChatCompanionModule).map((m) => (m as { name?: string }).name);
    for (const forbidden of ["ChatModule", "ProfilesModule", "ProfilingModule", "AiModule"]) {
      expect(names).not.toContain(forbidden);
    }
  });
});

/**
 * THE EGRESS GUARD. The companion's promises — no chat_messages / chat_sessions writes, no
 * worker PII, no impression or search events — are promises about what its files can REACH. So
 * pin the imports: a later change that routes a read through one of these fails here.
 *
 * EXTENDED FOR V2 (ADR-0046 T5, README rule 3). The `v2/` subtree is scanned too, and one rule
 * is deliberately RELAXED there: v2 may import `@badabhai/ai-contracts` and the `AiService`
 * client, because routing a message to the model is its job — through `AiService`, never by
 * opening its own HTTP/SDK call, which is the new v2-specific ban below. Every OTHER ban holds
 * for both generations, which is what keeps "the module has no route to a chat-table writer"
 * true after v2 exists.
 */
describe("the companion's egress guard", () => {
  const dir = __dirname;
  const readSources = (d: string) =>
    readdirSync(d)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .map((f) => [f, readFileSync(join(d, f), "utf8")] as const);
  const sources = readSources(dir);
  const v2Sources = readSources(join(dir, "v2")).map(
    ([f, s]) => [`v2/${f}`, s] as const,
  );
  const allSources = [...sources, ...v2Sources];

  it("sees the production files, including the v2 subtree", () => {
    expect(sources.map(([f]) => f)).toContain("chat-companion.service.ts");
    // Non-vacuous subdir scan: the v2 rules below must never pass by finding nothing.
    expect(v2Sources.map(([f]) => f)).toContain("v2/companion-memory.store.ts");
    expect(v2Sources.map(([f]) => f)).toContain("v2/edit-proposal.store.ts");
  });

  it.each([
    ["the chat repository / transcript buffer / chat service", /from "\.\.\/chat\/chat\.(repository|service)"|chat-transcript\.buffer/],
    ["PII crypto", /pii-crypto/],
    ["the transcript reader", /worker-transcript\.repository/],
    ["the impression / search services", /match-feed\.service|applications\.service|from "\.\.\/jobs\/jobs\.service"/],
    ["a chat-row writer", /\b(insertMessages?|createSession|endSession)\b/],
  ])("no file imports or calls %s", (_what, pattern) => {
    for (const [file, source] of allSources) {
      expect(source, file).not.toMatch(pattern);
    }
  });

  it("the V1 files still reach no AI surface at all — the no-LLM promise of ADR-0044", () => {
    for (const [file, source] of sources) {
      expect(source, file).not.toMatch(/from "\.\.\/ai\/|@badabhai\/ai-contracts/);
    }
  });

  it("no v2 file imports a DI-injected class TYPE-ONLY — Nest resolves by runtime token", () => {
    // THE E2E BOOT CAUGHT THIS ONCE AND NOTHING ELSE COULD. `import type { ConsentRepository }`
    // is erased before `emitDecoratorMetadata` runs, so Nest read the constructor parameter as
    // null and the API died at startup (`NewResumeHandler: dependencies [SERVER_CONFIG, null]`)
    // — while every unit suite stayed green, because they construct handlers by hand and vitest
    // emits no design:paramtypes for the metadata assertions above to inspect.
    //
    // Scanned over source, like the egress rules: every name imported with `import type` must
    // not appear as a constructor parameter type. `@Inject(...)`-decorated parameters are
    // exempt BY CONSTRUCTION (the decorator carries the token), which is why the scan tests the
    // parameter's `: Type` annotation rather than the import itself.
    for (const [file, source] of allSources) {
      const typeOnly = new Set(
        [...source.matchAll(/import\s+type\s*\{([^}]*)\}/g)]
          .flatMap((m) => m[1]!.split(","))
          .map((s) => s.trim().split(/\s+as\s+/)[0]!.trim())
          .filter((s) => s.length > 0),
      );
      const params = source.match(/constructor\(([\s\S]*?)\{/);
      if (params === null) continue;
      // `@Inject(...)`-decorated parameters are exempt: the decorator carries the token, so
      // their `: Type` annotation is documentation (e.g. `@Inject(SERVER_CONFIG) ... config:
      // ServerConfig`). Split on commas — no decorator here takes a comma-bearing argument.
      const undecorated = params[1]!
        .split(",")
        .filter((p) => !p.includes("@Inject("))
        .join(",");
      for (const name of typeOnly) {
        expect(
          undecorated,
          `${file}: ${name} is imported type-only but used as a constructor parameter type — ` +
            `import it as a value or Nest will inject null at boot`,
        ).not.toMatch(new RegExp(`:\\s*${name}\\b`));
      }
    }
  });

  it("no v2 file opens its own model/HTTP call — every model call goes through AiService", () => {
    // The one way v2 may reach a model is the injected `AiService` client (API → AiService →
    // ai-service → pseudonymize → AIRouter). A direct fetch/axios/SDK call here would bypass
    // the pseudonymization gateway and every spend/trace instrument at once.
    const directCall = /fetch\(|axios|node:https|openai|anthropic|generativelanguage|@google\//i;
    for (const [file, source] of v2Sources) {
      expect(source, file).not.toMatch(directCall);
    }
  });
});
