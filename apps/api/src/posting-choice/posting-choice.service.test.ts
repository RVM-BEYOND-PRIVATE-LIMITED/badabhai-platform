import { NotFoundException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CATALOG,
  parseCatalog,
  type Catalog,
  type CreditPackTier,
} from "@badabhai/pricing";
import type { ServerConfig } from "@badabhai/config";
import type { PayerTenantScope, TenantKey } from "../payers/payer-tenant-scope";
import type { ActiveCatalog } from "../pricing/pricing.service";
import {
  POSTING_CHOICE_CHECKOUT_ORIGIN,
  POSTING_CHOICE_PACK_CODE,
  PostingChoiceService,
} from "./posting-choice.service";

/**
 * #2751 items 1 to 3 — the posting choice. What each button offers (server-decided texts), the
 * once-per-posting record and its event, the checkout hint for a paid tap, and the two promises:
 * nothing is read or written while the switch is off, and nothing here can fail the publish.
 */

const TENANT = "11111111-1111-4111-8111-111111111111" as TenantKey;
const ACTOR = "22222222-2222-4222-8222-222222222222";
const POSTING = "33333333-3333-4333-8333-333333333333";
const CTX = { correlationId: "corr-1", requestId: "req-1" } as never;
const SCOPE = { tenantKey: TENANT, actorPayerId: ACTOR } as PayerTenantScope;

const STARTER: CreditPackTier = { code: "pack_starter", priceInr: 999, credits: 20, windowDays: 14 };
const PACK_50: CreditPackTier = { code: "pack_50", priceInr: 2000, credits: 50, windowDays: 14 };

const catalogWith = (tiers: CreditPackTier[]): ActiveCatalog => ({
  catalog: parseCatalog({
    ...DEFAULT_CATALOG,
    products: DEFAULT_CATALOG.products.map((p) =>
      p.kind === "credit_pack" ? { ...p, tiers } : p,
    ),
  }) as Catalog,
  source: "db",
  revision: 3,
});

const REAL_PAYMENTS = {
  PAYMENTS_ENABLE_REAL: true,
  PAYMENTS_PROVIDER_KEY: "rzp_test_key",
  PAYMENTS_PROVIDER_SECRET: "secret",
  RAZORPAY_WEBHOOK_SECRET: "webhook",
};

interface Opts {
  switches?: Partial<Record<"posting_choice" | "credit_rules", boolean>>;
  realPayments?: boolean;
  catalog?: ActiveCatalog | Error;
  welcomeCredits?: number;
  hasWelcomeLot?: boolean | Error;
  recordOnce?: (input: unknown, after: (tx: unknown) => Promise<void>) => Promise<boolean>;
}

function make(opts: Opts = {}) {
  const switches = { posting_choice: true, credit_rules: true, ...opts.switches };
  const isEnabledFor = vi.fn(async (feature: string) => switches[feature as keyof typeof switches] ?? false);
  const TX = { tx: "posting-choice" };
  const recordOnce = vi.fn(
    opts.recordOnce ??
      (async (_input: unknown, after: (tx: unknown) => Promise<void>) => {
        await after(TX);
        return true;
      }),
  );
  const hasWelcomeLot = vi.fn(async () => {
    if (opts.hasWelcomeLot instanceof Error) throw opts.hasWelcomeLot;
    return opts.hasWelcomeLot ?? false;
  });
  const rulesGet = vi.fn(async () => ({ welcomeCredits: opts.welcomeCredits ?? 5 }));
  const getActiveCatalog = vi.fn(async () => {
    const c = opts.catalog ?? catalogWith([STARTER, PACK_50]);
    if (c instanceof Error) throw c;
    return c;
  });
  const emit = vi.fn().mockResolvedValue(undefined);
  const config = (opts.realPayments === false ? {} : REAL_PAYMENTS) as unknown as ServerConfig;
  const svc = new PostingChoiceService(
    config,
    { recordOnce, hasWelcomeLot } as never,
    { isEnabledFor } as never,
    { get: rulesGet } as never,
    { getActiveCatalog } as never,
    { emit } as never,
  );
  return { svc, isEnabledFor, recordOnce, hasWelcomeLot, rulesGet, getActiveCatalog, emit, TX };
}

describe("GET posting-options — the switch", () => {
  it("off for the company: the neutral 404, and nothing else is read", async () => {
    const d = make({ switches: { posting_choice: false } });
    await expect(d.svc.optionsFor(SCOPE)).rejects.toBeInstanceOf(NotFoundException);
    expect(d.isEnabledFor).toHaveBeenCalledWith("posting_choice", TENANT);
    expect(d.hasWelcomeLot).not.toHaveBeenCalled();
    expect(d.getActiveCatalog).not.toHaveBeenCalled();
  });
});

describe("GET posting-options — the free button (count until granted)", () => {
  it("before the welcome grant: 'Post free (5 contacts)'", async () => {
    const { free } = await make().svc.optionsFor(SCOPE);
    expect(free).toEqual({
      choice: "free",
      offered: true,
      label: "Post free (5 contacts)",
      welcome_credits: 5,
    });
  });

  it("the count follows the credit rules", async () => {
    const { free } = await make({ welcomeCredits: 8 }).svc.optionsFor(SCOPE);
    expect(free.label).toBe("Post free (8 contacts)");
  });

  it("once the company was given its welcome credits: 'Post free', no count", async () => {
    const { free } = await make({ hasWelcomeLot: true }).svc.optionsFor(SCOPE);
    expect(free).toMatchObject({ label: "Post free", welcome_credits: null });
  });

  it("credit rules off for the company (no welcome grant will come): 'Post free'", async () => {
    const d = make({ switches: { credit_rules: false } });
    const { free } = await d.svc.optionsFor(SCOPE);
    expect(free).toMatchObject({ label: "Post free", welcome_credits: null });
    expect(d.hasWelcomeLot).not.toHaveBeenCalled();
  });

  it("zero welcome credits in the rules: 'Post free'", async () => {
    const { free } = await make({ welcomeCredits: 0 }).svc.optionsFor(SCOPE);
    expect(free.label).toBe("Post free");
  });

  it("a read failure promises nothing: 'Post free'", async () => {
    const { free } = await make({ hasWelcomeLot: new Error("db down") }).svc.optionsFor(SCOPE);
    expect(free).toMatchObject({ label: "Post free", welcome_credits: null });
  });
});

describe("GET posting-options — the paid button (pack_starter only)", () => {
  it("Starter on sale and real payments live: offered, priced from the live catalogue", async () => {
    const { free_plus_pack } = await make().svc.optionsFor(SCOPE);
    expect(free_plus_pack).toEqual({
      choice: "free_plus_pack",
      offered: true,
      label: "Post free + Starter ₹999 (20 contacts)",
      pack: { code: "pack_starter", price_inr: 999, total_paise: 117_900, credits: 20 },
      checkout_origin: "posting_flow",
    });
  });

  it("a catalogue price edit changes the label (the server decides the text)", async () => {
    const { free_plus_pack } = await make({
      catalog: catalogWith([{ ...STARTER, priceInr: 1299, credits: 25 }]),
    }).svc.optionsFor(SCOPE);
    expect(free_plus_pack.label).toBe("Post free + Starter ₹1,299 (25 contacts)");
  });

  it("Starter not in the catalogue (production before go-live): not offered, no other pack stands in", async () => {
    const { free_plus_pack } = await make({ catalog: catalogWith([PACK_50]) }).svc.optionsFor(SCOPE);
    expect(free_plus_pack).toMatchObject({ offered: false, label: null, pack: null });
  });

  it("Starter off sale: not offered", async () => {
    const { free_plus_pack } = await make({
      catalog: catalogWith([{ ...STARTER, offered: false } as CreditPackTier]),
    }).svc.optionsFor(SCOPE);
    expect(free_plus_pack.offered).toBe(false);
  });

  it("real payments off (the purchase routes are a free mock): not offered, catalogue unread", async () => {
    const d = make({ realPayments: false });
    const { free_plus_pack } = await d.svc.optionsFor(SCOPE);
    expect(free_plus_pack.offered).toBe(false);
    expect(d.getActiveCatalog).not.toHaveBeenCalled();
  });

  it("a catalogue read failure: not offered, the route still answers", async () => {
    const { free, free_plus_pack } = await make({ catalog: new Error("down") }).svc.optionsFor(
      SCOPE,
    );
    expect(free_plus_pack.offered).toBe(false);
    expect(free.offered).toBe(true);
  });

  it("pins the pack and the checkout origin", () => {
    expect(POSTING_CHOICE_PACK_CODE).toBe("pack_starter");
    expect(POSTING_CHOICE_CHECKOUT_ORIGIN).toBe("posting_flow");
  });
});

describe("recordAfterPublish — the record", () => {
  const INPUT = { scope: SCOPE, jobPostingId: POSTING, choice: "free" as const, surface: "web" as const };

  it("switch off: null, and the table is never named", async () => {
    const d = make({ switches: { posting_choice: false } });
    await expect(d.svc.recordAfterPublish(INPUT, CTX)).resolves.toBeNull();
    expect(d.recordOnce).not.toHaveBeenCalled();
    expect(d.emit).not.toHaveBeenCalled();
  });

  it("records once under the TENANT key and emits the event in the record's transaction", async () => {
    const d = make();
    const out = await d.svc.recordAfterPublish({ ...INPUT, surface: "app" }, CTX);
    expect(out).toEqual({ choice: "free", surface: "app", recorded: true, checkout: null });
    expect(d.recordOnce).toHaveBeenCalledWith(
      { jobPostingId: POSTING, tenant: TENANT, choice: "free", surface: "app" },
      expect.any(Function),
    );
    expect(d.emit).toHaveBeenCalledTimes(1);
    expect(d.emit).toHaveBeenCalledWith({
      event_name: "job_posting.posting_choice_recorded",
      actor: { actor_type: "payer", actor_id: ACTOR },
      subject: { subject_type: "job_posting", subject_id: POSTING },
      payload: { job_posting_id: POSTING, choice: "free", surface: "app" },
      correlationId: "corr-1",
      requestId: "req-1",
      idempotencyKey: `job_posting.posting_choice_recorded:${POSTING}`,
      tx: d.TX,
    });
  });

  it("a posting that already has a choice: recorded false, no second event", async () => {
    const d = make({ recordOnce: async () => false });
    const out = await d.svc.recordAfterPublish(INPUT, CTX);
    expect(out).toMatchObject({ recorded: false });
    expect(d.emit).not.toHaveBeenCalled();
  });

  it("NEVER THROWS: a missing table (42P01) answers recorded false", async () => {
    const d = make({
      recordOnce: async () => {
        throw Object.assign(new Error("relation does not exist"), { code: "42P01" });
      },
    });
    await expect(d.svc.recordAfterPublish(INPUT, CTX)).resolves.toMatchObject({ recorded: false });
  });

  it("NEVER THROWS: a failed emit rolls the record back with it and answers recorded false", async () => {
    const d = make();
    d.emit.mockRejectedValue(new Error("spine down"));
    await expect(d.svc.recordAfterPublish(INPUT, CTX)).resolves.toMatchObject({ recorded: false });
  });
});

describe("recordAfterPublish — the paid tap's checkout (item 3)", () => {
  const PAID = {
    scope: SCOPE,
    jobPostingId: POSTING,
    choice: "free_plus_pack" as const,
    surface: "web" as const,
  };

  it("carries the job as the purchase origin, with the pack and its confirmed list price", async () => {
    const out = await make().svc.recordAfterPublish(PAID, CTX);
    expect(out?.checkout).toEqual({
      pack_code: "pack_starter",
      expected_price_inr: 999,
      origin: "posting_flow",
      origin_job_posting_id: POSTING,
    });
  });

  it("the paid button not offered: the choice is still recorded, with no checkout", async () => {
    const d = make({ catalog: catalogWith([PACK_50]) });
    const out = await d.svc.recordAfterPublish(PAID, CTX);
    expect(out).toMatchObject({ choice: "free_plus_pack", recorded: true, checkout: null });
  });

  it("the checkout is handed out even when the record failed (the job is live either way)", async () => {
    const d = make({
      recordOnce: async () => {
        throw new Error("down");
      },
    });
    const out = await d.svc.recordAfterPublish(PAID, CTX);
    expect(out?.recorded).toBe(false);
    expect(out?.checkout?.origin_job_posting_id).toBe(POSTING);
  });

  it("a free tap gets no checkout and reads no catalogue", async () => {
    const d = make();
    const out = await d.svc.recordAfterPublish({ ...PAID, choice: "free" }, CTX);
    expect(out?.checkout).toBeNull();
    expect(d.getActiveCatalog).not.toHaveBeenCalled();
  });
});
