import { describe, expect, it } from "vitest";
import {
  toPayerJobPostingBody,
  toPayerJobPostingPatchBody,
  type PostingEditInitial,
} from "./payer-api";
import { TRADE_FORM_KINDS_ALL, JOB_ROLE_LABELS } from "./job-roles";
import type { CreatePostingInput, UpdatePostingInput } from "./contracts";

/**
 * EMPLOYER posting LIVE-body contract tests (PR-B — INVERTED from the pre-lineage version).
 *
 * The posting form is now the traceable SOURCE of every Job Card field, and the backend
 * `PayerCreateJobPostingSchema` / `UpdateJobPostingSchema` both spread `postingContentFields`
 * (#1645/#1646/#1648 + migration 0131). So — the exact opposite of what this file used to pin — the
 * CREATE body MUST carry every card key + `role_kind`, and it must STILL never carry `trade_key`
 * (the company form dropped it), `payer_id` or `created_by` (XB-A). The PATCH body carries the same
 * card keys, the `clear` diff (#1652), and — on publish — the match half + `status:"open"`.
 */

// The FULL set PayerCreateJobPostingSchema accepts (mirrored from the backend DTO): base +
// postingContentFields + matchSkillFields.
const ALLOWED_KEYS = new Set([
  "org_label",
  "role_title",
  "location_label",
  "description",
  "vacancy_band",
  "vacancies",
  "skills",
  "city",
  "area",
  "pay_min",
  "pay_max",
  "pay_type",
  "min_experience_years",
  "max_experience_years",
  "shift",
  "needed_by",
  "benefits",
  "requirements",
  "role_kind",
  "match_skill_ids",
  "unticked_related_ids",
]);

const ORG = "Acme Manufacturing";

const FULL_INPUT: CreatePostingInput = {
  roleKind: "cnc_turner",
  roleTitle: "CNC Machinist",
  locationLabel: "Pune, MH",
  description: "Two-shift CNC role, PPE provided.",
  vacancies: 7,
  city: "Pune",
  area: "Chakan",
  payMin: 20000,
  payMax: 35000,
  payType: "in_hand",
  minExperienceYears: 1,
  maxExperienceYears: 5,
  shift: "rotational",
  neededBy: "immediate",
  requirements: ["Fanuc control"],
  benefits: ["PF + ESI"],
};

const MINIMAL_INPUT: CreatePostingInput = {
  roleTitle: "Fitter",
  vacancies: 1,
};

describe("toPayerJobPostingBody — carries every card key + role_kind (PR-B lineage)", () => {
  it("carries EVERY card key + role_kind on a full input (the form is the card's source)", () => {
    const body = toPayerJobPostingBody(FULL_INPUT, ORG);
    expect(body.role_kind).toBe("cnc_turner");
    expect(body.city).toBe("Pune");
    expect(body.area).toBe("Chakan");
    expect(body.pay_min).toBe(20000);
    expect(body.pay_max).toBe(35000);
    expect(body.pay_type).toBe("in_hand");
    expect(body.min_experience_years).toBe(1);
    expect(body.max_experience_years).toBe(5);
    expect(body.shift).toBe("rotational");
    expect(body.needed_by).toBe("immediate");
    expect(body.requirements).toEqual(["Fanuc control"]);
    expect(body.benefits).toEqual(["PF + ESI"]);
  });

  it("emits EXACTLY ONE of vacancy_band|vacancies (the RAW count, never a band)", () => {
    const body = toPayerJobPostingBody(FULL_INPUT, ORG);
    expect(("vacancy_band" in body) !== ("vacancies" in body)).toBe(true);
    expect(body.vacancies).toBe(7);
    expect(body).not.toHaveProperty("vacancy_band");
  });

  it("NEVER carries trade_key / payer_id / created_by (dropped trade + XB-A)", () => {
    for (const body of [toPayerJobPostingBody(FULL_INPUT, ORG), toPayerJobPostingBody(MINIMAL_INPUT, ORG)]) {
      for (const k of ["trade_key", "tradeKey", "payer_id", "payerId", "created_by", "createdBy"]) {
        expect(body).not.toHaveProperty(k);
      }
    }
  });

  it("stamps org_label from the session arg (there is no form field for it)", () => {
    const body = toPayerJobPostingBody(FULL_INPUT, ORG);
    expect(body.org_label).toBe(ORG);
    expect(body.role_title).toBe("CNC Machinist");
  });

  it("every emitted key is in the PayerCreateJobPostingSchema accepted set", () => {
    for (const body of [toPayerJobPostingBody(FULL_INPUT, ORG), toPayerJobPostingBody(MINIMAL_INPUT, ORG)]) {
      for (const key of Object.keys(body)) expect(ALLOWED_KEYS.has(key)).toBe(true);
      expect(body).toHaveProperty("org_label");
      expect(body).toHaveProperty("role_title");
    }
  });

  it("omits every optional key on a minimal body (carries only meaningful keys)", () => {
    const body = toPayerJobPostingBody(MINIMAL_INPUT, ORG);
    expect(Object.keys(body).sort()).toEqual(["org_label", "role_title", "vacancies"]);
  });

  it.each(TRADE_FORM_KINDS_ALL)("carries role_kind=%s through to the body for every one of the 21", (kind) => {
    const body = toPayerJobPostingBody({ ...MINIMAL_INPUT, roleKind: kind }, ORG);
    expect(body.role_kind).toBe(kind);
    // The label is the shared one — the card will render exactly this.
    expect(JOB_ROLE_LABELS[kind].label.length).toBeGreaterThan(0);
  });
});

// The FULL set UpdateJobPostingSchema accepts: create's set + status + clear (match half rides publish).
const PATCH_ALLOWED_KEYS = new Set([...ALLOWED_KEYS, "status", "clear"]);

const FULL_UPDATE_INPUT: UpdatePostingInput = {
  roleKind: "cnc_turner",
  roleTitle: "CNC Machinist",
  vacancies: 7,
  locationLabel: "Pune, MH",
  description: "Two-shift CNC role, PPE provided.",
  city: "Pune",
  area: "Chakan",
  payMin: 20000,
  payMax: 35000,
  payType: "in_hand",
  minExperienceYears: 1,
  maxExperienceYears: 5,
  shift: "rotational",
  neededBy: "immediate",
  requirements: ["Fanuc control"],
  benefits: ["PF + ESI"],
};

const INITIAL_FULL: PostingEditInitial = {
  locationLabel: "Pune, MH",
  description: "old",
  roleKind: "welder",
  city: "Pune",
  area: "Chakan",
  payMin: 10000,
  payMax: 20000,
  payType: "gross",
  minExperienceYears: 0,
  maxExperienceYears: 2,
  shift: "day",
  neededBy: "soon",
  requirements: ["old req"],
  benefits: ["old ben"],
};

describe("toPayerJobPostingPatchBody — card keys + clear diff + publish (PR-B)", () => {
  it("maps every card field to snake_case, and NO org_label (session identity isn't edited)", () => {
    const body = toPayerJobPostingPatchBody(FULL_UPDATE_INPUT);
    expect(body.role_kind).toBe("cnc_turner");
    expect(body.city).toBe("Pune");
    expect(body.pay_min).toBe(20000);
    expect(body.pay_type).toBe("in_hand");
    expect(body.shift).toBe("rotational");
    expect(body.needed_by).toBe("immediate");
    expect(body.requirements).toEqual(["Fanuc control"]);
    expect(body).not.toHaveProperty("org_label");
    for (const k of ["payMin", "neededBy", "payType"]) expect(body).not.toHaveProperty(k);
  });

  it("NEVER carries trade_key / payer_id / created_by", () => {
    const body = toPayerJobPostingPatchBody(FULL_UPDATE_INPUT);
    for (const k of ["trade_key", "payer_id", "created_by"]) expect(body).not.toHaveProperty(k);
  });

  it("computes `clear` from the diff — a field present in initial but blank now is unset", () => {
    // Only role_title is set; every clearable field HAD a value in initial and is absent now.
    const body = toPayerJobPostingPatchBody({ roleTitle: "CNC Machinist" }, INITIAL_FULL);
    const clear = body.clear as string[];
    expect(clear).toContain("city");
    expect(clear).toContain("pay_min");
    expect(clear).toContain("role_kind");
    expect(clear).toContain("requirements");
    // A field that IS set is never in clear (no set+clear contradiction).
    const body2 = toPayerJobPostingPatchBody({ roleTitle: "X", city: "Mumbai" }, INITIAL_FULL);
    expect(body2.clear as string[]).not.toContain("city");
    expect(body2.city).toBe("Mumbai");
  });

  it("omits `clear` entirely when nothing was blanked (empty list would 400 server-side)", () => {
    const body = toPayerJobPostingPatchBody(FULL_UPDATE_INPUT, INITIAL_FULL);
    expect(body).not.toHaveProperty("clear");
  });

  it("the publish variant adds match_skill_ids + unticks + status:open in the SAME patch", () => {
    const body = toPayerJobPostingPatchBody(FULL_UPDATE_INPUT, null, {
      matchSkillIds: ["mskill_cnc_turning"],
      untickedRelatedIds: ["mskill_vmc_operating"],
    });
    expect(body.match_skill_ids).toEqual(["mskill_cnc_turning"]);
    expect(body.unticked_related_ids).toEqual(["mskill_vmc_operating"]);
    expect(body.status).toBe("open");
    // Policy 10: NEVER a client reach set.
    expect(body).not.toHaveProperty("reach_skill_ids");
  });

  it("every emitted key is in the UpdateJobPostingSchema accepted set", () => {
    const body = toPayerJobPostingPatchBody(FULL_UPDATE_INPUT, INITIAL_FULL, {
      matchSkillIds: ["mskill_cnc_turning"],
      untickedRelatedIds: [],
    });
    for (const key of Object.keys(body)) expect(PATCH_ALLOWED_KEYS.has(key)).toBe(true);
    expect(body).toHaveProperty("role_title");
  });

  it.each(TRADE_FORM_KINDS_ALL)("carries role_kind=%s through the PATCH for every one of the 21", (kind) => {
    const body = toPayerJobPostingPatchBody({ roleTitle: "X", roleKind: kind });
    expect(body.role_kind).toBe(kind);
  });
});
