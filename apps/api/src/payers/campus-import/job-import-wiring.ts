/**
 * #2754 item 7 — the job import's collaborators, built by hand for the CLI (and the DB gate) the way
 * Nest would build them for `CampusPostingsService.postForCompany`.
 *
 * WHY BY HAND. Booting the API's Nest graph from a CLI would also start every BullMQ processor and
 * repeatable sweep in the process (there is no switch to keep them off), which on the production
 * box would run a second copy of each sweep. The `createForCampus` path needs only the repository,
 * events, the tenant scope and the audience service; nothing on it calls the AI, reach, match-skill
 * or trade services when the posting carries no skills, trade form or `role_kind` (the import sets
 * none). Those are given a FAIL-CLOSED stand-in: any call throws, so a future change that reaches
 * one stops the import loudly instead of doing work nobody reviewed for it.
 */
import type { ServerConfig } from "@badabhai/config";
import type { Database } from "@badabhai/db";
import type { TenantKey } from "../payer-tenant-scope";
import type { EventsService } from "../../events/events.service";
import { JobPostingsService } from "../../job-postings/job-postings.service";
import { JobPostingsRepository } from "../../job-postings/job-postings.repository";
import { PostingAudienceRepository } from "../../job-postings/posting-audience.repository";
import { PostingAudienceService } from "../../job-postings/posting-audience.service";
import { FeatureRolloutService } from "../../feature-rollout/feature-rollout.service";
import { FeaturePilotRepository } from "../../feature-rollout/feature-pilot.repository";
import { CampusPostingsRepository } from "../../campus-link/campus-postings.repository";
import { PayerTenantScopeService } from "../payer-tenant-scope.service";
import { PayerOrgsRepository } from "../payer-orgs.repository";
import { postingIsHeld, type JobImportDeps } from "./import-jobs";

/** A collaborator the import must never reach: every property is a function that throws. */
export function unavailableInImport(name: string): never {
  return new Proxy(
    {},
    {
      get: (_target, prop) => {
        // Not a thenable: `await` on the stand-in must not look like a call.
        if (prop === "then") return undefined;
        return () => {
          throw new Error(`${name}.${String(prop)} is not available in the Campus import`);
        };
      },
    },
  ) as never;
}

export function buildJobImportDeps(db: Database, config: ServerConfig, events: EventsService): JobImportDeps {
  const tenancy = new PayerTenantScopeService(config, new PayerOrgsRepository(db));
  const audienceRepo = new PostingAudienceRepository(db);
  const audience = new PostingAudienceService(
    // The worker and admin pilot lists have one reader, the rollout service
    // inside the API; the audience path reads only the company pilot list, so here it is a stand-in.
    new FeatureRolloutService(config, new FeaturePilotRepository(db), unavailableInImport("the worker and admin pilot lists")),
    audienceRepo,
    events,
  );
  const jobsRepo = new JobPostingsRepository(db);
  const postings = new JobPostingsService(
    jobsRepo,
    events,
    unavailableInImport("AiService"),
    unavailableInImport("AiCostRecorder"),
    unavailableInImport("AiTraceRecorder"),
    unavailableInImport("PublishReachService"),
    unavailableInImport("MatchSkillsService"),
    unavailableInImport("PostingTradesService"),
    tenancy,
    audience,
  );
  const campusPostings = new CampusPostingsRepository(db);
  return {
    db,
    // #2903 adds `createForCampus`'s `opts` (the hold origin). Called through Reflect.apply so this
    // file compiles on either side of #2903 with no type assertion on a tenant scope; once #2903 is
    // on main this becomes a plain call. Without #2903 the origin is ignored, and the jobs step is
    // gated on --worker-hold-live and checks every posting's hold.
    creator: {
      createForCampus: (scope, dto, targeting, ctx, opts) =>
        Reflect.apply(postings.createForCampus, postings, [scope, dto, targeting, ctx, opts]),
    },
    ownerScope: async (companyId) =>
      (await tenancy.resolveReadOnly(companyId)) ?? (await tenancy.resolve(companyId)),
    activeBranchRefs: (refs) => audienceRepo.activeOptionRefs("branch", refs),
    approve: (tx, id, ref) => campusPostings.approveAsCreated(tx, id, ref),
    close: async (id, tenant: TenantKey) => {
      await jobsRepo.transitionOwned(id, tenant, "open", "closed");
    },
    isHeld: (id) => postingIsHeld(db, id),
  };
}
