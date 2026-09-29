import "reflect-metadata";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AiModule } from "../ai/ai.module";
import { AiCostRecorder } from "../ai/ai-cost-recorder.service";
import { AiService } from "../ai/ai.service";
import { AuthModule } from "../auth/auth.module";
import { AppConfigModule } from "../config/config.module";
import { DatabaseModule } from "../database/database.module";
import { EventsModule } from "../events/events.module";
import { JobsModule } from "../jobs/jobs.module";
import { JobsRepository } from "../jobs/jobs.repository";
import { MatchModule } from "../match/match.module";
import { WorkerSkillsRepository } from "../match/worker-skills.repository";
import { ResumeModule } from "../resume/resume.module";
import { ResumeService } from "../resume/resume.service";
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
      "JobsDeferredHandler",
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
    expect(imports).toContain(JobsModule);
    expect(getMeta("exports", JobsModule)).toContain(JobsRepository);
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
