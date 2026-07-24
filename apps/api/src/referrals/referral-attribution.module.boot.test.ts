import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { ReferralAttributionModule } from "./referral-attribution.module";
import { ReferralAttributionController } from "./referral-attribution.controller";
import { ConsentModule } from "../consent/consent.module";
import { MessagingModule } from "../messaging/messaging.module";
import { AgencyModule } from "../agency/agency.module";
import { AuthModule } from "../auth/auth.module";
import { WorkerAuthGuard } from "../auth/worker-auth.guard";
import { InviteService } from "../messaging/invite.service";
import { AgencyService } from "../agency/agency.service";

/**
 * DI WIRING REGRESSION GUARD (ADR-0022 Amendment 1 — referral attribution).
 *
 * Same rationale + technique as applications.module.boot.test.ts: assert the eager
 * @Module / @UseGuards metadata (the wiring CONTRACT) rather than instantiating the
 * container (the repo's vitest setup emits no `design:paramtypes`; the live boot is
 * exercised by `nest build`). This protects the two seams this module depends on being
 * REACHABLE — MessagingModule must EXPORT InviteService (added with this feature) and
 * AgencyModule must EXPORT AgencyService — and the acyclic import set (nothing here
 * imports back into the modules that import ConsentModule).
 */

const getMeta = (key: string, target: unknown): unknown[] =>
  (Reflect.getMetadata(key, target as object) as unknown[] | undefined) ?? [];

describe("ReferralAttributionModule wiring (attribution seam DI regression guard)", () => {
  it("imports the four one-directional deps (Consent, Messaging, Agency, Auth)", () => {
    const imports = getMeta("imports", ReferralAttributionModule);
    expect(imports).toContain(ConsentModule);
    expect(imports).toContain(MessagingModule);
    expect(imports).toContain(AgencyModule);
    expect(imports).toContain(AuthModule);
  });

  it("declares the controller + service", () => {
    expect(getMeta("controllers", ReferralAttributionModule)).toContain(
      ReferralAttributionController,
    );
    const providers = getMeta("providers", ReferralAttributionModule).map((p) =>
      typeof p === "function" ? p.name : p,
    );
    expect(providers).toContain("ReferralAttributionService");
  });

  it("MessagingModule EXPORTS InviteService (the worker→worker seam this feature needs)", () => {
    // Regression guard: the export added with this feature. Without it the module fails
    // to boot ("InviteService is not exported by MessagingModule").
    expect(getMeta("exports", MessagingModule)).toContain(InviteService);
  });

  it("AgencyModule EXPORTS AgencyService (the agency→worker seam)", () => {
    expect(getMeta("exports", AgencyModule)).toContain(AgencyService);
  });

  it("POST /referrals/attribute is guarded by WorkerAuthGuard (session worker id, not body)", () => {
    const guards = getMeta("__guards__", ReferralAttributionController.prototype.attribute);
    expect(guards).toEqual([WorkerAuthGuard]);
  });
});
