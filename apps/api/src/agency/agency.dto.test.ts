import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  AGENCY_INVITE_BATCH_MAX,
  CreateAgencyInviteBatchSchema,
  CreateAgencyInviteSchema,
  CreateAgencyJobSchema,
  UpdateAgencyJobSchema,
} from "./agency.dto";

/**
 * C10 — numeric upper bounds on the agency-job demand fields (anti-abuse / overflow
 * guards, NOT business rules). The values MUST stay in parity with the payer-web mirror
 * `agencyJobInputSchema` (apps/payer-web/src/lib/contracts.ts): pay ≤ ₹10,000,000/month,
 * experience ≤ 60 years. These tests pin the at-bound (accepted) and over-bound (rejected)
 * edges, and confirm the existing cross-field .refine() ordering rules still hold.
 */
const PAY_MAX_INR = 10_000_000;
const EXPERIENCE_MAX_YEARS = 60;

const base = { trade_key: "cnc_operator", title: "CNC Operator", city: "Pune" } as const;

describe("CreateAgencyJobSchema — C10 numeric upper bounds", () => {
  it("accepts pay/experience exactly AT the bound", () => {
    const r = CreateAgencyJobSchema.safeParse({
      ...base,
      pay_min: 0,
      pay_max: PAY_MAX_INR,
      min_experience_years: 0,
      max_experience_years: EXPERIENCE_MAX_YEARS,
    });
    expect(r.success).toBe(true);
  });

  it("rejects pay_max OVER the ₹ ceiling", () => {
    const r = CreateAgencyJobSchema.safeParse({ ...base, pay_max: PAY_MAX_INR + 1 });
    expect(r.success).toBe(false);
  });

  it("rejects pay_min OVER the ₹ ceiling", () => {
    const r = CreateAgencyJobSchema.safeParse({ ...base, pay_min: PAY_MAX_INR + 1 });
    expect(r.success).toBe(false);
  });

  it("rejects max_experience_years OVER the years ceiling", () => {
    const r = CreateAgencyJobSchema.safeParse({ ...base, max_experience_years: EXPERIENCE_MAX_YEARS + 1 });
    expect(r.success).toBe(false);
  });

  it("rejects min_experience_years OVER the years ceiling", () => {
    const r = CreateAgencyJobSchema.safeParse({ ...base, min_experience_years: EXPERIENCE_MAX_YEARS + 1 });
    expect(r.success).toBe(false);
  });

  it("still enforces the cross-field ordering rules (pay_max >= pay_min, maxExp >= minExp)", () => {
    expect(CreateAgencyJobSchema.safeParse({ ...base, pay_min: 50000, pay_max: 40000 }).success).toBe(false);
    expect(
      CreateAgencyJobSchema.safeParse({ ...base, min_experience_years: 5, max_experience_years: 3 }).success,
    ).toBe(false);
  });
});

/**
 * ADR-0024 final addendum (2026-07-16) — the fail-closed write-path guard on
 * worker-visible free text. EVERY free-text surface (title, description, each
 * benefits/requirements item) is screened with BOTH heuristics: `looksLikePii`
 * (phone/email shapes) AND `looksLikeOrgName` (legal-entity suffixes). A phone
 * number or a "Pvt Ltd"-style employer name is rejected with a clear 400 (the
 * message names the FIELD, never the offending content) and is NEVER stored.
 */
describe("Agency job worker-visible free-text guards (ADR-0024 final addendum)", () => {
  it("rejects a description containing a phone number, naming the field", () => {
    const r = CreateAgencyJobSchema.safeParse({
      ...base,
      description: "Call 9876543210 for details",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0]!.message).toBe("remove contact details from the description");
    }
  });

  it("rejects a description containing a company name (Pvt Ltd)", () => {
    const r = CreateAgencyJobSchema.safeParse({
      ...base,
      description: "Work the night line at Sharma Precision Pvt Ltd",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0]!.message).toBe("description must not contain a company name");
    }
  });

  it("rejects a description containing a link (www./TLD shapes — ADR-0024 'contact links')", () => {
    const r = CreateAgencyJobSchema.safeParse({
      ...base,
      description: "Apply at www.acme.in before Friday",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0]!.message).toBe("description must not contain links");
    }
  });

  it("rejects a benefits item containing a URL", () => {
    const r = CreateAgencyJobSchema.safeParse({
      ...base,
      benefits: ["PF + ESI", "Form at https://acme.example/hr"],
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0]!.message).toBe("benefits must not contain links");
    }
  });

  it("rejects a benefits item containing a company name", () => {
    const r = CreateAgencyJobSchema.safeParse({
      ...base,
      benefits: ["PF + ESI", "Bus from Acme Private Limited"],
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0]!.message).toBe("benefits must not contain a company name");
    }
  });

  it("rejects a requirements item containing contact details", () => {
    const r = CreateAgencyJobSchema.safeParse({
      ...base,
      requirements: ["WhatsApp 98765 43210 to apply"],
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0]!.message).toBe("remove contact details from requirements");
    }
  });

  it("rejects a title containing 'Pvt Ltd'", () => {
    const r = CreateAgencyJobSchema.safeParse({ ...base, title: "Operator at Kalyani Pvt Ltd" });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0]!.message).toBe("title must not contain a company name");
    }
  });

  it("accepts a valid payload with all four new fields (org-safe trade text passes)", () => {
    const r = CreateAgencyJobSchema.safeParse({
      ...base,
      description: "Operate and set VMC machines on the day line.",
      shift: "rotational",
      // "limited experience ok" / "co-worker" are the documented heuristic
      // negatives — legitimate trade text must never 400.
      benefits: ["PF + ESI", "Canteen", "limited experience ok"],
      requirements: ["Fanuc control", "ITI / Diploma", "co-worker friendly"],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.description).toBe("Operate and set VMC machines on the day line.");
      expect(r.data.shift).toBe("rotational");
      expect(r.data.benefits).toEqual(["PF + ESI", "Canteen", "limited experience ok"]);
      expect(r.data.requirements).toEqual(["Fanuc control", "ITI / Diploma", "co-worker friendly"]);
    }
  });

  it("rejects an unknown shift value (enum, not free text)", () => {
    expect(CreateAgencyJobSchema.safeParse({ ...base, shift: "evening" }).success).toBe(false);
  });

  it("caps list size (12 items) and item length (80 chars)", () => {
    expect(
      CreateAgencyJobSchema.safeParse({ ...base, benefits: Array(13).fill("PF") }).success,
    ).toBe(false);
    expect(
      CreateAgencyJobSchema.safeParse({ ...base, requirements: ["x".repeat(81)] }).success,
    ).toBe(false);
  });

  it("UpdateAgencyJobSchema applies the SAME guards to the new fields", () => {
    expect(UpdateAgencyJobSchema.safeParse({ description: "Call 9876543210" }).success).toBe(
      false,
    );
    expect(
      UpdateAgencyJobSchema.safeParse({
        requirements: ["Report to Deccan Auto Components Private Limited"],
      }).success,
    ).toBe(false);
    expect(UpdateAgencyJobSchema.safeParse({ title: "Fitter at Mehta & Co" }).success).toBe(false);
    expect(UpdateAgencyJobSchema.safeParse({ shift: "day" }).success).toBe(true);
    expect(
      UpdateAgencyJobSchema.safeParse({ description: "Day-shift VMC setting role." }).success,
    ).toBe(true);
  });
});

/**
 * ADR-0022 Amendment 3 — the BATCH invite-mint DTO.
 *
 * THIS SCHEMA IS THE ENTIRE SECURITY BOUNDARY between batch minting and the DEAD module-2
 * "bulk worker/candidate upload". The distinction is the DIRECTION and REFERENT of the
 * input, and it is carried by the SHAPE of the body and nothing else:
 *
 *   BULK UPLOAD'S INPUT HAS ARITY OVER PEOPLE; BATCH MINT'S INPUT HAS ARITY OVER NOTHING.
 *
 * A scalar count denotes nobody. The instant the body can carry a per-invite element
 * (labels[], recipients[], notes[], names[], phones[]…), the input regains arity over
 * people, the direction flips to inbound, and the feature becomes bulk upload with a weaker
 * identifier — which would then flow into `events` via the `campaign` field.
 */
describe("CreateAgencyInviteBatchSchema — count is bounded server-side (C2)", () => {
  it("accepts the inclusive bounds 1 and the server max", () => {
    expect(CreateAgencyInviteBatchSchema.safeParse({ count: 1 }).success).toBe(true);
    expect(CreateAgencyInviteBatchSchema.safeParse({ count: AGENCY_INVITE_BATCH_MAX }).success).toBe(true);
    expect(AGENCY_INVITE_BATCH_MAX).toBe(50);
  });

  it("rejects every out-of-band / non-integer / coerced / missing count", () => {
    const bad: unknown[] = [
      { count: 0 },
      { count: AGENCY_INVITE_BATCH_MAX + 1 },
      { count: 1_000_000 },
      { count: -1 },
      { count: 1.5 },
      { count: "50" },
      { count: Number.NaN },
      { count: Number.POSITIVE_INFINITY },
      { count: null },
      { count: true },
      { count: [1] },
      {},
    ];
    for (const body of bad) {
      expect(
        CreateAgencyInviteBatchSchema.safeParse(body),
        `expected ${JSON.stringify(body)} to be rejected`,
      ).toMatchObject({ success: false });
    }
  });
});

describe("CreateAgencyInviteBatchSchema — the body is CARDINALITY-ONLY and .strict() (C3, C8)", () => {
  it("rejects EVERY array-shaped per-invite element (this is bulk upload)", () => {
    const bulkish: unknown[] = [
      { count: 2, labels: ["a", "b"] },
      { count: 2, recipients: [{ name: "x" }] },
      { count: 2, invitees: [{}] },
      { count: 2, notes: ["for ramesh"] },
      { count: 2, names: ["Ramesh"] },
      { count: 2, phones: ["9822000000"] },
      { count: 2, for: ["ramesh"] },
      { count: 2, contacts: ["9822000000"] },
      { count: 2, campaigns: ["a", "b"] },
    ];
    for (const body of bulkish) {
      expect(
        CreateAgencyInviteBatchSchema.safeParse(body),
        `expected ${JSON.stringify(body)} to be a LOUD 400, not a silently stripped key`,
      ).toMatchObject({ success: false });
    }
  });

  it("rejects every DELIVERY field — the platform sends nothing (C8)", () => {
    for (const body of [
      { count: 2, to: "9822000000" },
      { count: 2, phone: "9822000000" },
      { count: 2, msisdn: "+919822000000" },
      { count: 2, email: "a@b.com" },
      { count: 2, channel: "whatsapp" },
    ]) {
      expect(CreateAgencyInviteBatchSchema.safeParse(body)).toMatchObject({ success: false });
    }
  });

  it("rejects a worker/payer identifier in the body (tenancy is session-derived, XB-A)", () => {
    for (const body of [
      { count: 2, worker_id: "99999999-9999-4999-8999-999999999999" },
      { count: 2, workerId: "99999999-9999-4999-8999-999999999999" },
      { count: 2, payer_id: "11111111-1111-4111-8111-111111111111" },
      { count: 2, inviter_payer_id: "11111111-1111-4111-8111-111111111111" },
    ]) {
      expect(CreateAgencyInviteBatchSchema.safeParse(body)).toMatchObject({ success: false });
    }
  });

  it("STRUCTURAL: no property of the schema is array-typed, now or after any future edit", () => {
    const shape = (CreateAgencyInviteBatchSchema as unknown as { shape: Record<string, z.ZodTypeAny> })
      .shape;
    expect(Object.keys(shape).sort()).toEqual(["campaign", "count"]);
    for (const [key, def] of Object.entries(shape)) {
      // Walk through optional/default/effects wrappers to the innermost type.
      let inner: z.ZodTypeAny = def;
      for (let i = 0; i < 10; i += 1) {
        const d = (inner as unknown as { _def: { innerType?: z.ZodTypeAny; schema?: z.ZodTypeAny } })._def;
        const next = d.innerType ?? d.schema;
        if (!next) break;
        inner = next;
      }
      expect(inner, `${key} must not be an array (arity over people)`).not.toBeInstanceOf(z.ZodArray);
    }
  });

  it("is .strict(): any unknown key at all is a rejection, not a silent strip", () => {
    expect(CreateAgencyInviteBatchSchema.safeParse({ count: 2, anythingElse: 1 })).toMatchObject({
      success: false,
    });
  });
});

describe("CreateAgencyInviteSchema — .strict() parity with the batch schema (C3)", () => {
  it("still accepts the faceless singular body", () => {
    expect(CreateAgencyInviteSchema.safeParse({}).success).toBe(true);
    expect(CreateAgencyInviteSchema.safeParse({ campaign: "diwali-drive" }).success).toBe(true);
  });

  it("rejects an unknown key rather than stripping it", () => {
    for (const body of [
      { phone: "9822000000" },
      { worker_id: "99999999-9999-4999-8999-999999999999" },
      { labels: ["a"] },
      { count: 50 },
    ]) {
      expect(CreateAgencyInviteSchema.safeParse(body)).toMatchObject({ success: false });
    }
  });
});

/**
 * C9 — the campaign tag is screened with `looksLikeActionContextPii`, not the looser
 * `looksLikePii` (which catches only email shapes and phone digit runs, so a personal NAME
 * passed). `campaign` reaches `agency_invites.campaign` AND the `agency_invite.created`
 * payload — an invariant-#2 sink — and batch minting multiplies its reach 50× per call.
 */
describe("campaign tag — name/address shapes are rejected on BOTH mint paths (C9)", () => {
  const PII_LIKE = ["Ramesh Kumar", "Sunita Devi", "9822000000", "a@b.com", "Ramesh K. Patil"];
  const LEGIT = ["diwali-drive", "pune-gate-2", "spring_drive", "q3", "gate-drive-2026"];

  for (const schema of [
    ["CreateAgencyInviteSchema", CreateAgencyInviteSchema] as const,
    ["CreateAgencyInviteBatchSchema", CreateAgencyInviteBatchSchema] as const,
  ]) {
    const [name, s] = schema;
    const wrap = (campaign: string) =>
      name === "CreateAgencyInviteBatchSchema" ? { count: 2, campaign } : { campaign };

    it(`${name} rejects PII-shaped campaign tags`, () => {
      for (const v of PII_LIKE) {
        expect(s.safeParse(wrap(v)), `expected "${v}" to be rejected`).toMatchObject({
          success: false,
        });
      }
    });

    it(`${name} accepts legitimate non-PII campaign tags`, () => {
      for (const v of LEGIT) {
        expect(s.safeParse(wrap(v)), `expected "${v}" to be accepted`).toMatchObject({
          success: true,
        });
      }
    });

    it(`${name} caps the campaign tag at 64 chars`, () => {
      expect(s.safeParse(wrap("x".repeat(64))).success).toBe(true);
      expect(s.safeParse(wrap("x".repeat(65))).success).toBe(false);
      expect(s.safeParse(wrap("")).success).toBe(false);
    });
  }
});
