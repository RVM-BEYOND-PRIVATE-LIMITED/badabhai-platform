import { describe, expect, it, vi } from "vitest";
import type { RequestContext } from "../common/request-context";
import type { EventsService } from "../events/events.service";
import type { MatchConfigService } from "../match/match-config.service";
import { decodeCandidateCursor } from "./candidate-search.cursor";
import { CandidateSearchSchema, type CandidateSearchInput } from "./candidate-search.dto";
import type { WorkerSkillsRepository } from "../match/worker-skills.repository";
import type {
  CandidatePoolQuery,
  CandidatePoolRow,
  CandidateRoleRow,
  CandidateSearchRepository,
} from "./candidate-search.repository";
import {
  CandidateSearchService,
  expandSameLabelRoles,
  relatedSkillsOf,
  toCandidateRow,
  type CandidateTradeLevelRow,
} from "./candidate-search.service";

const CTX = { correlationId: "corr-1", requestId: "req-1" } as RequestContext;
const PAYER = "11111111-1111-4111-8111-111111111111";
const W1 = "face2000-0000-4000-8000-000000000001";
const W2 = "face2000-0000-4000-8000-000000000002";
const W3 = "face2000-0000-4000-8000-000000000003";

function poolRow(workerId: string, over: Partial<CandidatePoolRow> = {}): CandidatePoolRow {
  return {
    workerId,
    matched: true,
    matchClass: 1,
    skillId: "mskill_cnc_turner",
    industryId: "ind_industrial_manufacturing",
    skillMonths: 48,
    industryMonths: 54,
    currentCity: "Pune",
    position: 1,
    ...over,
  };
}

interface Harness {
  service: CandidateSearchService;
  repo: {
    searchPool: ReturnType<typeof vi.fn>;
    listPoolCities: ReturnType<typeof vi.fn>;
    listWantedRoles: ReturnType<typeof vi.fn>;
  };
  workerSkills: { listStatedTradeLevels: ReturnType<typeof vi.fn> };
  emitted: unknown[];
}

function setup(opts: {
  rows?: CandidatePoolRow[];
  counts?: { total: number; matched: number; unrecorded: number };
  cities?: string[];
  roles?: CandidateRoleRow[];
  levels?: CandidateTradeLevelRow[];
} = {}): Harness {
  const rows = opts.rows ?? [poolRow(W1)];
  const repo = {
    searchPool: vi.fn(async (_q: CandidatePoolQuery) => ({
      counts: opts.counts ?? { total: rows.length, matched: rows.length, unrecorded: 0 },
      rows,
    })),
    listPoolCities: vi.fn(async () => opts.cities ?? ["Pune"]),
    listWantedRoles: vi.fn(async () => opts.roles ?? []),
  };
  const workerSkills = { listStatedTradeLevels: vi.fn(async () => opts.levels ?? []) };
  const matchConfig = { get: vi.fn(async () => ({ tierFloorMonths: 36 })) };
  const emitted: unknown[] = [];
  const events = { emit: vi.fn(async (p: unknown) => void emitted.push(p)) };
  const service = new CandidateSearchService(
    repo as unknown as CandidateSearchRepository,
    workerSkills as unknown as WorkerSkillsRepository,
    matchConfig as unknown as MatchConfigService,
    events as unknown as EventsService,
  );
  return { service, repo, workerSkills, emitted };
}

const search = (h: Harness, body: CandidateSearchInput) =>
  h.service.search(PAYER, CandidateSearchSchema.parse(body), CTX);

describe("CandidateSearchService.search", () => {
  it("passes the resolved filters to the pool read, one row past the page", async () => {
    const h = setup();
    await search(h, {
      skill_ids: ["mskill_cnc_turner"],
      experience: "3_5",
      industry_id: "ind_industrial_manufacturing",
      industry_experience: "1_3",
      strict: true,
      limit: 10,
    });
    const q = h.repo.searchPool.mock.calls[0]![0] as CandidatePoolQuery;
    expect(q.skillIds).toEqual(["mskill_cnc_turner"]);
    expect(q.relatedSkillIds).not.toContain("mskill_cnc_turner");
    expect(q.relatedSkillIds.length).toBeGreaterThan(0);
    expect(q.experience).toEqual({ min: 36, max: 60 });
    expect(q.industryExperience).toEqual({ min: 12, max: 36 });
    expect(q.industryId).toBe("ind_industrial_manufacturing");
    expect(q.city).toBeNull();
    expect(q.tierFloorMonths).toBe(36);
    expect(q.strict).toBe(true);
    expect(q.after).toBeNull();
    expect(q.limit).toBe(11);
  });

  it("mints nextCursor from the last row ON the page only when a row past it came back", async () => {
    const rows = [poolRow(W1, { position: 1 }), poolRow(W2, { position: 2 }), poolRow(W3, { position: 3 })];
    const h = setup({ rows });
    const page = await search(h, { limit: 2 });
    expect(page.candidates.map((c) => c.workerId)).toEqual([W1, W2]);
    expect(decodeCandidateCursor(page.nextCursor ?? "")).toMatchObject({ workerId: W2, served: 2 });

    const last = await search(setup({ rows: [poolRow(W1)] }), { limit: 2 });
    expect(last.nextCursor).toBeNull();
  });

  it("resumes after the cursor's worker, and refuses a cursor minted under other filters", async () => {
    const rows = [poolRow(W1, { position: 1 }), poolRow(W2, { position: 2 }), poolRow(W3, { position: 3 })];
    const first = await search(setup({ rows }), { skill_ids: ["mskill_cnc_turner"], limit: 2 });
    const h = setup({ rows: [poolRow(W3, { position: 3 })] });
    await search(h, { skill_ids: ["mskill_cnc_turner"], limit: 2, cursor: first.nextCursor });
    expect((h.repo.searchPool.mock.calls[0]![0] as CandidatePoolQuery).after).toEqual({
      workerId: W2,
      served: 2,
    });

    const other = setup();
    await expect(
      search(other, { skill_ids: ["mskill_vmc_operator"], limit: 2, cursor: first.nextCursor }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      search(other, { skill_ids: ["mskill_cnc_turner"], strict: true, limit: 2, cursor: first.nextCursor }),
    ).rejects.toMatchObject({ status: 400 });
    // Refused before any read, and nothing emitted.
    expect(other.repo.searchPool).not.toHaveBeenCalled();
    expect(other.emitted).toHaveLength(0);
  });

  it("returns the three counts from the same read, and the mode it ran in", async () => {
    const h = setup({ counts: { total: 62, matched: 14, unrecorded: 9 } });
    const res = await search(h, { city: "Pune" });
    expect(res).toMatchObject({ total: 62, matched: 14, unrecorded: 9, filtered: true, strict: false });
  });

  it("unfiltered: the counts as read (every row matches nothing-asked) and filtered=false", async () => {
    const h = setup({ counts: { total: 5, matched: 5, unrecorded: 0 } });
    expect(await search(h, {})).toMatchObject({ total: 5, matched: 5, unrecorded: 0, filtered: false });
  });

  it("an empty pool is a real answer: the counts, no rows, no cursor", async () => {
    const h = setup({ rows: [], counts: { total: 0, matched: 0, unrecorded: 0 } });
    expect(await search(h, { skill_ids: ["mskill_cnc_turner"], strict: true })).toEqual({
      total: 0,
      matched: 0,
      unrecorded: 0,
      filtered: true,
      strict: true,
      candidates: [],
      nextCursor: null,
    });
    // No detail reads for nobody.
    expect(h.workerSkills.listStatedTradeLevels).toHaveBeenCalledWith([]);
  });

  it("resolves a city to every pooled spelling of it, and the unrecognised ones as unrecorded", async () => {
    const h = setup({ cities: ["Pune", "pune ", "PUNE", "Chennai", "near the bus stand"] });
    await search(h, { city: "pune" });
    const city = (h.repo.searchPool.mock.calls[0]![0] as CandidatePoolQuery).city!;
    expect([...city.matchKeys].sort()).toEqual(["pune", "pune "].sort());
    expect(city.matchKeys).not.toContain("chennai");
    expect(city.unrecognisedKeys).toEqual(["near the bus stand"]);
  });

  it("refuses a city the gazetteer does not recognise — before any read (no free-text probe)", async () => {
    const h = setup({ cities: ["near the bus stand"] });
    await expect(search(h, { city: "near the bus stand" })).rejects.toMatchObject({ status: 400 });
    expect(h.repo.searchPool).not.toHaveBeenCalled();
    expect(h.repo.listPoolCities).not.toHaveBeenCalled();
    expect(h.emitted).toHaveLength(0);
  });

  it("the facet reads the pool's cities once per window; the FILTER always reads fresh; no failure is cached", async () => {
    const h = setup({ cities: ["Pune"] });
    await h.service.filters();
    await h.service.filters();
    expect(h.repo.listPoolCities).toHaveBeenCalledTimes(1);
    // A city-filtered page never trusts the facet's cache (a newly recorded spelling would be a "no").
    await search(h, { city: "Pune" });
    await search(h, { city: "Pune" });
    expect(h.repo.listPoolCities).toHaveBeenCalledTimes(3);

    const failing = setup({ cities: ["Pune"] });
    failing.repo.listPoolCities.mockRejectedValueOnce(new Error("pool read failed"));
    await expect(failing.service.filters()).rejects.toThrow("pool read failed");
    await expect(failing.service.filters()).resolves.toMatchObject({ cities: ["Pune"] });
    expect(failing.repo.listPoolCities).toHaveBeenCalledTimes(2);
  });

  it("emits ONE event with the search's shape and counts — never a worker id or the city", async () => {
    const h = setup({ rows: [poolRow(W1), poolRow(W2)], counts: { total: 9, matched: 2, unrecorded: 1 } });
    await search(h, { skill_ids: ["mskill_cnc_turner"], city: "Pune", strict: true });
    expect(h.emitted).toHaveLength(1);
    const event = h.emitted[0] as { event_name: string; actor: unknown; payload: Record<string, unknown> };
    expect(event.event_name).toBe("payer.candidate_search_performed");
    expect(event.actor).toEqual({ actor_type: "payer", actor_id: PAYER });
    expect(event.payload).toEqual({
      skill_ids: ["mskill_cnc_turner"],
      experience_filtered: false,
      industry_filtered: false,
      industry_experience_filtered: false,
      city_filtered: true,
      strict: true,
      first_page: true,
      result_count: 2,
      matched: 2,
      unrecorded: 1,
      total: 9,
      limit: 20,
    });
    const text = JSON.stringify(event);
    expect(text).not.toContain(W1);
    expect(text).not.toContain("Pune");
  });

  it("fails closed: a read error propagates and nothing is emitted", async () => {
    const h = setup();
    h.repo.searchPool.mockRejectedValueOnce(new Error("connection terminated"));
    await expect(search(h, {})).rejects.toThrow("connection terminated");
    expect(h.emitted).toHaveLength(0);
  });

  it("a detail-read error fails the page too (never a half-built card)", async () => {
    const h = setup();
    h.repo.listWantedRoles.mockRejectedValueOnce(new Error("boom"));
    await expect(search(h, {})).rejects.toThrow("boom");
    expect(h.emitted).toHaveLength(0);
  });
});

describe("the masked row (toCandidateRow — the only builder)", () => {
  const ALLOWED = [
    "workerId",
    "matchesFilters",
    "matchTier",
    "role",
    "otherRoles",
    "skillMonths",
    "industry",
    "industryMonths",
    "city",
    "tradeLevels",
  ].sort();

  it("carries exactly the allowlisted keys, labelled from the closed vocabulary", () => {
    const row = toCandidateRow(
      poolRow(W1),
      true,
      [
        { workerId: W1, skillId: "mskill_cnc_turner", monthsBucketed: 48 },
        { workerId: W1, skillId: "mskill_vmc_operator", monthsBucketed: 12 },
      ],
      [{ workerId: W1, skillId: "mskill_cnc_turner", tradeLevel: "setter", levelConfirmed: true }],
    );
    expect(Object.keys(row).sort()).toEqual(ALLOWED);
    expect(row).toEqual({
      workerId: W1,
      matchesFilters: true,
      matchTier: 1,
      role: { id: "mskill_cnc_turner", label: "CNC Turner" },
      otherRoles: [{ id: "mskill_vmc_operator", label: "VMC Operator" }],
      skillMonths: 48,
      industry: { id: "ind_industrial_manufacturing", label: "Industrial Manufacturing" },
      industryMonths: 54,
      city: "Pune",
      tradeLevels: [
        {
          skillId: "mskill_cnc_turner",
          skillLabel: "CNC Turner",
          tradeLevel: "setter",
          tradeLevelLabel: "Setter",
          levelConfirmed: true,
        },
      ],
    });
  });

  it("matchTier is null without a role filter, and for a worker holding neither role", () => {
    expect(toCandidateRow(poolRow(W1), false, [], []).matchTier).toBeNull();
    expect(toCandidateRow(poolRow(W1, { matchClass: 3 }), true, [], []).matchTier).toBeNull();
    expect(toCandidateRow(poolRow(W1, { matched: false }), true, [], []).matchesFilters).toBe(false);
    expect(toCandidateRow(poolRow(W1, { matchClass: 2 }), true, [], []).matchTier).toBe(2);
  });

  it("shows a city only when the gazetteer recognises it — raw free text never reaches a payer", () => {
    expect(toCandidateRow(poolRow(W1, { currentCity: "pune" }), false, [], []).city).toBe("Pune");
    expect(toCandidateRow(poolRow(W1, { currentCity: "near the bus stand" }), false, [], []).city).toBeNull();
    expect(toCandidateRow(poolRow(W1, { currentCity: null }), false, [], []).city).toBeNull();
  });

  it("carries ONLY the lead role's rung — never one on a switched-off or other trade", () => {
    const row = toCandidateRow(poolRow(W1, { skillId: "mskill_cnc_turner" }), false, [], [
      { workerId: W1, skillId: "mskill_cnc_turner", tradeLevel: "setter", levelConfirmed: true },
      { workerId: W1, skillId: "mskill_vmc_operator", tradeLevel: "operator", levelConfirmed: false },
    ]);
    expect(row.tradeLevels.map((l) => l.skillId)).toEqual(["mskill_cnc_turner"]);
    const none = toCandidateRow(poolRow(W1, { skillId: "mskill_tig_welder" }), false, [], [
      { workerId: W1, skillId: "mskill_cnc_turner", tradeLevel: "setter", levelConfirmed: true },
    ]);
    expect(none.tradeLevels).toEqual([]);
  });

  it("names at most four other roles and never repeats the lead role", () => {
    const roles: CandidateRoleRow[] = [
      "mskill_cnc_turner",
      "mskill_vmc_operator",
      "mskill_hmc_operator",
      "mskill_cnc_setter_operator",
      "mskill_cnc_programmer",
      "mskill_cam_programmer",
    ].map((skillId, i) => ({ workerId: W1, skillId, monthsBucketed: 60 - i * 6 }));
    const row = toCandidateRow(poolRow(W1), false, roles, []);
    expect(row.otherRoles).toHaveLength(4);
    expect(row.otherRoles.map((r) => r.id)).not.toContain("mskill_cnc_turner");
  });

  it("cannot carry identity: no input field holds any, so no output can", () => {
    const text = JSON.stringify(toCandidateRow(poolRow(W1), true, [], []));
    for (const marker of ["full_name", "fullName", "phone", "+91", "photo", "employer", "salary", "address"]) {
      expect(text).not.toContain(marker);
    }
  });
});

describe("vocabulary helpers", () => {
  it("a role whose label another id shares widens to both ids", () => {
    const ids = expandSameLabelRoles(["mskill_3d_designer"]);
    expect(ids).toEqual(expect.arrayContaining(["mskill_3d_designer", "mskill_cad_designer_3d"]));
    expect(expandSameLabelRoles(["mskill_cnc_turner"])).toEqual(["mskill_cnc_turner"]);
  });

  it("related skills exclude the asked roles", () => {
    const related = relatedSkillsOf(["mskill_cnc_turner", "mskill_vmc_operator"]);
    expect(related).not.toContain("mskill_cnc_turner");
    expect(related).not.toContain("mskill_vmc_operator");
  });
});

describe("CandidateSearchService.filters", () => {
  it("offers one role per label, the vocabulary's industries, the buckets and the pool's canonical cities", async () => {
    const h = setup({ cities: ["pune", "Pune", "Chennai", "near the bus stand"] });
    const f = await h.service.filters();
    const labels = f.roles.map((r) => r.label);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels.filter((l) => l === "3D CAD Designer")).toHaveLength(1);
    expect(f.industries.map((i) => i.id)).toContain("ind_industrial_manufacturing");
    expect(f.experienceBuckets.map((b) => b.id)).toEqual(["under_1", "1_3", "3_5", "5_10", "10_plus"]);
    expect(f.cities).toEqual(["Chennai", "Pune"]);
    expect(f.maxRoles).toBe(5);
  });
});
