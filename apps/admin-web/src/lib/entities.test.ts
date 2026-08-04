import { describe, it, expect } from "vitest";
import {
  applicationListItemSchema,
  creditsViewSchema,
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
