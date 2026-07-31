import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Matching V1 payer-seam transport tests (ADR-0036). Exercises the REAL `payerFetch`
 * against a mocked fetch to pin the properties that would fail SILENTLY if they broke —
 * the ones where a wrong body still returns 200 and the damage only shows up as a job
 * nobody sees:
 *
 *  - the publish PATCH sends `match_skill_ids` + `unticked_related_ids` + `status:"open"`
 *    and NEVER a `reach_skill_ids`. A client-supplied reach set would let a payer widen
 *    past the curated relations, which Policy 10 forbids — and the backend has no such
 *    field, so sending one would be silently dropped rather than rejected.
 *  - no `payer_id` on any body (XB-A: the session Bearer is the tenant identity).
 *  - the neutral 404 → `null` no-oracle contract on publish.
 *  - the reach preview parses the whole shape, including the related rows the UI needs.
 */

const TOKEN = "payer.jwt.token";

vi.mock("./auth/session-cookie", () => ({
  readApiToken: vi.fn(async () => TOKEN),
  API_TOKEN_COOKIE_NAME: "bb_payer_token",
  sessionCookieOptions: () => ({}),
}));
vi.mock("./auth", () => ({
  requirePayer: vi.fn(async () => ({
    payerId: "22222222-2222-4222-8222-222222222222",
    displayLabel: "Acme Tools",
    role: "employer",
  })),
}));

const fetchMock = vi.fn();

const POSTING_ID = "33333333-3333-4333-8333-333333333333";

const PREVIEW = {
  skills: [
    {
      skill_id: "mskill_cnc_turning",
      label: "CNC turning",
      reach_count: 42,
      related: [
        { skill_id: "mskill_vmc_operating", label: "VMC operating", ticked: true, reach_count: 18 },
      ],
    },
  ],
  reach_skill_ids: ["mskill_cnc_turning", "mskill_vmc_operating"],
  reach_total: 55,
  reach_tier1: 42,
  zero_reach: false,
  applied_unticked_ids: [],
  max_skills_per_posting: 3,
};

/** A complete `jobPostingWireSchema` row — the PATCH response the publish call parses. */
const POSTING_WIRE = {
  id: POSTING_ID,
  payer_id: "22222222-2222-4222-8222-222222222222",
  created_by: "22222222-2222-4222-8222-222222222222",
  org_label: "Acme Tools",
  role_title: "CNC Machinist",
  location_label: "Pune, MH",
  description: null,
  vacancy_band: "1-5",
  status: "open",
  skill_phrases: [],
  skill_ids: [],
  created_at: "2026-07-31T00:00:00.000Z",
  updated_at: "2026-07-31T00:00:00.000Z",
  closed_at: null,
};

beforeEach(() => {
  process.env.PAYER_API_URL = "http://api.test";
  process.env.PAYMENTS_ENABLE_REAL = "false";
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** The parsed JSON body of the Nth fetch call (0-based). */
function sentBody(call = 0): Record<string, unknown> {
  const init = fetchMock.mock.calls[call]?.[1] as { body?: string } | undefined;
  return JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
}

describe("GET /payer/match/skills — the closed vocabulary", () => {
  it("returns the skills array and rides the session Bearer", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        skills: [
          {
            skill_id: "mskill_cnc_turning",
            label: "CNC turning",
            industry_id: "ind_manufacturing",
            related_skill_ids: ["mskill_vmc_operating"],
          },
        ],
      }),
    );
    const { listMatchSkills } = await import("./payer-api");
    const skills = await listMatchSkills();
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({ skill_id: "mskill_cnc_turning", label: "CNC turning" });

    const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toContain("/payer/match/skills");
    // Lower-case key: `payerFetch` builds a plain header record, not a `Headers`, so the
    // literal casing is what goes on the wire.
    expect(init.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("REJECTS a non-`mskill_` id rather than passing it to the picker", async () => {
    // A malformed id would be rendered as a chip and then posted back at publish, where
    // the backend's closed-set check would 400 — long after the payer chose it.
    fetchMock.mockResolvedValue(
      jsonResponse({
        skills: [
          { skill_id: "welding", label: "Welding", industry_id: "x", related_skill_ids: [] },
        ],
      }),
    );
    const { listMatchSkills } = await import("./payer-api");
    await expect(listMatchSkills()).rejects.toThrow();
  });
});

describe("POST /payer/match/reach-preview — the live counter", () => {
  it("sends snake_case ids and NO payer_id (XB-A), and parses the full shape", async () => {
    fetchMock.mockResolvedValue(jsonResponse(PREVIEW));
    const { previewReach } = await import("./payer-api");
    const preview = await previewReach({
      matchSkillIds: ["mskill_cnc_turning"],
      untickedRelatedIds: ["mskill_grinding"],
    });

    expect(sentBody()).toEqual({
      match_skill_ids: ["mskill_cnc_turning"],
      unticked_related_ids: ["mskill_grinding"],
    });
    expect(sentBody()).not.toHaveProperty("payer_id");
    expect(preview.reach_total).toBe(55);
    expect(preview.skills[0]!.related[0]).toMatchObject({ ticked: true, reach_count: 18 });
    expect(preview.max_skills_per_posting).toBe(3);
  });

  it("carries the zero_reach flag through untouched (E13 depends on it)", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ ...PREVIEW, reach_total: 0, reach_tier1: 0, zero_reach: true }),
    );
    const { previewReach } = await import("./payer-api");
    const preview = await previewReach({ matchSkillIds: ["mskill_cnc_turning"], untickedRelatedIds: [] });
    expect(preview.zero_reach).toBe(true);
    expect(preview.reach_total).toBe(0);
  });
});

describe("PATCH /payer/job-postings/:id — attach match skills and publish (moment ③)", () => {
  it("sends match_skill_ids + unticks + status:open, and NEVER a reach_skill_ids", async () => {
    fetchMock.mockResolvedValue(jsonResponse(POSTING_WIRE));
    const { publishPostingWithMatchSkills } = await import("./payer-api");
    await publishPostingWithMatchSkills(POSTING_ID, {
      matchSkillIds: ["mskill_cnc_turning"],
      untickedRelatedIds: ["mskill_vmc_operating"],
    });

    const body = sentBody();
    expect(body).toEqual({
      match_skill_ids: ["mskill_cnc_turning"],
      unticked_related_ids: ["mskill_vmc_operating"],
      status: "open",
    });
    // The reach set is resolved SERVER-side from these two inputs. A client-supplied set
    // is the one way a payer could reach workers outside the curated relations.
    expect(body).not.toHaveProperty("reach_skill_ids");
    expect(body).not.toHaveProperty("payer_id");

    const [url, init] = fetchMock.mock.calls[0] as [string, { method: string }];
    expect(url).toContain(`/payer/job-postings/${POSTING_ID}`);
    expect(init.method).toBe("PATCH");
  });

  it("maps the neutral 404 (unknown OR not-owned) to null — no cross-tenant oracle", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: "Not Found" }, 404));
    const { publishPostingWithMatchSkills } = await import("./payer-api");
    await expect(
      publishPostingWithMatchSkills(POSTING_ID, {
        matchSkillIds: ["mskill_cnc_turning"],
        untickedRelatedIds: [],
      }),
    ).resolves.toBeNull();
  });

  it("propagates a non-404 failure (a transient error is NOT 'not found')", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: "boom" }, 503));
    const { publishPostingWithMatchSkills } = await import("./payer-api");
    await expect(
      publishPostingWithMatchSkills(POSTING_ID, {
        matchSkillIds: ["mskill_cnc_turning"],
        untickedRelatedIds: [],
      }),
    ).rejects.toThrow(/returned 503/);
  });
});
