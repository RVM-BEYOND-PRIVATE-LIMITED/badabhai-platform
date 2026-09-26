import "reflect-metadata";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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

  it("registers its controller and its three providers", () => {
    expect(getMeta("controllers", ChatCompanionModule)).toEqual([ChatCompanionController]);
    const providers = getMeta("providers", ChatCompanionModule).map((p) => (p as { name: string }).name);
    expect(providers.sort()).toEqual(["ChatCompanionPolicy", "ChatCompanionRepository", "ChatCompanionService"]);
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
    ] as const) {
      expect(isGlobal(mod), `${name} must stay @Global`).toBe(true);
    }
    expect(getMeta("exports", WorkersModule)).toContain(WorkersRepository);
    expect(getMeta("exports", MatchModule)).toContain(WorkerSkillsRepository);
  });

  it("does NOT import the chat, profiles or profiling modules — a leaf with no route to a chat writer", () => {
    const names = getMeta("imports", ChatCompanionModule).map((m) => (m as { name?: string }).name);
    for (const forbidden of ["ChatModule", "ProfilesModule", "ProfilingModule", "AiModule"]) {
      expect(names).not.toContain(forbidden);
    }
  });
});

/**
 * THE EGRESS GUARD. The companion's promises — no chat_messages / chat_sessions writes, no model
 * call, no worker PII, no impression or search events — are promises about what its files can
 * REACH. So pin the imports: a later change that routes a read through one of these fails here.
 */
describe("the companion's egress guard", () => {
  const dir = __dirname;
  const sources = readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => [f, readFileSync(join(dir, f), "utf8")] as const);

  it("sees the production files", () => {
    expect(sources.map(([f]) => f)).toContain("chat-companion.service.ts");
  });

  it.each([
    ["the chat repository / transcript buffer / chat service", /from "\.\.\/chat\/chat\.(repository|service)"|chat-transcript\.buffer/],
    ["the AI service or its contracts", /from "\.\.\/ai\/|@badabhai\/ai-contracts/],
    ["PII crypto", /pii-crypto/],
    ["the transcript reader", /worker-transcript\.repository/],
    ["the impression / search services", /match-feed\.service|applications\.service|from "\.\.\/jobs\/jobs\.service"/],
    ["a chat-row writer", /\b(insertMessages?|createSession|endSession)\b/],
  ])("no file imports or calls %s", (_what, pattern) => {
    for (const [file, source] of sources) {
      expect(source, file).not.toMatch(pattern);
    }
  });
});
