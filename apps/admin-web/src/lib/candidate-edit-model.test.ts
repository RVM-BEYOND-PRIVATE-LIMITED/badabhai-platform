import { describe, expect, it } from "vitest";
import { candidateRecord } from "../../test/candidate-record";
import {
  EDIT_SECTIONS,
  FACT_LABELS,
  UNEDITABLE_FACT_KEYS,
  draftFactValue,
  editChanges,
  formatFactValue,
  initialEditDraft,
  validateEditDraft,
} from "./candidate-edit-model";

/**
 * The correction form's pure model (A7, #2577 / #2561): what each section starts with, the value
 * shape the API receives, the field-by-field diff, and the input rules that stop a request the
 * API would only refuse.
 */
const record = candidateRecord();

describe("the editable sections", () => {
  it("cover location, trade, experience, pay, skills, languages, schooling and history", () => {
    expect(EDIT_SECTIONS.map((s) => s.id)).toEqual([
      "location",
      "trade",
      "work",
      "pay",
      "skills",
      "languages",
      "schooling",
      "history",
    ]);
  });

  it("never include a locked field, and never pretend to edit a fact the record cannot read back", () => {
    const keys = new Set(EDIT_SECTIONS.flatMap((s) => s.fields.map((f) => f.factKey)));
    for (const locked of ["full_name", "phone_e164", "whatsapp_enc", "resume_show_photo"]) {
      expect(keys.has(locked)).toBe(false);
    }
    for (const uneditable of UNEDITABLE_FACT_KEYS) expect(keys.has(uneditable)).toBe(false);
  });
});

describe("the starting draft", () => {
  it("pre-fills the location and the trade ids from the record", () => {
    expect(initialEditDraft(record, "location")).toEqual({
      current_city: "Pune",
      preferred_locations: "Pune, Chakan",
    });
    expect(initialEditDraft(record, "trade")).toEqual({
      trade: "trade_welder",
      role: "role_tig_welder",
      secondary_roles: "occ_fitter",
    });
  });

  it("pre-fills experience and the pay/preferences group in the correction shapes", () => {
    expect(initialEditDraft(record, "work").experience).toBe("4");
    const pay = initialEditDraft(record, "pay");
    expect(pay.salary_min).toBe("18000");
    expect(pay.salary_max).toBe("22000");
    expect(pay.salary_period).toBe("month");
    expect(pay.availability_status).toBe("within_week");
    expect(pay.notice_period_days).toBe("15");
    expect(pay.job_type).toBe("permanent");
    expect(pay.relocation).toBe("true");
    expect(pay.accommodation).toBe("false");
    expect(pay.commute_max_km).toBe("15");
    expect(pay.willing_to_travel).toBe("true");
  });
});

describe("the value the API receives", () => {
  it("an empty salary band clears it; one end alone is a point figure", () => {
    expect(draftFactValue("salary_expected", { salary_min: "", salary_max: "" })).toBeNull();
    expect(draftFactValue("salary_expected", { salary_min: "12000", salary_max: "" })).toEqual({
      min: 12000,
      max: null,
    });
  });

  it("availability is one object, or null when every part is cleared", () => {
    expect(
      draftFactValue("availability", {
        availability_status: "",
        available_from: "",
        notice_period_days: "",
      }),
    ).toBeNull();
    expect(
      draftFactValue("availability", {
        availability_status: "within_week",
        available_from: "2026-12-01",
        notice_period_days: "15",
      }),
    ).toEqual({
      status: "within_week",
      available_from: "2026-12-01",
      notice_period_days: 15,
    });
  });

  it("a city list is trimmed and split; a tri-state answer is a boolean or null", () => {
    expect(draftFactValue("preferred_locations", { preferred_locations: " Pune, Thane " })).toEqual(
      ["Pune", "Thane"],
    );
    expect(draftFactValue("relocation", { relocation: "" })).toBeNull();
    expect(draftFactValue("relocation", { relocation: "false" })).toBe(false);
  });
});

describe("the review diff", () => {
  it("is empty until a field changes, and then names each changed fact once", () => {
    const initial = initialEditDraft(record, "location");
    expect(editChanges(record, "location", initial)).toEqual([]);

    const changed = editChanges(record, "location", {
      ...initial,
      current_city: "Mumbai",
      preferred_locations: "Mumbai, Thane",
    });
    expect(changed.map((c) => c.factKey)).toEqual(["current_city", "preferred_locations"]);
    expect(changed[0]).toMatchObject({
      label: FACT_LABELS.current_city,
      before: "Pune",
      after: "Mumbai",
      value: "Mumbai",
    });
  });

  it("shows a salary band and an availability answer in words", () => {
    expect(formatFactValue("salary_expected", { min: 12000, max: 18000 })).toContain("12,000");
    expect(
      formatFactValue("availability", {
        status: "within_week",
        available_from: "2026-12-01",
        notice_period_days: 15,
      }),
    ).toBe("Within a week · from 2026-12-01 · 15 days notice");
    expect(formatFactValue("experience", 4)).toBe("4 years");
    expect(formatFactValue("relocation", null)).toBe("—");
  });
});

describe("input validation", () => {
  const initial = initialEditDraft(record, "location");

  it("refuses an empty city or more than five preferred cities", () => {
    expect(
      validateEditDraft(record, "location", { ...initial, current_city: " " }).current_city,
    ).toBeTruthy();
    expect(
      validateEditDraft(record, "location", { ...initial, preferred_locations: "a, b, c, d, e, f" })
        .preferred_locations,
    ).toBeTruthy();
  });

  it("refuses a trade id that is not in the closed taxonomy shape, and more than four roles", () => {
    const trade = initialEditDraft(record, "trade");
    expect(validateEditDraft(record, "trade", { ...trade, trade: "welder" }).trade).toBeTruthy();
    expect(validateEditDraft(record, "trade", { ...trade, role: "tig" }).role).toBeTruthy();
    expect(
      validateEditDraft(record, "trade", {
        ...trade,
        secondary_roles: "role_a, role_b, role_c, role_d, role_e",
      }).secondary_roles,
    ).toBeTruthy();
  });

  it("refuses a salary upper end below its lower end, and an out-of-range notice", () => {
    const pay = initialEditDraft(record, "pay");
    expect(
      validateEditDraft(record, "pay", { ...pay, salary_min: "20000", salary_max: "10000" })
        .salary_max,
    ).toBeTruthy();
    expect(
      validateEditDraft(record, "pay", { ...pay, notice_period_days: "200" }).notice_period_days,
    ).toBeTruthy();
    expect(validateEditDraft(record, "work", { experience: "61" }).experience).toBeTruthy();
  });

  it("accepts the untouched draft and a real change", () => {
    expect(validateEditDraft(record, "location", initial)).toEqual({});
    expect(validateEditDraft(record, "location", { ...initial, current_city: "Mumbai" })).toEqual(
      {},
    );
  });
});

describe("the structured sections", () => {
  it("pre-fills skills, multi-selects and entry rows from the editable block", () => {
    expect(initialEditDraft(record, "skills")).toEqual({
      skills: "skill_tig_welder, skill_arc_welding",
    });
    const pay = initialEditDraft(record, "pay");
    expect(pay.work_types).toBe("contract");
    expect(pay.documents_ready).toBe("aadhaar, pan");
    expect(JSON.parse(initialEditDraft(record, "languages").languages!)).toEqual([
      { language: "hindi", can_speak: true, can_read: true, can_write: false },
    ]);
    expect(JSON.parse(initialEditDraft(record, "schooling").education!)).toEqual([
      {
        credential: "iti",
        field: "Welder",
        council: "ncvt",
        year: "2018",
        institute: "Govt. ITI, Faridabad",
      },
    ]);
    const history = JSON.parse(initialEditDraft(record, "history").work_history!);
    expect(history[0]).toMatchObject({
      employer_name: "",
      employer_city: "Pune",
      roles: [
        {
          role_label: "TIG Welder",
          start_ym: "2021-04",
          end_ym: "",
          work_done: "Welded exhaust frames",
        },
      ],
    });
    expect(history[0]).not.toHaveProperty("employer_name", "Tata");
    expect(JSON.stringify(history)).not.toMatch(/polish|voice_note|duration_stated/);
  });

  it("builds the correction shapes from the drafts, including nested roles", () => {
    expect(
      draftFactValue("languages", {
        languages: JSON.stringify([
          { language: "hindi", can_speak: true, can_read: false, can_write: false },
        ]),
      }),
    ).toEqual([{ language: "hindi", can_speak: true, can_read: false, can_write: false }]);
    expect(draftFactValue("work_types", { work_types: "contract, daily_wage" })).toEqual([
      "contract",
      "daily_wage",
    ]);
    const history = draftFactValue("work_history", {
      work_history: JSON.stringify([
        {
          employer_name: "Tata Motors",
          employer_city: "Pune",
          employer_state: "",
          start_ym: "2021-04",
          end_ym: "",
          roles: [{ role_label: "Welder", start_ym: "", end_ym: "", work_done: "" }],
        },
      ]),
    });
    expect(history).toEqual([
      {
        employer_name: "Tata Motors",
        employer_city: "Pune",
        employer_state: null,
        start_ym: "2021-04",
        end_ym: null,
        roles: [{ role_label: "Welder", start_ym: null, end_ym: null, work_done: null }],
      },
    ]);
  });

  it("diffs entries by value and names each changed fact once", () => {
    const initial = initialEditDraft(record, "languages");
    expect(editChanges(record, "languages", initial)).toEqual([]);
    const changed = editChanges(record, "languages", {
      languages: JSON.stringify([
        { language: "hindi", can_speak: true, can_read: true, can_write: true },
        { language: "english", can_speak: true, can_read: false, can_write: false },
      ]),
    });
    expect(changed.map((c) => c.factKey)).toEqual(["languages"]);
    expect(changed[0]!.before).toBe("Hindi (speaks, reads)");
    expect(changed[0]!.after).toBe("Hindi (speaks, reads, writes); English (speaks)");
  });

  it("formats the structured values in words", () => {
    expect(formatFactValue("skills", ["a", "b"])).toBe("a, b");
    expect(formatFactValue("work_types", ["contract"])).toBe("Contract");
    expect(formatFactValue("documents_ready", [])).toBe("—");
    expect(
      formatFactValue("work_history", [
        { employer_city: "Pune", roles: [{ role_label: "Welder" }] },
        { roles: [{}, {}] },
      ]),
    ).toBe("2 employments: Pune · Welder; 2 roles");
  });
});

describe("structured validation", () => {
  const draftFor = (section: "languages" | "schooling" | "history", formKey: string, rows: unknown[]) => ({
    ...initialEditDraft(record, section),
    [formKey]: JSON.stringify(rows),
  });

  it("refuses an unknown multi-select value and more than fifty skills", () => {
    const pay = initialEditDraft(record, "pay");
    expect(
      validateEditDraft(record, "pay", { ...pay, work_types: "contract, moonlight" }).work_types,
    ).toBeTruthy();
    expect(
      validateEditDraft(record, "skills", { skills: new Array(51).fill("skill_x").join(", ") })
        .skills,
    ).toBeTruthy();
  });

  it("refuses a stored phrase in the skills box, naming it", () => {
    expect(
      validateEditDraft(record, "skills", { skills: "skill_tig_welding, MIG Welding" }).skills,
    ).toMatch(/skill_\* id.*MIG Welding/);
  });

  it("refuses a language without abilities and a doubled language", () => {
    expect(
      validateEditDraft(
        record,
        "languages",
        draftFor("languages", "languages", [{ language: "hindi" }]),
      ).languages,
    ).toMatch(/tick/);
    expect(
      validateEditDraft(
        record,
        "languages",
        draftFor("languages", "languages", [
          { language: "hindi", can_speak: true },
          { language: "hindi", can_read: true },
        ]),
      ).languages,
    ).toMatch(/already listed/);
  });

  it("refuses a nameless certificate and a year outside living memory", () => {
    expect(
      validateEditDraft(
        record,
        "schooling",
        draftFor("schooling", "certifications", [{ name: "", issuer: "", year: "" }]),
      ).certifications,
    ).toMatch(/enter name/);
    expect(
      validateEditDraft(
        record,
        "schooling",
        draftFor("schooling", "education", [
          { credential: "iti", field: "", council: "", year: "1800", institute: "" },
        ]),
      ).education,
    ).toMatch(/between 1950/);
  });

  it("refuses a work history without an employer name, without a role, or with a backwards span", () => {
    const noName = draftFor("history", "work_history", [
      { employer_name: "", roles: [{ role_label: "Welder" }] },
    ]);
    expect(validateEditDraft(record, "history", noName).work_history).toMatch(/employer name/);
    const noRole = draftFor("history", "work_history", [
      { employer_name: "Tata", roles: [] },
    ]);
    expect(validateEditDraft(record, "history", noRole).work_history).toMatch(/at least one/);
    const backwards = draftFor("history", "work_history", [
      {
        employer_name: "Tata",
        start_ym: "2023-01",
        end_ym: "2022-01",
        roles: [{ role_label: "Welder" }],
      },
    ]);
    expect(validateEditDraft(record, "history", backwards).work_history).toMatch(
      /must not come before/,
    );
  });

  it("accepts untouched drafts, except history — the employer name is never shown, so it must be typed", () => {
    for (const section of ["skills", "languages", "schooling"] as const) {
      expect(validateEditDraft(record, section, initialEditDraft(record, section))).toEqual({});
    }
    // Untouched history flags only the unknown employer name: the API requires it, the
    // record never carries it, and saving without it is impossible — so the form says so
    // up front rather than failing at Save.
    expect(validateEditDraft(record, "history", initialEditDraft(record, "history"))).toEqual({
      work_history: "Row 1: enter employer name.",
    });
  });
});
