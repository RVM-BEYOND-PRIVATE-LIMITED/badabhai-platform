import { loadServerConfig } from "@badabhai/config";
import type { Database } from "@badabhai/db";
import type { EventsService } from "../events/events.service";
import { FeaturePilotRepository } from "../feature-rollout/feature-pilot.repository";
import { FeatureRolloutService } from "../feature-rollout/feature-rollout.service";
import { PostingAudienceRepository } from "./posting-audience.repository";
import { PostingAudienceService } from "./posting-audience.service";

/**
 * #2746 — the REAL `PostingAudienceService` over a database, for the DB-backed suites that build
 * `JobPostingsService` by hand. `env` sets the switch (`JOB_AUDIENCE_ROLLOUT`); the default is the
 * API config's default, `off`, which is production's posture until the pilot.
 */
export function postingAudienceOver(
  db: Database,
  events: EventsService,
  env: Record<string, string> = {},
): PostingAudienceService {
  const config = loadServerConfig({ NODE_ENV: "test", ...env });
  return new PostingAudienceService(
    new FeatureRolloutService(config, new FeaturePilotRepository(db)),
    new PostingAudienceRepository(db),
    events,
  );
}

/**
 * For the unit suites that never send an audience: no field is ever requested, every write hook
 * is a no-op and a read returns its postings unchanged. A suite that exercises the audience uses
 * the real service (`posting-audience.service.test.ts`, `payer-job-audience.db.test.ts`).
 */
export function inertPostingAudience(): PostingAudienceService {
  return {
    requestedBy: async () => null,
    resolveCreate: async () => null,
    recordCreateWithin: async () => undefined,
    recordUpdateWithin: async () => undefined,
    payerViews: async (_scope: unknown, postings: readonly unknown[]) => [...postings],
  } as unknown as PostingAudienceService;
}
