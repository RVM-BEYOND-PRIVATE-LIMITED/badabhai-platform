import { describe, expect, it } from "vitest";
import { labelForTaxonomyId, ROLES } from "@badabhai/taxonomy";
import {
  AVAILABILITY_STATUSES,
  DOCUMENTS_READY,
  EDUCATION_COUNCILS,
  EDUCATION_QUALIFICATIONS,
  JOB_TYPES,
  LANGUAGES,
  SHIFTS,
  type PreferenceVocabulary,
} from "../../profiles/worker-preferences.vocabulary";
import { storedEducationField, storedEmployerName } from "../../profiles/title-case-on-write";
import { EditProposalRowSchema } from "../chat-companion.dto";
import { EDIT_ENTRY_LABELS, EDIT_FIELD_LABELS, EDIT_YES_NO_LABELS } from "../companion-replies";
import {
  cardFieldLabel,
  displayValue,
  EDIT_CATALOGUE,
  isWholeJobDelete,
  normaliseValue,
  opAllowed,
} from "./edit-catalogue";

/**
 * BUG-CARD-LABELS / POLISH-language-slugs — every card row names its field, and every closed-set
 * value it carries has the label the profile screens and the résumé already print.
 */

/** The token-valued fields and the dictionary each one's values are drawn from. */
const VOCABULARY_FIELDS: ReadonlyArray<
  readonly [section: string, field: string, vocabulary: PreferenceVocabulary]
> = [
  ["languages", "language", LANGUAGES],
  ["qualifications", "education_credential", EDUCATION_QUALIFICATIONS],
  ["qualifications", "education_council", EDUCATION_COUNCILS],
  ["preferences", "shift", SHIFTS],
  ["preferences", "job_type", JOB_TYPES],
  ["preferences", "work_types", JOB_TYPES],
  ["preferences", "availability_status", AVAILABILITY_STATUSES],
  ["preferences", "documents_ready", DOCUMENTS_READY],
];

const YES_NO_FIELDS = ["willing_to_travel", "willing_to_relocate", "accommodation_needed"] as const;

/** Every closed-set field: the vocabulary fields, the three yes/no scalars and the role ids. */
const CLOSED_SET_KEYS = new Set([
  ...VOCABULARY_FIELDS.map(([section, field]) => `${section}:${field}`),
  ...YES_NO_FIELDS.map((field) => `preferences:${field}`),
  "occupations:role_id",
]);

/** The fields whose value is the worker's own words, a date or a number — never relabelled. */
const FREE_TEXT = EDIT_CATALOGUE.filter((e) => !CLOSED_SET_KEYS.has(`${e.section}:${e.field}`));

/** The bounds the wire enforces — a label past them would fail the turn's own schema. */
const FIELD_LABEL_MAX = EditProposalRowSchema.shape.field_label.unwrap().maxLength ?? 0;
const DISPLAY_MAX = EditProposalRowSchema.shape.before_display.unwrap().unwrap().maxLength ?? 0;

describe("every catalogue field has a worker-facing field label", () => {
  it.each(EDIT_CATALOGUE.map((e) => [`${e.section}:${e.field}`, e] as const))(
    "%s has a label that fits the wire",
    (_key, entry) => {
      const label = cardFieldLabel(entry.section, entry.field, "edit");
      expect(label).not.toBeNull();
      expect(label!.length).toBeGreaterThan(0);
      expect(label!.length).toBeLessThanOrEqual(FIELD_LABEL_MAX);
    },
  );

  it("labels no field the catalogue does not hold (no orphan copy)", () => {
    const catalogue = new Set(EDIT_CATALOGUE.map((e) => `${e.section}:${e.field}`));
    expect(Object.keys(EDIT_FIELD_LABELS).filter((key) => !catalogue.has(key))).toEqual([]);
  });

  it("two fields of one section never share a label — the card can tell them apart", () => {
    const seen = new Map<string, string>();
    for (const entry of EDIT_CATALOGUE) {
      const label = `${entry.section}|${cardFieldLabel(entry.section, entry.field, "edit")}`;
      expect(seen.get(label), `${entry.field} repeats ${seen.get(label)}'s label`).toBeUndefined();
      seen.set(label, entry.field);
    }
  });

  it("an unknown or absent field has no label, and a prototype name is not one", () => {
    expect(cardFieldLabel("preferences", "salary_period", "edit")).toBeNull();
    expect(cardFieldLabel("preferences", "constructor", "edit")).toBeNull();
    expect(cardFieldLabel("preferences", null, "edit")).toBeNull();
  });
});

describe("the legal ops per section ('Never from chat', owner ruling 2026-10-01)", () => {
  const opsOf = (section: string) =>
    EDIT_CATALOGUE.filter((e) => e.section === section).map((e) => [e.field, [...e.ops]] as const);

  it("every employment field is EDIT-only — chat never deletes (or adds) a whole job", () => {
    expect(opsOf("employment")).toEqual(
      ["employer_name", "employer_city", "employer_state", "start_ym", "end_ym", "role_label", "work_done"].map(
        (field) => [field, ["edit"]],
      ),
    );
  });

  it("every other section is unchanged: qualifications edit/delete, the member lists add/delete", () => {
    for (const [, ops] of opsOf("qualifications")) expect(ops).toEqual(["edit", "delete"]);
    for (const section of ["skills", "languages", "occupations"]) {
      for (const [, ops] of opsOf(section)) expect(ops).toEqual(["add", "delete"]);
    }
    const PREFERENCE_SCALARS = [
      "shift",
      "job_type",
      "willing_to_travel",
      "willing_to_relocate",
      "accommodation_needed",
      "expected_salary",
      "availability_status",
      "availability_available_from",
      "availability_notice_period_days",
    ];
    const PREFERENCE_LISTS = ["preferred_cities", "work_types", "documents_ready"];
    expect(opsOf("preferences")).toEqual([
      ...PREFERENCE_SCALARS.map((field) => [field, ["edit"]]),
      ...PREFERENCE_LISTS.map((field) => [field, ["add", "delete"]]),
    ]);
  });

  it("isWholeJobDelete is exactly (employment, delete) — whatever field, and for untrusted input", () => {
    expect(isWholeJobDelete({ section: "employment", op: "delete" })).toBe(true);
    expect(isWholeJobDelete({ section: "employment", op: "edit" })).toBe(false);
    expect(isWholeJobDelete({ section: "employment", op: "add" })).toBe(false);
    expect(isWholeJobDelete({ section: "occupations", op: "delete" })).toBe(false);
    expect(isWholeJobDelete({ section: "qualifications", op: "delete" })).toBe(false);
    expect(isWholeJobDelete({ section: "Employment", op: "delete" })).toBe(false);
  });

  it("no catalogue entry lets an employment delete through opAllowed", () => {
    for (const entry of EDIT_CATALOGUE) {
      if (entry.section === "employment") expect(opAllowed(entry, "delete")).toBe(false);
    }
  });
});

describe("a whole-entry delete names the ENTRY, never its anchor field", () => {
  // A qualification delete removes the whole entry; the field is only the anchor the model
  // pointed at. "Certificate ka saal — Hatayenge: 2018" would read as clearing a year.
  const EMPLOYMENT_TARGET = { employment_id: "66666666-6666-4666-8666-666666666666" };
  const target = (list: string) => ({ list, index: 0, fp: "0123456789abcdef" });

  it.each([
    // A whole-JOB delete is never proposed any more; the label stays for a card stored before
    // the 2026-10-01 ruling, which may still be served on a retry (and is never applied).
    ["employment", "start_ym", EMPLOYMENT_TARGET, EDIT_ENTRY_LABELS.employment.latin],
    ["employment", "employer_name", EMPLOYMENT_TARGET, EDIT_ENTRY_LABELS.employment.latin],
    ["qualifications", "certificate_year", target("certificates"), EDIT_ENTRY_LABELS.certificate.latin],
    ["qualifications", "education_council", target("educations"), EDIT_ENTRY_LABELS.education.latin],
    ["qualifications", "training_provider", target("trainings"), EDIT_ENTRY_LABELS.training.latin],
  ] as const)("%s:%s delete → %j", (section, field, rowTarget, expected) => {
    expect(cardFieldLabel(section, field, "delete", rowTarget)).toBe(expected);
    expect(cardFieldLabel(section, field, "edit", rowTarget)).not.toBe(expected);
  });

  it("the entry kind is the TARGET's list — the entry removed — never the anchor field's (EDIT-ROW-KIND)", () => {
    // A certificate field anchored on an education: the apply removes the education, so the card
    // must say so rather than "Yeh poora certificate".
    expect(cardFieldLabel("qualifications", "certificate_name", "delete", target("educations"))).toBe(
      EDIT_ENTRY_LABELS.education.latin,
    );
    expect(cardFieldLabel("qualifications", "education_year", "delete", target("trainings"))).toBe(
      EDIT_ENTRY_LABELS.training.latin,
    );
  });

  it("a qualification delete with no list on its target has NO label — never a field's, never a guess", () => {
    expect(cardFieldLabel("qualifications", "certificate_name", "delete")).toBeNull();
    expect(cardFieldLabel("qualifications", "certificate_name", "delete", target("licences"))).toBeNull();
  });

  it("a member delete (language, skill, role, a list preference) keeps the field's label", () => {
    expect(cardFieldLabel("languages", "language", "delete")).toBe(
      EDIT_FIELD_LABELS["languages:language"]!.latin,
    );
    expect(cardFieldLabel("skills", "skill", "delete")).toBe(
      EDIT_FIELD_LABELS["skills:skill"]!.latin,
    );
    expect(cardFieldLabel("occupations", "role_id", "delete")).toBe(
      EDIT_FIELD_LABELS["occupations:role_id"]!.latin,
    );
    expect(cardFieldLabel("preferences", "documents_ready", "delete")).toBe(
      EDIT_FIELD_LABELS["preferences:documents_ready"]!.latin,
    );
  });
});

describe("every closed-set value the card can carry maps to its display label", () => {
  const cases = VOCABULARY_FIELDS.flatMap(([section, field, vocabulary]) =>
    Object.entries(vocabulary).map(
      ([slug, label]) => [`${section}:${field}`, slug, label, section, field] as const,
    ),
  );

  it.each(cases)("%s %s → %j (the dictionary's own label)", (_key, slug, label, section, field) => {
    // The value normalises to itself — i.e. the card can really carry it — and it is labelled.
    expect(normaliseValue(section as never, field, slug)).toBe(slug);
    expect(displayValue(section as never, field, slug)).toBe(label);
    expect(label.length).toBeLessThanOrEqual(DISPLAY_MAX);
  });

  it.each(ROLES.map((role) => [role.id] as const))(
    "occupations:role_id %s → its taxonomy label",
    (id) => {
      expect(displayValue("occupations", "role_id", id)).toBe(labelForTaxonomyId(id));
      expect(displayValue("occupations", "role_id", id)).not.toBe(id);
      expect(labelForTaxonomyId(id).length).toBeLessThanOrEqual(DISPLAY_MAX);
    },
  );

  it.each(YES_NO_FIELDS.map((field) => [field] as const))(
    "preferences:%s true/false → Haan/Nahi",
    (field) => {
      expect(displayValue("preferences", field, "true")).toBe(EDIT_YES_NO_LABELS.true.latin);
      expect(displayValue("preferences", field, "false")).toBe(EDIT_YES_NO_LABELS.false.latin);
      expect(EDIT_YES_NO_LABELS.true.latin).toBe("Haan");
      expect(EDIT_YES_NO_LABELS.false.latin).toBe("Nahi");
    },
  );

  it("the audit's leaks read properly now", () => {
    expect(displayValue("languages", "language", "hindi")).toBe("Hindi");
    expect(displayValue("qualifications", "education_council", "cbse")).toBe("CBSE");
    expect(displayValue("preferences", "documents_ready", "pan")).toBe("PAN");
    expect(displayValue("preferences", "documents_ready", "uan_pf")).toBe("UAN / PF");
    expect(displayValue("preferences", "availability_status", "immediate")).toBe("Immediately");
    expect(displayValue("qualifications", "education_credential", "class_10")).toBe("10th pass");
  });
});

describe("a value that is not a known token has NO display label — the app shows it as stored", () => {
  it.each(FREE_TEXT.map((e) => [`${e.section}:${e.field}`, e] as const))(
    "%s (free text, a date or a number) → null, even for a slug-shaped word",
    (_key, entry) => {
      // A worker's own "iti" in a certificate name, "hindi" as a skill, "pan" as an institute:
      // a free-text field is never relabelled, whatever the word happens to look like.
      for (const value of [
        "Tata Motors",
        "2019-01",
        "15000",
        "iti",
        "hindi",
        "pan",
        "true",
        "night",
      ]) {
        expect(displayValue(entry.section, entry.field, value)).toBeNull();
      }
    },
  );

  it("a closed-set field holding a value its dictionary does not know → null, never a guess", () => {
    // A legacy model-written availability status, a retired slug, a prototype member.
    expect(displayValue("preferences", "availability_status", "2 hafte baad")).toBeNull();
    expect(displayValue("languages", "language", "klingon")).toBeNull();
    expect(displayValue("languages", "language", "constructor")).toBeNull();
    expect(displayValue("preferences", "willing_to_travel", "maybe")).toBeNull();
    expect(displayValue("occupations", "role_id", "role_not_in_taxonomy")).toBeNull();
  });

  it("no value (an add's before, a delete's after) → null", () => {
    expect(displayValue("languages", "language", null)).toBeNull();
    expect(displayValue("preferences", null, "true")).toBeNull();
  });
});

describe("an employer name and an education field normalise to the casing their writer stores (#1940)", () => {
  // The writers case these two before they store them (`profiles/title-case-on-write.ts`), so the
  // card's `after` must be that casing too: otherwise a card shows "tata motors", stores "Tata
  // Motors", and an edit that changes nothing gets past the no-op drop.
  it.each([
    ["employment", "employer_name", "  tata motors pvt ltd ", "Tata Motors Pvt Ltd"],
    ["employment", "employer_name", "mCA institute", "MCA Institute"],
    ["qualifications", "education_field", "mechanical engineering", "Mechanical Engineering"],
  ] as const)("%s:%s %j → %j", (section, field, raw, stored) => {
    expect(normaliseValue(section, field, raw)).toBe(stored);
  });

  it.each([
    ["employment", "employer_name", "RVM CAD"],
    ["employment", "employer_name", "L&T Construction"],
    ["qualifications", "education_field", "B.Tech (ECE)"],
    ["qualifications", "education_field", "CNC Programming"],
  ] as const)(
    "%s:%s %j is byte-identical — already cased, and nothing is lowercased",
    (section, field, raw) => {
      expect(normaliseValue(section, field, raw)).toBe(raw);
    },
  );

  it("is the WRITERS' function, not a lookalike: the card and the store cannot drift apart", () => {
    for (const raw of [
      "sandhar technologies",
      " a\u0085b ",
      "आईटीआई faridabad",
      "ßauer works",
      "x",
    ]) {
      expect(normaliseValue("employment", "employer_name", raw)).toBe(
        storedEmployerName(raw.trim()),
      );
      expect(normaliseValue("qualifications", "education_field", raw)).toBe(
        storedEducationField(raw.trim()),
      );
    }
  });

  it("keeps the length bounds: casing never lengthens a value, so 120 and 80 still pass and one more does not", () => {
    expect(normaliseValue("employment", "employer_name", "a".repeat(120))).toBe(
      `A${"a".repeat(119)}`,
    );
    expect(normaliseValue("employment", "employer_name", "a".repeat(121))).toBeNull();
    expect(normaliseValue("qualifications", "education_field", "a".repeat(80))).toBe(
      `A${"a".repeat(79)}`,
    );
    expect(normaliseValue("qualifications", "education_field", "a".repeat(81))).toBeNull();
    expect(normaliseValue("employment", "employer_name", "   ")).toBeNull();
  });

  it("does NOT case the role label: 'cnc turner' → 'Cnc Turner' is an open owner decision", () => {
    expect(normaliseValue("employment", "role_label", "cnc turner")).toBe("cnc turner");
  });

  it.each([
    ["employment", "employer_city"],
    ["employment", "employer_state"],
    ["employment", "work_done"],
    ["qualifications", "certificate_name"],
    ["qualifications", "certificate_issuer"],
    ["qualifications", "education_institute"],
    ["qualifications", "training_name"],
    ["qualifications", "training_provider"],
  ] as const)("leaves %s:%s as typed — only the two written fields are cased", (section, field) => {
    expect(normaliseValue(section, field, "govt iti pune")).toBe("govt iti pune");
  });
});
