import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { FeatureRolloutModule } from "../feature-rollout/feature-rollout.module";
import { PostingAudienceRepository } from "../job-postings/posting-audience.repository";
import { PayersModule } from "../payers/payers.module";
import { CampusLinkModule } from "./campus-link.module";
import { CampusPostingReviewRepository } from "./campus-posting-review.repository";
import { CampusPostingReviewService } from "./campus-posting-review.service";
import { CampusReviewController } from "./campus-review.controller";
import { CampusReviewModule } from "./campus-review.module";
import { CampusTargetingOptionsRepository } from "./campus-targeting-options.repository";
import { CampusTargetingOptionsService } from "./campus-targeting-options.service";

const getMeta = (key: string, target: unknown): unknown[] =>
  (Reflect.getMetadata(key, target as object) as unknown[] | undefined) ?? [];

describe("CampusReviewModule wiring (#2746 PR 5)", () => {
  it("declares the review controller and nothing else as a controller", () => {
    expect(getMeta("controllers", CampusReviewModule)).toEqual([CampusReviewController]);
  });

  it("imports the guard's module, the rollout switch and the tenant resolver", () => {
    expect(getMeta("imports", CampusReviewModule)).toEqual(
      expect.arrayContaining([CampusLinkModule, FeatureRolloutModule, PayersModule]),
    );
  });

  it("provides both services, both repositories and PR 4's option read", () => {
    expect(getMeta("providers", CampusReviewModule)).toEqual(
      expect.arrayContaining([
        CampusPostingReviewService,
        CampusPostingReviewRepository,
        CampusTargetingOptionsService,
        CampusTargetingOptionsRepository,
        PostingAudienceRepository,
      ]),
    );
  });

  it("leaves CampusLinkModule's own controller list alone", () => {
    expect(getMeta("controllers", CampusLinkModule)).not.toContain(CampusReviewController);
  });
});
