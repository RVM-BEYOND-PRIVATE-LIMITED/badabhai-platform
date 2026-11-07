import { describe, expect, it } from "vitest";
import { candidateCorrectionValues, candidateRecord } from "../../test/candidate-record";
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
  it("cover every correctable fact, simple and structured", () => {
    expect(EDIT_SECTIONS.map((s) => s.id)).toEqual([
      "location",
      "trade",
      "work",
      "skills",
      "work-history",
      "education",
      "certifications",
      "training",
      "languages",
      "work-types",
      "documents",
      "pay",
    ]);
    const keys = new Set(EDIT_SECTIONS.flatMap((s) => s.fields.map((f) => f.factKey)));
    for (const fact of [
      "skills",
      "work_history",
      "education",
      "certifications",
      "training",
      "languages",
      "work_types",
      "documents_ready",
    ]) {
      expect(keys.has(fact), fact).toBe(true);
    }
  });

  it("never include a locked field", () => {
    const keys = new Set(EDIT_SECTIONS.flatMap((s) => s.fields.map((f) => f.factKey)));
    for (const locked of ["full_name", "phone_e164", "whatsapp_enc", "resume_show_photo"]) {
      expect(keys.has(locked)).toBe(false);
    }
    expect(UNEDITABLE_FACT_KEYS).toEqual([]);
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

// ---------------------------------------------------------------------------
// #2728 — the eight structured facts
// ---------------------------------------------------------------------------

const structured = candidateRecord({ correction_values: candidateCorrectionValues() });

describe("#2728 — the structured draft", () => {
  it("serializes the correction_values block into each section's draft", () => {
    expect(JSON.parse(initialEditDraft(structured, "skills").skills ?? "")).toEqual([
      "skill_mig_welding",
      "skill_arc_welding",
    ]);
    expect(JSON.parse(initialEditDraft(structured, "work-history").work_history ?? "")).toEqual(
      structured.correction_values?.work_history,
    );
    expect(JSON.parse(initialEditDraft(structured, "education").education ?? "")).toEqual(
      structured.correction_values?.education,
    );
    expect(JSON.parse(initialEditDraft(structured, "certifications").certifications ?? "")).toEqual(
      structured.correction_values?.certifications,
    );
    expect(JSON.parse(initialEditDraft(structured, "training").training ?? "")).toEqual(
      structured.correction_values?.training,
    );
    expect(JSON.parse(initialEditDraft(structured, "languages").languages ?? "")).toEqual(
      structured.correction_values?.languages,
    );
    expect(JSON.parse(initialEditDraft(structured, "work-types").work_types ?? "")).toEqual([
      "contract",
    ]);
    expect(JSON.parse(initialEditDraft(structured, "documents").documents_ready ?? "")).toEqual([
      "aadhaar",
      "pan",
    ]);
  });

  it("is empty, never invented, when an older API sends no correction_values", () => {
    expect(initialEditDraft(record, "skills").skills).toBe("[]");
    expect(JSON.parse(initialEditDraft(record, "work-history").work_history ?? "")).toEqual({
      employments: [],
    });
  });

  it("draftFactValue emits the API's exact shapes", () => {
    expect(draftFactValue("skills", initialEditDraft(structured, "skills"))).toEqual([
      "skill_mig_welding",
      "skill_arc_welding",
    ]);
    expect(draftFactValue("work_types", initialEditDraft(structured, "work-types"))).toEqual([
      "contract",
    ]);
    expect(draftFactValue("documents_ready", initialEditDraft(structured, "documents"))).toEqual([
      "aadhaar",
      "pan",
    ]);
    expect(draftFactValue("languages", initialEditDraft(structured, "languages"))).toEqual([
      { language: "hindi", can_speak: true, can_read: true, can_write: false },
    ]);
  });

  it("work history ALWAYS emits voice-note ids as null, even from a stored row that has one", () => {
    const value = draftFactValue("work_history", {
      work_history: JSON.stringify({
        employments: [
          {
            employer_name: "Tata Motors",
            employer_city: "Pune",
            employer_state: null,
            start_ym: "2021-04",
            end_ym: null,
            role_label: "Welder",
            work_done: "Frames",
            work_done_voice_note_id: "note-1",
          },
          {
            employer_name: "Ashok Leyland",
            employer_city: null,
            employer_state: null,
            start_ym: "2019-01",
            end_ym: "2021-03",
            roles: [
              {
                role_label: "Fitter",
                start_ym: "2019-01",
                end_ym: "2020-01",
                work_done: null,
                work_done_voice_note_id: "note-2",
              },
            ],
          },
        ],
      }),
    }) as {
      employments: {
        role_label?: string;
        work_done_voice_note_id?: string | null;
        roles?: { work_done_voice_note_id?: string | null }[];
      }[];
    };
    expect(value.employments[0]?.work_done_voice_note_id).toBeNull();
    expect(value.employments[1]?.roles?.[0]?.work_done_voice_note_id).toBeNull();
  });

  it("the review diff is empty on the untouched structured draft and names the fact when changed", () => {
    const initial = initialEditDraft(structured, "skills");
    expect(editChanges(structured, "skills", initial)).toEqual([]);

    const changed = editChanges(structured, "skills", {
      ...initial,
      skills: JSON.stringify(["skill_mig_welding"]),
    });
    expect(changed.map((c) => c.factKey)).toEqual(["skills"]);
    expect(changed[0]?.before).toContain("skill_arc_welding");
    expect(changed[0]?.after).toBe("skill_mig_welding");
  });

  it("formats work history, education, languages and the closed lists as words", () => {
    expect(formatFactValue("work_history", structured.correction_values?.work_history)).toContain(
      "Tata Motors",
    );
    expect(formatFactValue("education", structured.correction_values?.education)).toContain("ITI");
    expect(
      formatFactValue("certifications", structured.correction_values?.certifications),
    ).toContain("NCVT Welder");
    expect(formatFactValue("training", structured.correction_values?.training)).toContain(
      "MIG course",
    );
    expect(formatFactValue("languages", structured.correction_values?.languages)).toBe(
      "Hindi (speak, read)",
    );
    expect(formatFactValue("work_types", ["contract"])).toBe("Contract");
    expect(formatFactValue("documents_ready", ["aadhaar", "pan"])).toBe("Aadhaar, PAN");
  });
});

describe("#2728 — the structured API bounds", () => {
  const ok = (rows: unknown) => JSON.stringify(rows);

  it("caps skills at 50", () => {
    const fifty = Array.from({ length: 50 }, (_, i) => `skill_${i}`);
    expect(validateEditDraft(structured, "skills", { skills: ok(fifty) })).toEqual({});
    expect(
      validateEditDraft(structured, "skills", { skills: ok([...fifty, "skill_50"]) }).skills,
    ).toContain("50");
  });

  it("work history: max four, a role list, YYYY-MM dates, end >= start, no voice notes", () => {
    const employment = (over: Record<string, unknown> = {}) => ({
      employer_name: "Tata Motors",
      employer_city: "Pune",
      employer_state: null,
      start_ym: "2021-04",
      end_ym: null,
      roles: [
        {
          role_label: "Welder",
          start_ym: "2021-04",
          end_ym: null,
          work_done: null,
          work_done_voice_note_id: null,
        },
      ],
      ...over,
    });
    const valid = ok({ employments: [employment()] });
    expect(validateEditDraft(structured, "work-history", { work_history: valid })).toEqual({});
    expect(
      validateEditDraft(structured, "work-history", {
        work_history: ok({
          employments: [employment(), employment(), employment(), employment(), employment()],
        }),
      }).work_history,
    ).toContain("four");
    expect(
      validateEditDraft(structured, "work-history", {
        work_history: ok({ employments: [employment({ start_ym: "2022-01", end_ym: "2021-01" })] }),
      }).work_history,
    ).toContain("before start");
    expect(
      validateEditDraft(structured, "work-history", {
        work_history: ok({ employments: [employment({ start_ym: "2021-4" })] }),
      }).work_history,
    ).toContain("YYYY-MM");
    expect(
      validateEditDraft(structured, "work-history", {
        work_history: ok({ employments: [employment({ roles: [] })] }),
      }).work_history,
    ).toContain("at least one role");
    expect(
      validateEditDraft(structured, "work-history", {
        work_history: ok({ employments: [employment({ role_label: "Welder" })] }),
      }).work_history,
    ).toContain("either one role or a list");
    expect(
      validateEditDraft(structured, "work-history", {
        work_history: ok({
          employments: [employment({ work_done_voice_note_id: "note-1" })],
        }),
      }).work_history,
    ).toContain("voice note");
  });

  it("education: max four, at least one field, listed slugs", () => {
    const entry = {
      credential: "iti",
      field: "Machinist",
      council: "ncvt",
      year: 2018,
      institute: "Govt. ITI",
    };
    expect(
      validateEditDraft(structured, "education", { education: ok([entry, entry, entry, entry]) }),
    ).toEqual({});
    expect(
      validateEditDraft(structured, "education", {
        education: ok([entry, entry, entry, entry, entry]),
      }).education,
    ).toContain("four");
    expect(
      validateEditDraft(structured, "education", {
        education: ok([
          { credential: null, field: null, council: null, year: null, institute: null },
        ]),
      }).education,
    ).toContain("at least one");
    expect(
      validateEditDraft(structured, "education", {
        education: ok([{ ...entry, credential: "not_a_credential" }]),
      }).education,
    ).toContain("listed credential");
    expect(
      validateEditDraft(structured, "education", {
        education: ok([{ ...entry, year: 2099 }]),
      }).education,
    ).toContain("1950");
  });

  it("certifications: max eight, licence charset, expiry date", () => {
    const entry = {
      name: "NCVT Welder",
      issuer: null,
      year: 2018,
      licence_number: "MH-123",
      licence_expiry: "2030-01-01",
    };
    expect(
      validateEditDraft(structured, "certifications", { certifications: ok([entry]) }),
    ).toEqual({});
    expect(
      validateEditDraft(structured, "certifications", {
        certifications: ok(Array.from({ length: 9 }, () => entry)),
      }).certifications,
    ).toContain("eight");
    expect(
      validateEditDraft(structured, "certifications", {
        certifications: ok([{ ...entry, licence_number: "a@b.com" }]),
      }).certifications,
    ).toContain("letters");
    expect(
      validateEditDraft(structured, "certifications", {
        certifications: ok([{ ...entry, licence_expiry: "01-01-2030" }]),
      }).certifications,
    ).toContain("YYYY-MM-DD");
  });

  it("training: max eight and a listed year", () => {
    const entry = { name: "MIG course", provider: null, year: 2019 };
    expect(validateEditDraft(structured, "training", { training: ok([entry]) })).toEqual({});
    expect(
      validateEditDraft(structured, "training", {
        training: ok(Array.from({ length: 9 }, () => entry)),
      }).training,
    ).toContain("eight");
    expect(
      validateEditDraft(structured, "training", { training: ok([{ ...entry, year: 1800 }]) })
        .training,
    ).toContain("1950");
  });

  it("languages: max sixteen, no duplicates, at least one ability", () => {
    const entry = { language: "hindi", can_speak: true, can_read: false, can_write: false };
    expect(validateEditDraft(structured, "languages", { languages: ok([entry]) })).toEqual({});
    expect(
      validateEditDraft(structured, "languages", {
        languages: ok([entry, entry]),
      }).languages,
    ).toContain("only once");
    expect(
      validateEditDraft(structured, "languages", {
        languages: ok([{ language: "hindi", can_speak: false, can_read: false, can_write: false }]),
      }).languages,
    ).toContain("at least one ability");
    expect(
      validateEditDraft(structured, "languages", {
        languages: ok(
          Array.from({ length: 17 }, (_, i) => ({
            language: `language_${i}`,
            can_speak: true,
            can_read: false,
            can_write: false,
          })),
        ),
      }).languages,
    ).toContain("sixteen");
  });

  it("work types max four and documents max eight, both from their closed sets", () => {
    expect(
      validateEditDraft(structured, "work-types", {
        work_types: ok(["permanent", "contract", "apprentice", "daily_wage"]),
      }),
    ).toEqual({});
    expect(
      validateEditDraft(structured, "work-types", {
        work_types: ok(["permanent", "contract", "apprentice", "daily_wage", "permanent"]),
      }).work_types,
    ).toContain("four");
    expect(
      validateEditDraft(structured, "work-types", { work_types: ok(["freelance"]) }).work_types,
    ).toContain("listed");
    expect(
      validateEditDraft(structured, "documents", {
        documents_ready: ok(Array.from({ length: 9 }, () => "aadhaar")),
      }).documents_ready,
    ).toContain("eight");
  });
});
