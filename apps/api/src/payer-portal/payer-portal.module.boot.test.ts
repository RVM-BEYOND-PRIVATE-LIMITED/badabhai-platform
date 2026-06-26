import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { PayerPortalModule } from "./payer-portal.module";
import { PayerAuthController } from "./payer-auth.controller";
import { PayerUnlocksController } from "./payer-unlocks.controller";
import { PayerReachController } from "./payer-reach.controller";
import { PayerDisclosureController } from "./payer-disclosure.controller";
import { PayerJobPostingsController } from "./payer-job-postings.controller";
import { PayersModule } from "../payers/payers.module";
import { UnlocksModule } from "../unlocks/unlocks.module";
import { ReachModule } from "../reach/reach.module";
import { ResumeDisclosureModule } from "../disclosures/resume-disclosure.module";
import { JobPostingsModule } from "../job-postings/job-postings.module";
import { PayerAuthGuard } from "../payers/payer-auth.guard";
import {
  PAYER_LOGIN_CHANNEL,
  MockEmailLoginChannel,
  WhatsAppLoginChannel,
  SupabaseLoginChannel,
  type PayerLoginChannel,
} from "../payers/payer-login-channel";
import { ZeptoMailEmailLoginChannel } from "../payers/zeptomail-email-login-channel";
import { WHATSAPP_PROVIDER } from "../messaging/whatsapp.provider";
import type { ServerConfig } from "@badabhai/config";

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

/** Resolve the PAYER_LOGIN_CHANNEL factory provider declared on the module. */
type FactoryProvider = {
  provide?: unknown;
  inject?: unknown[];
  useFactory?: (...args: unknown[]) => PayerLoginChannel;
};
const loginChannelProvider = (): FactoryProvider =>
  getMeta("providers", PayerPortalModule).find(
    (p) => (p as FactoryProvider).provide === PAYER_LOGIN_CHANNEL,
  ) as FactoryProvider;

// Lightweight channel stubs the factory selects between (only .mock is asserted).
const mockEmail = { method: "email_otp", mock: true } as unknown as MockEmailLoginChannel;
const realEmail = { method: "email_otp", mock: false } as unknown as ZeptoMailEmailLoginChannel;
const whatsapp = { method: "whatsapp", mock: true } as unknown as WhatsAppLoginChannel;
const supabase = { method: "supabase", mock: false } as unknown as SupabaseLoginChannel;

/** Run the real PAYER_LOGIN_CHANNEL useFactory with a given config (other args stubbed). */
const resolveChannel = (config: Partial<ServerConfig>): PayerLoginChannel => {
  const provider = loginChannelProvider();
  return provider.useFactory!(config as ServerConfig, mockEmail, realEmail, whatsapp, supabase);
};

describe("PayerPortalModule wiring (cross-module DI regression guard)", () => {
  it("imports PayersModule + UnlocksModule + ReachModule + ResumeDisclosureModule (the reused chokepoints)", () => {
    const imports = getMeta("imports", PayerPortalModule);
    expect(imports).toContain(PayersModule);
    expect(imports).toContain(UnlocksModule);
    expect(imports).toContain(ReachModule); // R22 reach-view reuse
    expect(imports).toContain(ResumeDisclosureModule); // payer masked-resume view reuse
    expect(imports).toContain(JobPostingsModule); // payer self-serve posting reuse
  });

  it("declares the auth + unlocks + reach + disclosure + job-postings payer controllers", () => {
    const controllers = getMeta("controllers", PayerPortalModule);
    expect(controllers).toContain(PayerAuthController);
    expect(controllers).toContain(PayerUnlocksController);
    expect(controllers).toContain(PayerReachController);
    expect(controllers).toContain(PayerDisclosureController);
    expect(controllers).toContain(PayerJobPostingsController);
  });

  it("provides the auth service, OTP store, XB-G cap, and all four login channels", () => {
    const tokens = providerTokens();
    expect(tokens).toContain("PayerAuthService");
    expect(tokens).toContain("PayerOtpService");
    expect(tokens).toContain("PayerDisclosureRateLimit");
    expect(tokens).toContain("MockEmailLoginChannel");
    expect(tokens).toContain("ZeptoMailEmailLoginChannel");
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
    expect(getMeta("__guards__", PayerJobPostingsController)).toContain(PayerAuthGuard);
    // PayerAuthController: NO class-level guard (signup/login are public; refresh/logout
    // are guarded per-method, so the class metadata must be empty).
    expect(getMeta("__guards__", PayerAuthController)).toHaveLength(0);
  });
});

describe("PayerPortalModule PAYER_LOGIN_CHANNEL factory selection (OTP-2)", () => {
  it("email_otp + EMAIL_PROVIDER=zeptomail resolves the REAL ZeptoMail channel (mock=false)", () => {
    const channel = resolveChannel({
      PAYER_LOGIN_METHOD: "email_otp",
      EMAIL_PROVIDER: "zeptomail",
    });
    expect(channel).toBe(realEmail);
    expect(channel.mock).toBe(false);
  });

  it("email_otp + EMAIL_PROVIDER=smtp resolves the REAL channel (mock=false)", () => {
    const channel = resolveChannel({ PAYER_LOGIN_METHOD: "email_otp", EMAIL_PROVIDER: "smtp" });
    expect(channel).toBe(realEmail);
    expect(channel.mock).toBe(false);
  });

  it("email_otp + EMAIL_PROVIDER=none resolves the alpha MOCK channel (mock=true)", () => {
    const channel = resolveChannel({ PAYER_LOGIN_METHOD: "email_otp", EMAIL_PROVIDER: "none" });
    expect(channel).toBe(mockEmail);
    expect(channel.mock).toBe(true);
  });

  it("whatsapp / supabase arms are unchanged by the EMAIL_PROVIDER switch", () => {
    expect(resolveChannel({ PAYER_LOGIN_METHOD: "whatsapp", EMAIL_PROVIDER: "zeptomail" })).toBe(
      whatsapp,
    );
    expect(resolveChannel({ PAYER_LOGIN_METHOD: "supabase", EMAIL_PROVIDER: "zeptomail" })).toBe(
      supabase,
    );
  });
});
