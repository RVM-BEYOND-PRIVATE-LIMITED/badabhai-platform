import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { AdminModule } from "./admin.module";
import { AdminAuthController } from "./admin-auth.controller";
import { AdminRepository } from "./admin.repository";
import { AdminSessionService } from "./admin-session.service";
import { AdminOtpService } from "./admin-otp.service";
import { AdminMfaSecretStore } from "./admin-mfa.store";
import { AdminAuthService } from "./admin-auth.service";
import { AdminAuthGuard } from "./admin-auth.guard";
import { AdminRolesGuard } from "./admin-roles.guard";
import { AdminActionsController } from "./admin-actions.controller";
import { AdminPiiRevealController } from "./admin-pii-reveal.controller";
import { AdminDashboardController } from "./admin-dashboard.controller";
import { AdminWorkerJourneyController } from "./admin-worker-journey.controller";
import { DatabaseModule } from "../database/database.module";
import { EventsModule } from "../events/events.module";

/**
 * DI WIRING REGRESSION GUARD (ADR-0025 ADMIN-1) — mirrors the PayerPortalModule boot guard.
 * Asserts the Nest module/route METADATA (defined eagerly by @Module/@UseGuards) rather than
 * building the container. Catches a dropped import/provider/guard typecheck cannot see.
 */
const getMeta = (key: string, target: unknown): unknown[] =>
  (Reflect.getMetadata(key, target as object) as unknown[] | undefined) ?? [];

const providerTokens = (): unknown[] =>
  getMeta("providers", AdminModule).map((p) =>
    typeof p === "function" ? p.name : (p as { provide?: unknown }).provide,
  );

describe("AdminModule wiring (DI regression guard)", () => {
  it("imports DatabaseModule + EventsModule (admin_users data access + the event spine)", () => {
    const imports = getMeta("imports", AdminModule);
    expect(imports).toContain(DatabaseModule);
    expect(imports).toContain(EventsModule);
  });

  it("declares the admin auth controller", () => {
    expect(getMeta("controllers", AdminModule)).toContain(AdminAuthController);
  });

  it("declares the ADMIN-3a governed-actions controller + provides its service/repository", () => {
    expect(getMeta("controllers", AdminModule)).toContain(AdminActionsController);
    const tokens = providerTokens();
    expect(tokens).toContain("AdminActionsService");
    expect(tokens).toContain("AdminActionsRepository");
  });

  it("declares the ADMIN-3b PII-reveal controller + provides its service/repository/cap (default-OFF flag)", () => {
    expect(getMeta("controllers", AdminModule)).toContain(AdminPiiRevealController);
    const tokens = providerTokens();
    expect(tokens).toContain("AdminPiiRevealService");
    expect(tokens).toContain("AdminPiiRevealRepository");
    expect(tokens).toContain("AdminPiiRevealCapService");
  });

  it("declares the BP-5 dashboard controller + provides its service/repository AND the spine reader it depends on", () => {
    expect(getMeta("controllers", AdminModule)).toContain(AdminDashboardController);
    const tokens = providerTokens();
    expect(tokens).toContain("AdminDashboardService");
    expect(tokens).toContain("AdminDashboardRepository");
    // `AdminDashboardService` injects `AdminEventsRepository` for the cap-breach-by-reason
    // split. Nest resolves that only because the events repository is a provider here too —
    // a dropped registration is a BOOT failure that typecheck, lint and every unit test miss.
    expect(tokens).toContain("AdminEventsRepository");
  });

  it("provides the repository, session, OTP, MFA-store, auth service, and both guards", () => {
    const tokens = providerTokens();
    expect(tokens).toContain("AdminRepository");
    expect(tokens).toContain("AdminSessionService");
    expect(tokens).toContain("AdminOtpService");
    expect(tokens).toContain("AdminMfaSecretStore");
    expect(tokens).toContain("AdminAuthService");
    expect(tokens).toContain("AdminAuthGuard");
    expect(tokens).toContain("AdminRolesGuard");
  });

  it("exports the guards + session + repository for ADMIN-2/3 reuse", () => {
    const exported = getMeta("exports", AdminModule);
    expect(exported).toContain(AdminAuthGuard);
    expect(exported).toContain(AdminRolesGuard);
    expect(exported).toContain(AdminSessionService);
    expect(exported).toContain(AdminRepository);
  });

  it("the auth controller has NO class-level guard (login/MFA public; refresh/logout/me guarded per-method)", () => {
    // Mirrors PayerAuthController: the class metadata is empty; AdminAuthGuard is method-level.
    expect(getMeta("__guards__", AdminAuthController)).toHaveLength(0);
  });

  it("declares the Phase 6 worker-journey controller + provides its service/repository", () => {
    // One new module edge is all it takes to make the app fail to BOOT while typecheck, lint,
    // build and every unit suite stay green — a controller declared with a provider missing
    // resolves to null at container build, not at compile.
    expect(getMeta("controllers", AdminModule)).toContain(AdminWorkerJourneyController);
    const tokens = providerTokens();
    expect(tokens).toContain("AdminWorkerJourneyService");
    expect(tokens).toContain("AdminWorkerJourneyRepository");
  });

  it("the providers reference the real classes (no accidental shadowing)", () => {
    const providers = getMeta("providers", AdminModule);
    expect(providers).toContain(AdminRepository);
    expect(providers).toContain(AdminSessionService);
    expect(providers).toContain(AdminOtpService);
    expect(providers).toContain(AdminMfaSecretStore);
    expect(providers).toContain(AdminAuthService);
    expect(providers).toContain(AdminAuthGuard);
    expect(providers).toContain(AdminRolesGuard);
  });
});
