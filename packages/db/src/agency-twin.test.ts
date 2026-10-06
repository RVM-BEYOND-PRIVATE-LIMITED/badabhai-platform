/**
 * ADR-0050 — the PURE half of the agency twin sync: the §4.2 plan and the diff that decides
 * whether a sync writes (and emits) anything. The transactional half is exercised against a real
 * Postgres in `apps/api/src/agency-twin/agency-twin-sync.db.test.ts`.
 */
import { TRADE_TO_MATCH_SKILL } from "@badabhai/taxonomy";
import { describe, expect, it } from "vitest";

import {
  AGENCY_TWIN_VACANCY_BAND,
  agencyTwinConstantsProblems,
  d4AgencyFence,
  diffAgencyTwin,
  planAgencyTwin,
  type AgencyTwinContext,
  type AgencyTwinSource,
} from "./agency-twin";

const CREATED = new Date("2026-09-01T10:00:00.000Z");
const TURNER = "mskill_cnc_turner";
const VMC = "mskill_vmc_operator";

const source = (overrides: Partial<AgencyTwinSource> = {}): AgencyTwinSource => ({
  id: "11111111-1111-4111-8111-111111111111",
  status: "open",
  title: "CNC Turner — Day Shift",
  city: "Pune",
  area: "Chakan",
  payMin: 18000,
  payMax: 24000,
  payType: "in_hand",
  shift: "day",
  neededBy: "immediate",
  description: "Set and run Fanuc turning centres.",
  minExperienceYears: 2,
  maxExperienceYears: 8,
  benefits: ["PF + ESI", "Canteen"],
  requirements: ["ITI Turner"],
  roleKind: "cnc_turner",
  matchSkillIds: [TURNER],
  createdAt: CREATED,
  ...overrides,
});

const CTX: AgencyTwinContext = {
  matchV1Enabled: true,
  relatedSkillsDefault: "on",
  systemActorId: "c01de5e9-f3d7-4089-befd-2b4a4cda3829",
  orgLabel: "Agency vacancy",
};

describe("planAgencyTwin — status precedence (ADR-0050 §4.2)", () => {
  it("V1 off: every twin is a pre-staged, unserved draft with no published_at — whatever the source", () => {
    for (const status of ["open", "paused", "suspended", "closed"] as const) {
      const plan = planAgencyTwin(source({ status }), { ...CTX, matchV1Enabled: false });
      expect(plan.values.status, status).toBe("draft");
      expect(plan.values.publishedAt, status).toBeNull();
      expect(plan.refusedReason, status).toBeNull();
    }
  });

  it("V1 on: closed → closed, suspended → suspended, paused → paused, open → open", () => {
    for (const status of ["closed", "suspended", "paused", "open"] as const) {
      expect(planAgencyTwin(source({ status }), CTX).values.status).toBe(status);
    }
  });

  it("V1 on: published_at is the source's created_at — the honest visibility time", () => {
    expect(planAgencyTwin(source(), CTX).values.publishedAt).toEqual(CREATED);
  });

  it.each([
    ["no_match_skills", { matchSkillIds: [] }],
    ["unknown_match_skill", { matchSkillIds: [TURNER, "mskill_not_in_vocabulary"] }],
    ["text_screen_failed", { description: "Call 9876543210 for details" }],
    ["text_screen_failed", { title: "Turner at Acme Engineering Pvt Ltd" }],
    ["text_screen_failed", { benefits: ["See www.example.com"] }],
  ] as const)(
    "an OPEN source that is unservable (%s) is a paused twin with the reason",
    (reason, o) => {
      const plan = planAgencyTwin(source(o as Partial<AgencyTwinSource>), CTX);
      expect(plan.values.status).toBe("paused");
      expect(plan.refusedReason).toBe(reason);
      // Refused: no match and no reach — it reaches nobody whatever its status.
      expect(plan.values.matchSkillIds).toEqual([]);
      expect(plan.values.reachSkillIds).toEqual([]);
      expect(plan.values.industryId).toBeNull();
    },
  );

  it("a non-open source keeps its own status even when also unservable (closed beats refused)", () => {
    const plan = planAgencyTwin(source({ status: "closed", matchSkillIds: [] }), CTX);
    expect(plan.values.status).toBe("closed");
    expect(plan.refusedReason).toBeNull();
  });
});

describe("planAgencyTwin — the field map (ADR-0050 §4.2)", () => {
  it("copies D4's field map verbatim, nulls preserved, with the fixed label and band", () => {
    const s = source({ area: null, payType: null, benefits: null });
    const v = planAgencyTwin(s, CTX).values;
    expect(v).toMatchObject({
      orgLabel: "Agency vacancy",
      roleTitle: s.title,
      city: s.city,
      area: null,
      payMin: s.payMin,
      payMax: s.payMax,
      payType: null,
      shift: s.shift,
      neededBy: s.neededBy,
      description: s.description,
      minExperienceYears: s.minExperienceYears,
      maxExperienceYears: s.maxExperienceYears,
      benefits: null,
      requirements: s.requirements,
      roleKind: s.roleKind,
      vacancyBand: AGENCY_TWIN_VACANCY_BAND,
    });
  });

  it("match = the explicit pick; reach = match ∪ related (related on) or match only (related off)", () => {
    const on = planAgencyTwin(source({ matchSkillIds: [VMC] }), CTX).values;
    expect(on.matchSkillIds).toEqual([VMC]);
    expect(on.reachSkillIds).toContain(VMC);
    expect(on.reachSkillIds.length).toBeGreaterThan(1);
    expect(on.industryId).toBe("ind_industrial_manufacturing");

    const off = planAgencyTwin(source({ matchSkillIds: [VMC] }), {
      ...CTX,
      relatedSkillsDefault: "off",
    }).values;
    expect(off.reachSkillIds).toEqual([VMC]);
  });

  it("C4: never infers a match skill from trade_key — an empty pick stays empty", () => {
    // The bridge exists, and a row with a bridged trade still gets NO skill from it.
    expect(Object.keys(TRADE_TO_MATCH_SKILL).length).toBeGreaterThan(0);
    const plan = planAgencyTwin(source({ matchSkillIds: [] }), CTX);
    expect(plan.values.matchSkillIds).toEqual([]);
    expect(plan.refusedReason).toBe("no_match_skills");
  });
});

describe("diffAgencyTwin — an unchanged source writes nothing", () => {
  const planned = planAgencyTwin(source(), CTX).values;

  it("is empty for an identical twin (the idempotency property)", () => {
    expect(diffAgencyTwin(planned, { ...planned })).toEqual([]);
    expect(
      diffAgencyTwin(planned, {
        ...planned,
        publishedAt: new Date(planned.publishedAt!.getTime()),
        benefits: [...(planned.benefits ?? [])],
      }),
    ).toEqual([]);
  });

  it("reports one key per editorial unit — pay_band, experience, match_skills, status", () => {
    expect(diffAgencyTwin(planned, { ...planned, payMax: 99999 })).toEqual(["pay_band"]);
    expect(diffAgencyTwin(planned, { ...planned, minExperienceYears: 0 })).toEqual(["experience"]);
    expect(diffAgencyTwin(planned, { ...planned, reachSkillIds: [TURNER] })).toEqual([
      "match_skills",
    ]);
    expect(diffAgencyTwin(planned, { ...planned, status: "paused" })).toEqual(["status"]);
    expect(diffAgencyTwin(planned, { ...planned, publishedAt: null })).toEqual(["status"]);
    expect(diffAgencyTwin(planned, { ...planned, benefits: ["Canteen", "PF + ESI"] })).toEqual([
      "benefits",
    ]);
    expect(diffAgencyTwin(planned, { ...planned, orgLabel: "x" })).toEqual(["org_label"]);
  });
});

describe("agencyTwinConstantsProblems — the Q3 boot check", () => {
  // The SHIPPED constants live in @badabhai/config; their boot check is asserted where they are
  // consumed (apps/api `agency-twin.service.test.ts`), so this package takes no config edge.
  it("passes a uuid actor and a neutral label", () => {
    expect(agencyTwinConstantsProblems(CTX.systemActorId, CTX.orgLabel)).toEqual([]);
  });

  it("fails closed on a non-uuid actor, an empty label, or a label with identity in it", () => {
    expect(agencyTwinConstantsProblems("ops", "Agency vacancy")).toHaveLength(1);
    expect(agencyTwinConstantsProblems(CTX.systemActorId, " ")).toHaveLength(1);
    for (const bad of ["Acme Engineering Pvt Ltd", "Call 9876543210", "www.acme.example"]) {
      expect(agencyTwinConstantsProblems(CTX.systemActorId, bad), bad).toHaveLength(1);
    }
  });
});

describe("d4AgencyFence — D4 never converts an agency row (ADR-0050 §6.2, C6)", () => {
  const SEED = { id: "a", payerId: null };
  const AGENCY_TWINNED = { id: "b", payerId: "p1" };
  const AGENCY_BARE = { id: "c", payerId: "p2" };

  it("converts only payer_id-NULL rows, and reports every payer-owned row", () => {
    const fence = d4AgencyFence([SEED, AGENCY_TWINNED, AGENCY_BARE], new Set(["b"]));
    expect(fence.convertible).toEqual([SEED]);
    expect(fence.agencyRows).toEqual([AGENCY_TWINNED, AGENCY_BARE]);
    expect(fence.agencyRowsWithoutTwin).toEqual([AGENCY_BARE]);
  });

  it("a twinned agency row is STILL not convertible", () => {
    const fence = d4AgencyFence([AGENCY_TWINNED], new Set(["b"]));
    expect(fence.convertible).toEqual([]);
    expect(fence.agencyRowsWithoutTwin).toEqual([]);
  });
});
