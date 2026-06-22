import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { PayerPortalModule } from "./payer-portal.module";
import { PayerAuthController } from "./payer-auth.controller";
import { PayerUnlocksController } from "./payer-unlocks.controller";
import { PayerReachController } from "./payer-reach.controller";
import { PayerDisclosureController } from "./payer-disclosure.controller";
import { PayersModule } from "../payers/payers.module";
import { UnlocksModule } from "../unlocks/unlocks.module";
import { ReachModule } from "../reach/reach.module";
import { ResumeDisclosureModule } from "../disclosures/resume-disclosure.module";
import { PayerAuthGuard } from "../payers/payer-auth.guard";
import { PAYER_LOGIN_CHANNEL } from "../payers/payer-login-channel";
import { WHATSAPP_PROVIDER } from "../messaging/whatsapp.provider";

/**
 * DI WIRING REGRESSION GUARD (ADR-0019 Phase 1) — mirrors UnlocksModule's boot guard.
 * Asserts the Nest module/route METADATA (defined eagerly by @Module/@UseGuards) rather
 * than building the container (the repo's vitest setup does not emit design:paramtypes).
 * Catches a dropped import/provider/guard that typecheck cannot see.
 */
const getMeta = (key: string, target: unknown): unknown[] =>
  (Reflect.getMetadata(key, target as object) as unknown[] | undefined) ?? [];

const providerTokens = (): unknown[] =>
  getMeta("providers", PayerPortalModule).map((p) =>
    typeof p === "function" ? p.name : (p as { provide?: unknown }).provide,
  );

describe("PayerPortalModule wiring (cross-module DI regression guard)", () => {
  it("imports PayersModule + UnlocksModule + ReachModule + ResumeDisclosureModule (the reused chokepoints)", () => {
    const imports = getMeta("imports", PayerPortalModule);
    expect(imports).toContain(PayersModule);
    expect(imports).toContain(UnlocksModule);
    expect(imports).toContain(ReachModule); // R22 reach-view reuse
    expect(imports).toContain(ResumeDisclosureModule); // payer masked-resume view reuse
  });

  it("declares the auth + unlocks + reach + disclosure payer controllers", () => {
    const controllers = getMeta("controllers", PayerPortalModule);
    expect(controllers).toContain(PayerAuthController);
    expect(controllers).toContain(PayerUnlocksController);
    expect(controllers).toContain(PayerReachController);
    expect(controllers).toContain(PayerDisclosureController);
  });

  it("provides the auth service, OTP store, XB-G cap, and all three login channels", () => {
    const tokens = providerTokens();
    expect(tokens).toContain("PayerAuthService");
    expect(tokens).toContain("PayerOtpService");
    expect(tokens).toContain("PayerDisclosureRateLimit");
    expect(tokens).toContain("MockEmailLoginChannel");
    expect(tokens).toContain("WhatsAppLoginChannel");
    expect(tokens).toContain("SupabaseLoginChannel");
  });

  it("provides the config-selected channel + WhatsApp provider tokens (the factory seams)", () => {
    const tokens = providerTokens();
    expect(tokens).toContain(PAYER_LOGIN_CHANNEL);
    expect(tokens).toContain(WHATSAPP_PROVIDER);
  });

  it("the unlocks + reach + disclosure controllers are class-guarded by PayerAuthGuard; auth is PUBLIC", () => {
    // PayerUnlocksController + PayerReachController + PayerDisclosureController: every route
    // requires a payer session.
    expect(getMeta("__guards__", PayerUnlocksController)).toContain(PayerAuthGuard);
    expect(getMeta("__guards__", PayerReachController)).toContain(PayerAuthGuard);
    expect(getMeta("__guards__", PayerDisclosureController)).toContain(PayerAuthGuard);
    // PayerAuthController: NO class-level guard (signup/login are public; refresh/logout
    // are guarded per-method, so the class metadata must be empty).
    expect(getMeta("__guards__", PayerAuthController)).toHaveLength(0);
  });
});
