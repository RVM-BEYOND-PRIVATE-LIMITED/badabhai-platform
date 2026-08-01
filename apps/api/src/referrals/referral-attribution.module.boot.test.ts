import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { ReferralAttributionModule } from "./referral-attribution.module";
import { ReferralAttributionController } from "./referral-attribution.controller";
import { ReferralBonusController } from "./referral-bonus.controller";
import { WorkerActivityInterceptor } from "./worker-activity.interceptor";
import { ProfilesModule } from "../profiles/profiles.module";
import { UnlocksModule } from "../unlocks/unlocks.module";
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

  // ---- B4 / §X.6 additions hosted by this module ----

  it("declares the MOCK ₹20 bonus controller + service + repository + queue processor", () => {
    expect(getMeta("controllers", ReferralAttributionModule)).toContain(ReferralBonusController);
    const names = getMeta("providers", ReferralAttributionModule).map((p) =>
      typeof p === "function" ? p.name : p,
    );
    expect(names).toContain("ReferralBonusService");
    expect(names).toContain("ReferralBonusRepository");
    // The CONSUMER of the two real triggers. Without it the rule is inert again.
    expect(names).toContain("ReferralBonusProcessor");
  });

  it("the bonus trigger is a QUEUE, so neither producer module depends on this one", () => {
    // The whole point of the queue seam: `profiles` and `unlocks` register the queue and
    // enqueue; they must NEVER import ReferralAttributionModule (cycle + blast radius).
    for (const mod of [ProfilesModule, UnlocksModule]) {
      expect(getMeta("imports", mod)).not.toContain(ReferralAttributionModule);
    }
    // ...and this module must not import them either — the edge is Redis, not DI.
    const imports = getMeta("imports", ReferralAttributionModule);
    expect(imports).not.toContain(ProfilesModule);
    expect(imports).not.toContain(UnlocksModule);
  });

  it("registers the worker.active producer as a GLOBAL APP_INTERCEPTOR", () => {
    // Registering it under this token is what makes it apply to every authenticated
    // request WITHOUT editing any controller, guard, or other module — if this provider
    // is dropped, the X.6 retention signal silently stops being produced.
    const provider = getMeta("providers", ReferralAttributionModule).find(
      (p): p is { provide: string; useClass: unknown } =>
        typeof p === "object" && p !== null && "provide" in p,
    );
    expect(provider?.provide).toBe(APP_INTERCEPTOR);
    expect(provider?.useClass).toBe(WorkerActivityInterceptor);
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
