import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { getQueueToken } from "@nestjs/bullmq";
import { AppModule } from "../app.module";
import { MatchModule } from "../match/match.module";
import { PayersModule } from "../payers/payers.module";
import { PayerDisclosureRateLimit } from "../payers/payer-disclosure-rate-limit.service";
import { RESUME_RENDER_QUEUE } from "../queue/queue.constants";
import { CandidatesModule } from "./candidates.module";
import { CandidateSearchController } from "./candidate-search.controller";
import { CandidateSearchRepository } from "./candidate-search.repository";
import { CandidateSearchService } from "./candidate-search.service";

/**
 * DI WIRING CONTRACT for the all-candidates search (E2_BUILD item 1: "NEST BOOT IS THE RISK HERE,
 * not typecheck"). One bad module edge has previously made the app fail to BOOT while typecheck,
 * lint, build and unit tests all passed. Asserted on the `@Module` METADATA, as
 * `match.module.boot.test.ts` does (the vitest setup emits no `design:paramtypes`, so the container
 * cannot be instantiated under the runner; the live boot is exercised by `nest build` + e2e).
 */
const getMeta = (key: string, target: unknown): unknown[] =>
  (Reflect.getMetadata(key, target as object) as unknown[] | undefined) ?? [];

describe("CandidatesModule — the all-candidates search wiring", () => {
  it("is mounted by the app", () => {
    expect(getMeta("imports", AppModule)).toContain(CandidatesModule);
  });

  it("serves the one controller and provides its service + repository", () => {
    expect(getMeta("controllers", CandidatesModule)).toEqual([CandidateSearchController]);
    const providers = getMeta("providers", CandidatesModule);
    expect(providers).toContain(CandidateSearchService);
    expect(providers).toContain(CandidateSearchRepository);
  });

  it("imports PayersModule — PayerAuthGuard must resolve in THIS module's injector", () => {
    expect(getMeta("imports", CandidatesModule)).toContain(PayersModule);
  });

  it("imports MatchModule — the live tier floor the rank key reads (MatchConfigService)", () => {
    expect(getMeta("imports", CandidatesModule)).toContain(MatchModule);
  });

  it("re-provides the rate limiter AND registers the queue its Redis connection comes from", () => {
    // PayersModule does not export PayerDisclosureRateLimit; it injects the result-render
    // queue for its Redis client. Missing either is a boot-time resolution error.
    expect(getMeta("providers", CandidatesModule)).toContain(PayerDisclosureRateLimit);
    const imports = getMeta("imports", CandidatesModule) as { providers?: { provide?: unknown }[] }[];
    const queueTokens = imports.flatMap((m) => (m?.providers ?? []).map((p) => p?.provide));
    expect(queueTokens).toContain(getQueueToken(RESUME_RENDER_QUEUE));
  });
});
