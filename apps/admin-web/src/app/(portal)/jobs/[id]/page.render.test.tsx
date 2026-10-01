import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type * as EntitiesModule from "../../../../lib/entities";

/**
 * What the job-posting DETAIL page renders after PR-A widened the admin projection with the
 * rest of the card content (`role_kind`, `area`, min/max experience, `pay_type`, `requirements`,
 * `benefits`). The projection is mocked, so these assertions are about the PAGE: that every new
 * field surfaces, that a role kind is LABELLED (never rendered raw as if it were prose), that an
 * unknown kind degrades to a legible raw id rather than a blank or a crash, and that a poster who
 * set none of them reads as an honest absence rather than an empty grid.
 *
 * `role_kind` is DISPLAY-ONLY and NOT worker-visible, so the panel copy must no longer claim the
 * content is "exactly what workers see" — the last describe pins that.
 */

const stub = vi.hoisted(() => {
  class RequestError extends Error {
    constructor(readonly status: number) {
      super(`the admin API returned ${status}`);
    }
  }
  return {
    RequestError,
    job: null as Record<string, unknown> | null,
  };
});

vi.mock("../../../../lib/auth", () => ({
  requireCapability: async () => ({
    adminId: "a-1",
    role: "ops_admin",
    capabilities: ["read_entities"],
  }),
}));

vi.mock("../../../../lib/auth/capabilities", () => ({
  can: () => false,
}));

vi.mock("../../../../lib/admin-http", () => ({
  isAdminRequestError: (err: unknown) => err instanceof stub.RequestError,
}));

vi.mock("../../../../lib/entities", () => ({
  getJobPosting: async () => stub.job,
  listApplications: async () => ({ items: [], nextCursor: null }),
}));

// The header is a Client Component using `useRouter`, which needs an app-router context this
// renderer does not provide. Stubbed to render the server-built `title` it is handed.
vi.mock("./job-detail-header", () => ({
  JobDetailHeader: ({ title }: { title: unknown }) => title,
}));

const { default: JobDetailPage } = await import("./page");

const JOB_ID = "70b12000-0001-4a00-8000-000000000001";

/** A full, wire-shaped projection — dates as ISO strings, every field present. */
const BASE = {
  id: JOB_ID,
  payer_id: "8a110000-0001-4a00-8000-000000000001",
  org_label: "A Pune workshop",
  role_title: "Machine operator wanted",
  location_label: "Pune",
  city: "Pune",
  status: "open",
  verification_status: "verified",
  vacancy_band: "1-5",
  pay_min: 18000,
  pay_max: 25000,
  published_at: "2026-09-20T09:00:00.000Z",
  closed_at: null,
  created_at: "2026-09-19T09:00:00.000Z",
  description: "Operate a CNC lathe on the day shift.",
  shift: "day",
  needed_by: "immediate",
  role_kind: "cnc_turner",
  area: "Pimpri-Chinchwad",
  min_experience_years: 2,
  max_experience_years: 5,
  pay_type: "in_hand",
  requirements: ["ITI Fitter", "2 years CNC"],
  benefits: ["PF + ESI", "Canteen"],
  boosted_until: null,
  previous_status: null,
  applied_count: 4,
  skipped_count: 1,
  updated_at: "2026-09-21T09:00:00.000Z",
} as const;

beforeEach(() => {
  stub.job = { ...BASE };
});

const render = async () =>
  renderToStaticMarkup(await JobDetailPage({ params: Promise.resolve({ id: JOB_ID }) }));

describe("the full projection renders every new card field", () => {
  it("labels the role kind rather than echoing the stored key", async () => {
    const out = await render();
    // `cnc_turner` → "CNC Turner" via jobRoleLabel; the raw key must not appear at all.
    expect(out).toContain("CNC Turner");
    expect(out).not.toContain("cnc_turner");
  });

  it("renders each of the seven fields' rows", async () => {
    const out = await render();
    // `>Role<` exact so it is not the pre-existing "Role title" row matching loosely.
    expect(out).toContain('<dt class="kv__k">Role</dt>');
    expect(out).toContain('<dt class="kv__k">Area</dt>');
    expect(out).toContain('<dt class="kv__k">Pay type</dt>');
    expect(out).toContain('<dt class="kv__k">Experience</dt>');
    expect(out).toContain('<dt class="kv__k">Requirements</dt>');
    expect(out).toContain('<dt class="kv__k">Benefits</dt>');
  });

  it("renders the scalar values", async () => {
    const out = await render();
    expect(out).toContain("Pimpri-Chinchwad");
    expect(out).toContain("In-hand");
    expect(out).toContain("2–5 years");
  });

  it("renders requirements and benefits as chips", async () => {
    const out = await render();
    expect(out).toContain('<ul class="chips">');
    expect(out).toContain('<li class="chip">ITI Fitter</li>');
    expect(out).toContain('<li class="chip">2 years CNC</li>');
    expect(out).toContain('<li class="chip">PF + ESI</li>');
    expect(out).toContain('<li class="chip">Canteen</li>');
  });
});

describe("an unknown role kind", () => {
  it("falls back to the raw id in the monospace face — legible, never a blank or a crash", async () => {
    stub.job = { ...BASE, role_kind: "blacksmith" };
    const out = await render();
    expect(out).toContain('<span class="mono">blacksmith</span>');
  });

  it("does not invent a friendly label for a kind it does not know", async () => {
    stub.job = { ...BASE, role_kind: "blacksmith" };
    const out = await render();
    expect(out).not.toContain("Blacksmith");
  });
});

describe("a poster who set none of the card content", () => {
  beforeEach(() => {
    stub.job = {
      ...BASE,
      role_kind: null,
      area: null,
      pay_type: null,
      min_experience_years: null,
      max_experience_years: null,
      requirements: null,
      benefits: null,
    };
  });

  it("reads as honest absence, not empty cells, and never crashes", async () => {
    const out = await render();
    // Role has no dash convention behind it — a missing role is "not set", not "—".
    expect(out).toContain('<dt class="kv__k">Role</dt><dd class="kv__v">not set</dd>');
    // The list fields say so in words rather than rendering an empty <ul>.
    expect(out).toContain('<dt class="kv__k">Requirements</dt><dd class="kv__v">none listed</dd>');
    expect(out).toContain('<dt class="kv__k">Benefits</dt><dd class="kv__v">none listed</dd>');
    expect(out).not.toContain('<ul class="chips">');
    // "not stated" is the page's own phrase for a missing scalar (Area / Pay type / Experience).
    expect(out).toContain('<dt class="kv__k">Experience</dt><dd class="kv__v">not stated</dd>');
  });

  it("treats an EMPTY array exactly like a missing one — not an empty chip list", async () => {
    stub.job = { ...BASE, requirements: [], benefits: [] };
    const out = await render();
    expect(out).toContain('<dt class="kv__k">Requirements</dt><dd class="kv__v">none listed</dd>');
    expect(out).toContain('<dt class="kv__k">Benefits</dt><dd class="kv__v">none listed</dd>');
    expect(out).not.toContain('<ul class="chips">');
  });
});

describe("the apply-rate tile", () => {
  /** The whole `.stat` tile whose label is `label`, or null. */
  const tile = (out: string, label: string) => {
    const end = out.indexOf(`<span class="stat__label">${label}</span></div>`);
    if (end < 0) return null;
    return out.slice(out.lastIndexOf('<div class="stat', end), end);
  };

  it("keeps its label and states the absence in the VALUE before anyone has seen the posting", async () => {
    stub.job = { ...BASE, applied_count: 0, skipped_count: 0 };
    const out = await render();
    // The Stat component's absent value: a statement in the sans face, not a KPI figure.
    expect(tile(out, "Apply rate")).toBe(
      '<div class="stat"><span class="stat__value stat__value--absent">Not seen yet</span>',
    );
    // The label no longer swaps: there is no tile NAMED "Not seen yet", and no dash figure.
    expect(out).not.toContain('<span class="stat__label">Not seen yet</span>');
    expect(out).not.toContain('<span class="stat__value">—</span>');
  });

  it("shows the measured rate as an ordinary figure under the same label", async () => {
    // BASE: 4 applied, 1 skipped → 80%.
    const out = await render();
    expect(tile(out, "Apply rate")).toBe('<div class="stat"><span class="stat__value">80%</span>');
    expect(out).not.toContain("Not seen yet");
  });

  it("does not call a posting unseen once any decision exists, even with zero applies", async () => {
    stub.job = { ...BASE, applied_count: 0, skipped_count: 3 };
    const out = await render();
    expect(tile(out, "Apply rate")).toBe('<div class="stat"><span class="stat__value">0%</span>');
  });
});

describe("the copy no longer over-claims worker visibility", () => {
  it("drops the false 'workers see' claim and names the role classification as internal", async () => {
    const out = await render();
    expect(out).not.toContain("Exactly what the poster wrote and workers see");
    expect(out).not.toContain("exactly as workers see it");
    expect(out).toContain("The role classification is internal and is not shown to workers");
  });
});

describe("the detail schema is the real contract behind the render", () => {
  it("accepts the full projection and keeps the seven fields", async () => {
    const actual =
      await vi.importActual<typeof EntitiesModule>("../../../../lib/entities");
    const parsed = actual.jobPostingDetailSchema.parse({ ...BASE });
    expect(parsed.role_kind).toBe("cnc_turner");
    expect(parsed.area).toBe("Pimpri-Chinchwad");
    expect(parsed.min_experience_years).toBe(2);
    expect(parsed.max_experience_years).toBe(5);
    expect(parsed.pay_type).toBe("in_hand");
    expect(parsed.requirements).toEqual(["ITI Fitter", "2 years CNC"]);
    expect(parsed.benefits).toEqual(["PF + ESI", "Canteen"]);
  });

  it("keeps role_kind a plain string so an unknown kind survives the parse", async () => {
    const actual =
      await vi.importActual<typeof EntitiesModule>("../../../../lib/entities");
    // If role_kind were narrowed to the closed enum, this would throw — and the page could
    // never receive an unknown kind to fall back on.
    const parsed = actual.jobPostingDetailSchema.parse({ ...BASE, role_kind: "blacksmith" });
    expect(parsed.role_kind).toBe("blacksmith");
  });

  it("tolerates an older server that omits the seven fields entirely", async () => {
    const actual =
      await vi.importActual<typeof EntitiesModule>("../../../../lib/entities");
    const legacy: Record<string, unknown> = { ...BASE };
    for (const k of [
      "role_kind",
      "area",
      "min_experience_years",
      "max_experience_years",
      "pay_type",
      "requirements",
      "benefits",
    ]) {
      delete legacy[k];
    }
    const parsed = actual.jobPostingDetailSchema.parse(legacy);
    expect(parsed.role_kind).toBeUndefined();
    expect(parsed.requirements).toBeUndefined();
  });
});
