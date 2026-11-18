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
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { ServerConfig } from "@badabhai/config";
import { jobPostings, type Database } from "@badabhai/db";
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
import type { RollbackDeps } from "./rollback";
import { WelcomeCreditsService } from "../../credit-rules/welcome-credits.service";
import { WelcomeCreditsRepository } from "../../credit-rules/welcome-credits.repository";
import { CreditRulesService } from "../../credit-rules/credit-rules.service";
import { CreditRulesRepository } from "../../credit-rules/credit-rules.repository";

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

function buildPostings(db: Database, config: ServerConfig, events: EventsService) {
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
  return { tenancy, audienceRepo, jobsRepo, postings };
}

export function buildJobImportDeps(db: Database, config: ServerConfig, events: EventsService): JobImportDeps {
  const { tenancy, audienceRepo, jobsRepo, postings } = buildPostings(db, config, events);
  const campusPostings = new CampusPostingsRepository(db);
  return {
    db,
    // #2891 — the posting is written with its worker visibility `off`, origin `campus_imported`,
    // in the creator's own transaction (#2903); the jobs step still checks every posting's hold.
    creator: {
      createForCampus: (scope, dto, targeting, ctx, opts) =>
        postings.createForCampus(scope, dto, targeting, ctx, opts),
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

/**
 * #2754 item 14 — the rollback's posting close: the posting service's own ops close (it stamps
 * `closed_at` and writes `job_posting.closed`). A posting its company paused since the import is
 * resumed first so it can be closed; one frozen by a payer suspension is left frozen and counted.
 */
export function buildRollbackDeps(db: Database, config: ServerConfig, events: EventsService): RollbackDeps {
  const { tenancy, jobsRepo, postings } = buildPostings(db, config, events);
  return {
    db,
    events,
    closePosting: async (postingId) => {
      const [row] = await db
        .select({ status: jobPostings.status, payerId: jobPostings.payerId })
        .from(jobPostings)
        .where(eq(jobPostings.id, postingId));
      if (!row || row.status === "closed") return "already_closed";
      if (row.status === "suspended" || row.payerId === null) return "not_closeable";
      if (row.status === "paused") {
        const scope = (await tenancy.resolveReadOnly(row.payerId)) ?? (await tenancy.resolve(row.payerId));
        await jobsRepo.transitionOwned(postingId, scope.tenantKey, "paused", "open");
      }
      await postings.close(postingId, { requestId: `campus-rollback:${postingId}`, correlationId: randomUUID() });
      return "closed";
    },
  };
}

/**
 * #2754 item 10 — #2750's welcome grant, built by hand as Nest would build it. The rollout service
 * reads only the company pilot list for `credit_rules`; the worker and admin lists are stand-ins.
 */
export function buildWelcomeCredits(db: Database, config: ServerConfig, events: EventsService): WelcomeCreditsService {
  const rollout = new FeatureRolloutService(
    config,
    new FeaturePilotRepository(db),
    unavailableInImport("the worker and admin pilot lists"),
  );
  return new WelcomeCreditsService(
    new WelcomeCreditsRepository(db),
    new CreditRulesService(new CreditRulesRepository(db), events, rollout),
    rollout,
    new PayerTenantScopeService(config, new PayerOrgsRepository(db)),
    events,
  );
}
