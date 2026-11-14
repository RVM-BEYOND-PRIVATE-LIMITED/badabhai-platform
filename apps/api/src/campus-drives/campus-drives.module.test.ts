import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { AppModule } from "../app.module";
import { CampusLinkModule } from "../campus-link/campus-link.module";
import { RequestIdempotency } from "../common/idempotency/request-idempotency.service";
import { FeatureRolloutModule } from "../feature-rollout/feature-rollout.module";
import { PostingAudienceRepository } from "../job-postings/posting-audience.repository";
import { PayersModule } from "../payers/payers.module";
import { CampusDriveContactErasureRepository } from "./campus-drive-contact-erasure.repository";
import { CampusDriveDecisionsService } from "./campus-drive-decisions.service";
import { CampusDriveRequestsController } from "./campus-drive-requests.controller";
import { CampusDriveRequestsRepository } from "./campus-drive-requests.repository";
import { CampusDriveRequestsService } from "./campus-drive-requests.service";
import { CampusDrivesModule } from "./campus-drives.module";
import { PayerCampusDriveRequestsController } from "./payer-campus-drive-requests.controller";

const getMeta = (key: string, target: unknown): unknown[] =>
  (Reflect.getMetadata(key, target as object) as unknown[] | undefined) ?? [];

describe("CampusDrivesModule wiring (#2746 PR 6)", () => {
  it("is mounted in the app", () => {
    expect(getMeta("imports", AppModule)).toContain(CampusDrivesModule);
  });

  it("declares one controller per principal, and nothing else", () => {
    expect(getMeta("controllers", CampusDrivesModule)).toEqual([
      PayerCampusDriveRequestsController,
      CampusDriveRequestsController,
    ]);
  });

  it("imports the Campus guard's module, the rollout switch and the payer guards + tenancy", () => {
    expect(getMeta("imports", CampusDrivesModule)).toEqual(
      expect.arrayContaining([CampusLinkModule, FeatureRolloutModule, PayersModule]),
    );
  });

  it("provides both services, the repository, PR 4's option read and the idempotency seam", () => {
    expect(getMeta("providers", CampusDrivesModule)).toEqual(
      expect.arrayContaining([
        CampusDriveRequestsService,
        CampusDriveDecisionsService,
        CampusDriveRequestsRepository,
        PostingAudienceRepository,
        RequestIdempotency,
      ]),
    );
  });

  it("the account deletion's module provides the contact erasure (no module edge back)", () => {
    expect(getMeta("providers", PayersModule)).toContain(CampusDriveContactErasureRepository);
    expect(getMeta("imports", PayersModule)).not.toContain(CampusDrivesModule);
  });

  it("leaves CampusLinkModule's own controllers alone", () => {
    expect(getMeta("controllers", CampusLinkModule)).not.toContain(CampusDriveRequestsController);
  });
});
