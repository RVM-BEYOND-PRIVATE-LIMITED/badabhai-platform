import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CREDIT_RULES, parseCreditRules } from "@badabhai/pricing";
import { WelcomeCreditsService } from "./welcome-credits.service";
import type { WelcomeEligibilityFacts } from "./welcome-credits.repository";

const ctx = { correlationId: "c0000000-0000-4000-8000-000000000001", requestId: "r-1" } as never;
const OWNER = "a0000000-0000-4000-8000-000000000001";
const TENANT = "b0000000-0000-4000-8000-000000000002";
const LOT = "c0000000-0000-4000-8000-000000000003";

const ELIGIBLE: WelcomeEligibilityFacts = {
  role: "employer",
  status: "active",
  verificationStatus: "verified",
  hasGstNumber: true,
  phoneProven: false,
  hasApprovedPosting: true,
};

function harness(
  opts: {
    facts?: Partial<WelcomeEligibilityFacts>;
    rules?: "on" | "off" | "unavailable";
    tenant?: string | null;
    applied?: boolean;
    welcomeCredits?: number;
  } = {},
) {
  const emitted: Record<string, unknown>[] = [];
  const repo = {
    eligibility: vi.fn(async () => ({ ...ELIGIBLE, ...opts.facts })),
    grantOnce: vi.fn(
      async (
        _tenant: string,
        _input: { credits: number; expiresAt: Date },
        afterGrant: (tx: unknown, lotId: string) => Promise<void>,
      ) => {
        const applied = opts.applied ?? true;
        if (applied) await afterGrant({ tx: true }, LOT);
        return applied
          ? { applied: true, balanceAfter: 5, lotId: LOT, ledgerId: "l", alignment: {} }
          : { applied: false, balanceAfter: 5, ledgerId: "l", alignment: {} };
      },
    ),
  };
  const rules = {
    get: vi.fn(async () =>
      parseCreditRules({
        ...DEFAULT_CREDIT_RULES,
        welcomeCredits: opts.welcomeCredits ?? DEFAULT_CREDIT_RULES.welcomeCredits,
      }),
    ),
  };
  const rollout = { stateFor: vi.fn(async () => opts.rules ?? "on") };
  const tenancy = {
    resolveReadOnly: vi.fn(async () =>
      opts.tenant === null ? null : { tenantKey: opts.tenant ?? TENANT },
    ),
  };
  const events = { emit: vi.fn(async (e: Record<string, unknown>) => emitted.push(e)) };
  const service = new WelcomeCreditsService(
    repo as never,
    rules as never,
    rollout as never,
    tenancy as never,
    events as never,
  );
  return { service, repo, rollout, tenancy, events, emitted };
}

describe("the welcome rule (B7-06)", () => {
  const missing = (facts: Partial<WelcomeEligibilityFacts>) =>
    WelcomeCreditsService.ineligibility({ ...ELIGIBLE, ...facts });

  it("approved + GSTIN + an approved posting: eligible", () => {
    expect(missing({})).toBeNull();
  });

  it("a proven phone stands in for the GSTIN", () => {
    expect(missing({ hasGstNumber: false, phoneProven: true })).toBeNull();
  });

  it("an agency or contractor account qualifies on the same rule", () => {
    expect(missing({ role: "agent" })).toBeNull();
  });

  it.each([
    ["no company row", { role: null }, "no_company"],
    ["a suspended company", { status: "suspended" }, "barred"],
    ["an archived company", { status: "archived" }, "barred"],
    ["a company the admin has not approved", { verificationStatus: "pending" }, "not_approved"],
    ["no company record at all", { verificationStatus: null }, "not_approved"],
    ["neither a GSTIN nor a proven phone", { hasGstNumber: false }, "no_gst_or_proven_phone"],
    ["no approved posting yet (B2-20)", { hasApprovedPosting: false }, "no_approved_posting"],
  ] as const)("%s is not eligible", (_label, facts, why) => {
    expect(missing(facts as Partial<WelcomeEligibilityFacts>)).toBe(why);
  });
});

describe("the grant", () => {
  it("grants 5 credits valid 30 days, with ONE event on the grant's own transaction", async () => {
    const h = harness();
    const before = Date.now();
    expect(await h.service.afterPostingApproved(OWNER, ctx)).toBe("granted");

    expect(h.tenancy.resolveReadOnly).toHaveBeenCalledWith(OWNER);
    expect(h.rollout.stateFor).toHaveBeenCalledWith("credit_rules", TENANT);
    const [tenant, input] = h.repo.grantOnce.mock.calls[0]!;
    expect(tenant).toBe(TENANT);
    expect(input.credits).toBe(5);
    const days = (input.expiresAt.getTime() - before) / 86_400_000;
    expect(days).toBeGreaterThanOrEqual(29.99);
    expect(days).toBeLessThan(30.01);

    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0]).toMatchObject({
      event_name: "payer.welcome_credits_granted",
      subject: { subject_type: "payer", subject_id: TENANT },
      payload: { payer_id: TENANT, lot_id: LOT, credits: 5, trigger: "posting_approved" },
      idempotencyKey: `payer.welcome_credits_granted:${TENANT}`,
      tx: { tx: true },
    });
  });

  it("a second trigger finds the grant already on the ledger: no event", async () => {
    const h = harness({ applied: false });
    expect(await h.service.afterCompanyUpdated(OWNER, ctx)).toBe("already_granted");
    expect(h.emitted).toHaveLength(0);
  });

  it("the settings move the grant with no deploy", async () => {
    const h = harness({ welcomeCredits: 8 });
    await h.service.afterCompanyImported(OWNER, ctx);
    expect(h.repo.grantOnce.mock.calls[0]![1].credits).toBe(8);
    expect(h.emitted[0]).toMatchObject({ payload: { credits: 8, trigger: "company_import" } });
  });

  it.each([
    ["off", "rules_off"],
    ["unavailable", "rules_off"],
  ] as const)("the switch %s: nothing is read or written", async (rules, outcome) => {
    const h = harness({ rules });
    expect(await h.service.afterPostingApproved(OWNER, ctx)).toBe(outcome);
    expect(h.repo.eligibility).not.toHaveBeenCalled();
    expect(h.repo.grantOnce).not.toHaveBeenCalled();
  });

  it("no tenant for the owner: nothing is read or written", async () => {
    const h = harness({ tenant: null });
    expect(await h.service.afterPostingApproved(OWNER, ctx)).toBe("no_tenant");
    expect(h.rollout.stateFor).not.toHaveBeenCalled();
    expect(h.repo.grantOnce).not.toHaveBeenCalled();
  });

  it("welcomeCredits set to 0: nothing is granted", async () => {
    const h = harness({ welcomeCredits: 0 });
    expect(await h.service.afterPostingApproved(OWNER, ctx)).toBe("zero_credits");
    expect(h.repo.grantOnce).not.toHaveBeenCalled();
  });

  it("not eligible: nothing is granted", async () => {
    const h = harness({ facts: { hasApprovedPosting: false } });
    expect(await h.service.afterCompanyUpdated(OWNER, ctx)).toBe("not_eligible");
    expect(h.repo.grantOnce).not.toHaveBeenCalled();
  });

  it("NEVER fails its caller: a database error is logged and answered 'failed'", async () => {
    const h = harness();
    h.repo.grantOnce.mockRejectedValue(Object.assign(new Error("db"), { code: "08006" }));
    await expect(h.service.afterPostingApproved(OWNER, ctx)).resolves.toBe("failed");
  });
});
