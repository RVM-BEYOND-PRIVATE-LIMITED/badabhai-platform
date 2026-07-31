import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { PayerPortalModule } from "../payer-portal.module";
import { PayersModule } from "../../payers/payers.module";
import { JobPostingsModule } from "../../job-postings/job-postings.module";
import { JobPostingChatModule } from "./job-posting-chat.module";
import { JobPostingChatController } from "./job-posting-chat.controller";
import { JobPostingChatService } from "./job-posting-chat.service";
import { JobPostingChatRepository } from "./job-posting-chat.repository";

/**
 * DI WIRING REGRESSION GUARD (ADR-0035), mirroring `payer-portal.module.boot.test.ts`.
 * Asserts the Nest module METADATA (defined eagerly by `@Module`) rather than building
 * the container — the repo's vitest setup does not emit `design:paramtypes`. Catches a
 * dropped import/provider that typecheck cannot see.
 */
const getMeta = (key: string, target: unknown): unknown[] =>
  (Reflect.getMetadata(key, target as object) as unknown[] | undefined) ?? [];

describe("JobPostingChatModule wiring", () => {
  it("is mounted by PayerPortalModule (so the routes exist at all)", () => {
    expect(getMeta("imports", PayerPortalModule)).toContain(JobPostingChatModule);
  });

  it("imports PayersModule (the EXISTING guard + the only orgNameEnc reader)", () => {
    expect(getMeta("imports", JobPostingChatModule)).toContain(PayersModule);
  });

  it("imports JobPostingsModule — publish REUSES createForPayer, it does not fork it", () => {
    // The load-bearing assertion of this whole slice: the publish step depends on the
    // shipped job-posting service, which is what keeps `job_posting.created` a
    // single-writer event (ADR-0035 §Decision 6).
    expect(getMeta("imports", JobPostingChatModule)).toContain(JobPostingsModule);
  });

  it("declares the controller and both providers (thin controller → service → repository)", () => {
    expect(getMeta("controllers", JobPostingChatModule)).toContain(JobPostingChatController);
    const providers = getMeta("providers", JobPostingChatModule);
    expect(providers).toContain(JobPostingChatService);
    expect(providers).toContain(JobPostingChatRepository);
  });

  it("exports NOTHING — this is a leaf route group, not a shared chokepoint", () => {
    expect(getMeta("exports", JobPostingChatModule)).toHaveLength(0);
  });
});
