import { describe, it, expect } from "vitest";
import {
  applicationListItemSchema,
  adminDirectorySchema,
  adminRowSchema,
  capabilityMatrixSchema,
  creditsViewSchema,
  killSwitchSchema,
  financeSummarySchema,
  ledgerPageSchema,
  ordersPageSchema,
  jobPostingDetailSchema,
  jobPostingListItemSchema,
  payerListItemSchema,
  qs,
  workerDetailSchema,
  workerListItemSchema,
  workersPageSchema,
} from "./entities";

/**
 * The entity data layer.
 *
 * Two things are actually load-bearing here and both are easy to regress invisibly:
 *   1. `qs` must OMIT an empty filter rather than send it. The server's query schemas are
 *      `.strict()` Zod enums, so `?status=` is a 400 — an untouched dropdown would break
 *      the whole page.
 *   2. The schemas must reject a response that carries PII-shaped fields, so a server
 *      regression surfaces as an error state instead of rendering a phone number.
 */

describe("qs — an unset filter must not reach the server", () => {
  it("omits undefined, null and EMPTY STRING", () => {
    // The empty string is the one that matters: an untouched <select> submits "".
    expect(qs({ status: "", role: undefined, cursor: null })).toBe("");
  });

  it("keeps real values", () => {
    expect(qs({ status: "active" })).toBe("?status=active");
  });

  it("keeps `false` and `0` — they are values, not absences", () => {
    // Guards against a truthiness check replacing the explicit comparisons.
    expect(qs({ pendingDeletion: false })).toBe("?pendingDeletion=false");
    expect(qs({ limit: 0 })).toBe("?limit=0");
  });

  it("url-encodes values rather than splicing them raw", () => {
    expect(qs({ status: "a b&c=d" })).toBe("?status=a+b%26c%3Dd");
  });

  it("mixes set and unset filters correctly", () => {
    expect(qs({ status: "open", verificationStatus: "", payerId: "p1" })).toBe(
      "?status=open&payerId=p1",
    );
  });
});

// ---------------------------------------------------------------------------
// Real captured payloads, parsed THROUGH the schemas (not asserted around them).
// ---------------------------------------------------------------------------

const WORKER_ROW = {
  id: "5eeded00-0001-4a00-8000-000000000001",
  status: "active",
  preferred_language: "hi",
  has_photo: false,
  resume_show_photo: true,
  resume_night_shift_ready: false,
  deletion_scheduled_at: null,
  created_at: "2026-08-04T11:29:59.036Z",
  updated_at: "2026-08-04T11:29:59.036Z",
};

const PAYER_ROW = {
  id: "6155050c-c91b-4c6e-96a7-8da023f1d2d2",
  role: "employer",
  status: "pending",
  previous_status: null,
  created_at: "2026-08-04T11:30:00.000Z",
  updated_at: "2026-08-04T11:30:00.000Z",
};

const POSTING_ROW = {
  id: "bc765f2b-902f-4cba-81c2-6abab75e4bf5",
  payer_id: "f61d52ae-b709-4e44-a5a2-bfe8ce77e88b",
  org_label: "BP1 Test Employer",
  role_title: "CNC Operator",
  location_label: "Pune",
  city: null,
  status: "draft",
  verification_status: "unverified",
  vacancy_band: "2-5",
  pay_min: null,
  pay_max: null,
  published_at: null,
  closed_at: null,
  created_at: "2026-08-04T11:32:00.537Z",
};

describe("schemas parse the real server shapes", () => {
  it("worker row", () => {
    expect(workerListItemSchema.parse(WORKER_ROW).has_photo).toBe(false);
  });

  it("worker page envelope", () => {
    const page = workersPageSchema.parse({ items: [WORKER_ROW], nextCursor: null });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeNull();
  });

  it("worker detail", () => {
    const d = workerDetailSchema.parse({
      ...WORKER_ROW,
      profile_status: "confirmed",
      profile_updated_at: "2026-08-04T11:30:00.000Z",
      has_resume: true,
      application_count: 3,
      unlock_count: 1,
    });
    expect(d.application_count).toBe(3);
  });

  it("payer row", () => {
    expect(payerListItemSchema.parse(PAYER_ROW).role).toBe("employer");
  });

  it("job posting row and detail", () => {
    expect(jobPostingListItemSchema.parse(POSTING_ROW).org_label).toBe("BP1 Test Employer");
    const d = jobPostingDetailSchema.parse({
      ...POSTING_ROW,
      description: "Night shift CNC operator role.",
      shift: null,
      needed_by: null,
      boosted_until: null,
      previous_status: null,
      applied_count: 0,
      skipped_count: 0,
      updated_at: "2026-08-04T11:32:00.537Z",
    });
    expect(d.applied_count).toBe(0);
  });

  it("application row", () => {
    const a = applicationListItemSchema.parse({
      id: "a1",
      worker_id: "w1",
      job_id: null,
      job_posting_id: "j1",
      action: "applied",
      reason: null,
      source_surface: "feed",
      match_tier: 1,
      engine_version: "v1.0",
      created_at: "2026-08-04T11:32:00.537Z",
    });
    expect(a.action).toBe("applied");
  });

  it("credits view carries balance and a paged ledger", () => {
    const c = creditsViewSchema.parse({
      payer_id: "p1",
      balance: 25,
      ledger: {
        items: [
          {
            id: "l1",
            delta: 25,
            reason: "grant",
            unlock_id: null,
            pack_code: null,
            price_inr: null,
            created_at: "2026-08-04T11:32:00.537Z",
          },
        ],
        nextCursor: null,
      },
    });
    expect(c.balance).toBe(25);
    expect(c.ledger.items[0]!.reason).toBe("grant");
  });
});

describe("schemas reject shapes that should never arrive", () => {
  it("a worker row missing has_photo fails rather than rendering undefined", () => {
    const { has_photo: _omit, ...rest } = WORKER_ROW;
    expect(workerListItemSchema.safeParse(rest).success).toBe(false);
  });

  it("has_photo must be a BOOLEAN — a raw storage key is not acceptable", () => {
    // If the server ever regressed to sending the object key instead of the derived
    // boolean, this parse fails and the page shows an error rather than the key.
    expect(
      workerListItemSchema.safeParse({ ...WORKER_ROW, has_photo: "photos/w/abc.jpg" }).success,
    ).toBe(false);
  });

  it("an unknown payer role is rejected, not rendered", () => {
    expect(payerListItemSchema.safeParse({ ...PAYER_ROW, role: "superuser" }).success).toBe(
      false,
    );
  });

  it("an unknown payer status is rejected", () => {
    expect(payerListItemSchema.safeParse({ ...PAYER_ROW, status: "deleted" }).success).toBe(
      false,
    );
  });

  it("an unknown application action is rejected", () => {
    expect(
      applicationListItemSchema.safeParse({
        id: "a1",
        worker_id: "w1",
        job_id: null,
        job_posting_id: "j1",
        action: "hired",
        reason: null,
        source_surface: "feed",
        match_tier: null,
        engine_version: null,
        created_at: "2026-08-04T11:32:00.537Z",
      }).success,
    ).toBe(false);
  });

  it("a page envelope without nextCursor fails — an absent cursor is not the same as null", () => {
    expect(workersPageSchema.safeParse({ items: [] }).success).toBe(false);
    expect(workersPageSchema.safeParse({ items: [], nextCursor: null }).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// finance — the posture is REQUIRED, so money can never render unlabelled
// ---------------------------------------------------------------------------

const LEDGER_ROW = {
  id: "l1",
  payer_id: "p1",
  delta: -1,
  reason: "unlock_debit",
  unlock_id: "u1",
  pack_code: null,
  price_inr: null,
  created_at: "2026-08-04T12:00:00.000Z",
};

const ORDER_ROW = {
  id: "o1",
  payer_id: "p1",
  pack_code: "pack_10",
  amount_inr: 1000,
  credits_granted: 10,
  provider: "razorpay",
  status: "paid",
  created_at: "2026-08-04T12:00:00.000Z",
  updated_at: "2026-08-04T12:00:00.000Z",
};

const MOCK_POSTURE = { mode: "mock", blocked_reason: "PAYMENTS_ENABLE_REAL is false" };

describe("finance schemas — money never arrives without its provenance", () => {
  it("a ledger page parses with the posture attached", () => {
    const p = ledgerPageSchema.parse({
      items: [LEDGER_ROW],
      nextCursor: null,
      payments: MOCK_POSTURE,
    });
    expect(p.payments.mode).toBe("mock");
  });

  it("a ledger page WITHOUT `payments` FAILS to parse", () => {
    // The load-bearing assertion of Milestone 4. If the server ever stopped sending the
    // posture, the page must show an error — not a table of rupees with no indication
    // that none of them were ever charged.
    expect(ledgerPageSchema.safeParse({ items: [LEDGER_ROW], nextCursor: null }).success).toBe(
      false,
    );
  });

  it("an orders page WITHOUT `payments` FAILS to parse", () => {
    expect(ordersPageSchema.safeParse({ items: [ORDER_ROW], nextCursor: null }).success).toBe(
      false,
    );
  });

  it("a summary WITHOUT `payments` FAILS to parse", () => {
    const { payments: _drop, ...rest } = {
      payments: MOCK_POSTURE,
      window_days: 30,
      outstanding_credits: 0,
      payers_with_balance: 0,
      by_reason: [],
      paid_orders: { count: 0, credits: 0, amount_inr: 0 },
      unsettled_orders: { count: 0, amount_inr: 0 },
      failed_orders: { count: 0 },
      top_balances: [],
    };
    expect(financeSummarySchema.safeParse(rest).success).toBe(false);
  });

  it("an unknown posture mode is rejected — it must be exactly real or mock", () => {
    // A third value would fall through the UI's `mode === "real"` check and render the
    // MOCK banner, or worse, neither. Reject it at the boundary.
    expect(
      ledgerPageSchema.safeParse({
        items: [],
        nextCursor: null,
        payments: { mode: "sandbox", blocked_reason: null },
      }).success,
    ).toBe(false);
  });

  it("a full summary parses, and unsettled orders stay separate from paid", () => {
    const s = financeSummarySchema.parse({
      payments: MOCK_POSTURE,
      window_days: 30,
      outstanding_credits: 125,
      payers_with_balance: 3,
      by_reason: [
        { reason: "grant", movements: 2, credits_delta: 50, amount_inr: 0 },
        { reason: "unlock_debit", movements: 5, credits_delta: -5, amount_inr: 0 },
      ],
      paid_orders: { count: 1, credits: 10, amount_inr: 1000 },
      unsettled_orders: { count: 4, amount_inr: 4000 },
      failed_orders: { count: 0 },
      top_balances: [{ payer_id: "p1", balance: 100 }],
    });
    expect(s.paid_orders.amount_inr).toBe(1000);
    expect(s.unsettled_orders.amount_inr).toBe(4000);
  });

  it("an unknown credit reason is rejected rather than rendered as a blank row", () => {
    expect(
      ledgerPageSchema.safeParse({
        items: [{ ...LEDGER_ROW, reason: "chargeback" }],
        nextCursor: null,
        payments: MOCK_POSTURE,
      }).success,
    ).toBe(false);
  });

  it("an unknown order status is rejected", () => {
    expect(
      ordersPageSchema.safeParse({
        items: [{ ...ORDER_ROW, status: "refunded" }],
        nextCursor: null,
        payments: MOCK_POSTURE,
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// administration (BP-3)
// ---------------------------------------------------------------------------

const ADMIN_ROW = {
  id: "aaaaaaaa-0000-4000-8000-000000000001",
  role: "super_admin",
  status: "active",
  mfa_enrolled: true,
  last_login_at: "2026-08-04T12:00:00.000Z",
  created_at: "2026-08-01T00:00:00.000Z",
  updated_at: "2026-08-04T12:00:00.000Z",
  is_self: true,
};

describe("admin directory schema", () => {
  it("parses an admin row", () => {
    expect(adminRowSchema.parse(ADMIN_ROW).role).toBe("super_admin");
  });

  it("a row is valid WITHOUT a name — an undisclosed read must still parse", () => {
    // The 2026-08-18 ruling made `name` OPTIONAL, not required: an analyst, a capped read and a
    // >50-account directory all come back without it, and a schema that demanded one would turn
    // every such response into an error state instead of a faceless screen.
    //
    // The EMAIL half of that ruling did not reverse, and this is where that is pinned: no email
    // key exists on this shape at all. The three name STATES live in `entities.identity.test.ts`.
    const parsed = adminRowSchema.parse(ADMIN_ROW);
    expect(parsed).not.toHaveProperty("email");
    expect(parsed).not.toHaveProperty("name");
  });

  it("an unknown role or status is rejected rather than rendered", () => {
    expect(adminRowSchema.safeParse({ ...ADMIN_ROW, role: "root" }).success).toBe(false);
    expect(adminRowSchema.safeParse({ ...ADMIN_ROW, status: "deleted" }).success).toBe(false);
  });

  it("mfa_enrolled must be a boolean — a truthy string would render as enrolled", () => {
    expect(adminRowSchema.safeParse({ ...ADMIN_ROW, mfa_enrolled: "no" }).success).toBe(false);
  });

  it("the directory envelope carries the active super-admin count", () => {
    const d = adminDirectorySchema.parse({ admins: [ADMIN_ROW], active_super_admins: 1 });
    expect(d.active_super_admins).toBe(1);
  });

  it("the envelope REQUIRES the count — a missing one must not read as zero", () => {
    // Zero would trip the "only one super admin" warning logic in the wrong direction.
    expect(adminDirectorySchema.safeParse({ admins: [ADMIN_ROW] }).success).toBe(false);
  });
});

describe("capability matrix schema — served, never copied", () => {
  it("parses the server's matrix", () => {
    const m = capabilityMatrixSchema.parse({
      roles: ["super_admin", "ops_admin", "support", "analyst"],
      matrix: [
        { capability: "read_events", roles: ["super_admin", "ops_admin", "support", "analyst"] },
        { capability: "manage_admins", roles: ["super_admin"] },
      ],
    });
    expect(m.matrix[1]!.roles).toEqual(["super_admin"]);
  });

  it("capability is a free STRING on purpose — a new server capability must still render", () => {
    // If the API adds a capability this portal has not been taught about, the page shows it
    // raw rather than failing to parse and hiding the whole authorization model.
    expect(
      capabilityMatrixSchema.safeParse({
        roles: ["super_admin"],
        matrix: [{ capability: "brand_new_capability", roles: ["super_admin"] }],
      }).success,
    ).toBe(true);
  });

  it("an unknown ROLE is still rejected — roles are a closed set", () => {
    expect(
      capabilityMatrixSchema.safeParse({
        roles: ["super_admin"],
        matrix: [{ capability: "x", roles: ["root"] }],
      }).success,
    ).toBe(false);
  });
});

describe("kill-switch schema", () => {
  const SWITCH = {
    key: "real_payments",
    label: "Real payments",
    category: "payments",
    real_spend: true,
    state: "blocked",
    detail: "PAYMENTS_ENABLE_REAL is false",
    pause_via: "set PAYMENTS_ENABLE_REAL=false (env/deploy)",
  };

  it("parses the switch snapshot", () => {
    const s = killSwitchSchema.parse({ switches: [SWITCH], note: "display only" });
    expect(s.switches[0]!.state).toBe("blocked");
  });

  it("an unknown state is rejected — the tone mapping is exhaustive over the four", () => {
    expect(
      killSwitchSchema.safeParse({ switches: [{ ...SWITCH, state: "degraded" }], note: "" })
        .success,
    ).toBe(false);
  });

  it("real_spend must be a boolean — it drives whether LIVE reads as amber", () => {
    expect(
      killSwitchSchema.safeParse({ switches: [{ ...SWITCH, real_spend: "yes" }], note: "" })
        .success,
    ).toBe(false);
  });
});
