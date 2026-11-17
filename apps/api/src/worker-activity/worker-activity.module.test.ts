import "reflect-metadata";
import { MODULE_METADATA } from "@nestjs/common/constants";
import { describe, expect, it } from "vitest";
import { AgencyModule } from "../agency/agency.module";
import { CampusJobsModule } from "../campus-link/campus-jobs.module";
import { MatchModule } from "../match/match.module";
import { ReferralAttributionModule } from "../referrals/referral-attribution.module";
import { StillLookingModule } from "../still-looking/still-looking.module";
import { WorkerActivityModule } from "./worker-activity.module";
import { WorkerActivityRepository } from "./worker-activity.repository";
import { WorkerActivityService } from "./worker-activity.service";

/**
 * #2753 — every consumer injects `WorkerActivityService` as `@Optional()` (so hand-built unit
 * instances compile). The price of that is that a dropped module import would NOT fail the boot:
 * Nest would inject `undefined`, and that surface would quietly behave as if the switch were off.
 * This file is the check that replaces the boot failure.
 */
const meta = (key: string, target: object): unknown[] =>
  (Reflect.getMetadata(key, target) as unknown[] | undefined) ?? [];

describe("WorkerActivityModule wiring", () => {
  it("provides the repository and the service, and exports the service only", () => {
    expect(meta(MODULE_METADATA.PROVIDERS, WorkerActivityModule)).toEqual([
      WorkerActivityRepository,
      WorkerActivityService,
    ]);
    expect(meta(MODULE_METADATA.EXPORTS, WorkerActivityModule)).toEqual([WorkerActivityService]);
  });

  it("is a leaf: it imports nothing, so no consumer can close a cycle through it", () => {
    expect(meta(MODULE_METADATA.IMPORTS, WorkerActivityModule)).toEqual([]);
  });

  it.each([
    ["ReferralAttributionModule (the request interceptor)", ReferralAttributionModule],
    ["MatchModule (the applicant, inbox and search rows)", MatchModule],
    ["AgencyModule (the referred-workers list)", AgencyModule],
    ["CampusJobsModule (a Campus application)", CampusJobsModule],
    [
      "StillLookingModule (the monthly check: the card's day and mark, the touch)",
      StillLookingModule,
    ],
  ])("%s imports it", (_name, mod) => {
    expect(meta(MODULE_METADATA.IMPORTS, mod)).toContain(WorkerActivityModule);
  });
});
