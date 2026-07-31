import "reflect-metadata";
import { describe, it, expect } from "vitest";
import { MatchModule } from "./match.module";
import { MatchSkillsController } from "./match-skills.controller";
import { PayersModule } from "../payers/payers.module";
import { MatchConfigService } from "./match-config.service";
import { WorkerSkillsService } from "./worker-skills.service";
import { WorkerSkillsRepository } from "./worker-skills.repository";
import { MatchSkillsService } from "./match-skills.service";
import { PublishReachService } from "./publish-reach.service";
import { MatchFeedRepository } from "./match-feed.repository";
import { MatchFeedService } from "./match-feed.service";
import { MatchApplyService } from "./match-apply.service";
import { MatchCandidatesService } from "./match-candidates.service";
import { FreeTierService } from "./free-tier.service";
import { MatchConfigRepository } from "./match-config.repository";

/**
 * DI WIRING CONTRACT for the Matching V1 layer (ADR-0036).
 *
 * WHY THIS IS NOT CEREMONY. `MatchModule` is `@Global`, and FIVE modules that do not
 * import it consume its providers by injection alone: `ProfilesModule` (moments ①②),
 * `JobPostingsModule` (③), `ApplicationsModule` (④⑤), `PayerPortalModule` (⑥) and
 * `PostingPlansModule` (the boost supply gate). That means a provider dropped from
 * `exports` here does not fail where it was dropped — it fails at BOOT, in five other
 * modules, with a Nest resolution error, and every unit test in the repo still passes
 * because they all hand-build their collaborators. This file is the only thing between
 * that and a deploy.
 *
 * Asserted on the `@Module` METADATA rather than by constructing the container: the
 * repo's vitest setup does not emit `design:paramtypes`, so type-based DI cannot be
 * instantiated under the runner (the live boot is exercised by `nest build` and the
 * opt-in HTTP e2e suite). This is the same call `applications.module.boot.test.ts`
 * makes, for the same reason.
 */

const getMeta = (key: string, target: unknown): unknown[] =>
  (Reflect.getMetadata(key, target as object) as unknown[] | undefined) ?? [];

describe("MatchModule — the @Global matching layer's wiring", () => {
  it("is GLOBAL, which is what lets five non-importing modules inject it", () => {
    // If this reverts to a plain @Module, nothing here breaks — the five CONSUMERS
    // break, at boot, in files nobody touched.
    expect(Reflect.getMetadata("__module:global__", MatchModule)).toBe(true);
  });

  it("imports PayersModule — the source of PayerAuthGuard for the posting-form routes", () => {
    // `MatchSkillsController` is guarded by `PayerAuthGuard`, which is owned by
    // PayersModule. A guard used cross-module needs ITS dependencies reachable in the
    // importing module's injector or the app fails to boot with the controller mounted.
    expect(getMeta("imports", MatchModule)).toContain(PayersModule);
  });

  it("declares the posting-form controller", () => {
    expect(getMeta("controllers", MatchModule)).toEqual([MatchSkillsController]);
  });

  it("provides every service the six moments need, including both repositories", () => {
    const providers = getMeta("providers", MatchModule);
    for (const p of [
      MatchConfigRepository,
      MatchConfigService,
      WorkerSkillsRepository,
      WorkerSkillsService,
      MatchSkillsService,
      PublishReachService,
      MatchFeedRepository,
      MatchFeedService,
      MatchApplyService,
      MatchCandidatesService,
      FreeTierService,
    ]) {
      expect(providers, `${p.name} must be provided`).toContain(p);
    }
  });

  it("EXPORTS exactly the surface the five consumer modules inject", () => {
    // Enumerated deliberately: a provider silently dropped from this list is a boot
    // failure in another module, and `providers` above would still look complete.
    expect([...getMeta("exports", MatchModule)]).toEqual([
      MatchConfigService,
      WorkerSkillsService,
      WorkerSkillsRepository,
      MatchSkillsService,
      PublishReachService,
      MatchFeedRepository,
      MatchFeedService,
      MatchApplyService,
      MatchCandidatesService,
      FreeTierService,
    ]);
  });

  it("keeps MatchConfigRepository INTERNAL — config is read through the cached service", () => {
    // The service owns the 30s TTL, the fail-closed Zod fallback and the coalesced
    // cold-cache load. A consumer reaching the repository directly would bypass all
    // three and hit `match_config` on every feed request.
    expect(getMeta("exports", MatchModule)).not.toContain(MatchConfigRepository);
  });
});
