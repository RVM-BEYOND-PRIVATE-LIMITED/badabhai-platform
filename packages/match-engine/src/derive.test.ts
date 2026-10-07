import { describe, expect, it } from "vitest";
import { DEFAULT_MATCH_CONFIG, parseMatchConfig } from "./config";
import { deriveWorkerSkills, workerSkillDeriveInput } from "./derive";

const cfg = DEFAULT_MATCH_CONFIG;

describe("deriveWorkerSkills — the COARSE launch rule", () => {
  it("derives the match skill from the canonical role", () => {
    const rows = deriveWorkerSkills({ canonicalRoleId: "role_vmc_operator", totalYears: 4 }, cfg);
    expect(rows).toEqual([
      {
        skillId: "mskill_vmc_operator",
        industryId: "ind_industrial_manufacturing",
        monthsBucketed: 48,
        wants: true,
        startedAt: null,
        endedAt: null,
      },
    ]);
  });

  it("UNIONS the role with every match skill the attributes imply", () => {
    const rows = deriveWorkerSkills(
      {
        canonicalRoleId: "role_cnc_turner_operator",
        // turning -> cnc_turner (same as the role), milling -> vmc_operator,
        // CMM + inspection -> quality_inspector (deduped to one row).
        profileSkills: [
          "skill_turning",
          "skill_milling",
          "skill_cmm",
          "skill_dimensional_inspection",
        ],
        totalYears: 3,
      },
      cfg,
    );
    expect(rows.map((r) => r.skillId)).toEqual([
      "mskill_cnc_turner",
      "mskill_quality_inspector",
      "mskill_vmc_operator",
    ]);
  });

  it("applies ONE bucketed total identically to every derived row (the coarse rule)", () => {
    // A real limitation, stated rather than hidden: eight years total reads as eight
    // years on each derived skill, because the profile carries no per-skill duration.
    const rows = deriveWorkerSkills(
      { canonicalRoleId: "role_welder", profileSkills: ["skill_tig_welding"], totalYears: 8 },
      cfg,
    );
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.monthsBucketed).toBe(96);
  });

  it("returns [] when nothing implies a posting-level skill — never fabricates reach", () => {
    // GD&T and a micrometer make a man employable; they do not make him a vacancy.
    expect(
      deriveWorkerSkills(
        { profileSkills: ["skill_gdt_reading", "skill_measuring_instruments"], totalYears: 10 },
        cfg,
      ),
    ).toEqual([]);
    expect(deriveWorkerSkills({}, cfg)).toEqual([]);
    expect(
      deriveWorkerSkills({ canonicalRoleId: null, profileSkills: [], totalYears: 5 }, cfg),
    ).toEqual([]);
    expect(
      deriveWorkerSkills({ canonicalRoleId: "role_does_not_exist", totalYears: 5 }, cfg),
    ).toEqual([]);
  });

  it("carries the industry from the vocabulary, not from the caller", () => {
    const rows = deriveWorkerSkills({ canonicalRoleId: "role_plumber", totalYears: 1 }, cfg);
    expect(rows[0]?.industryId).toBe("ind_industrial_manufacturing");
  });

  it("defaults wants to true and leaves the stint dates null", () => {
    const rows = deriveWorkerSkills({ canonicalRoleId: "role_carpenter", totalYears: 2 }, cfg);
    expect(rows[0]?.wants).toBe(true);
    expect(rows[0]?.startedAt).toBeNull();
    expect(rows[0]?.endedAt).toBeNull();
  });

  it("unknown duration derives 0 months, not a guess", () => {
    const rows = deriveWorkerSkills(
      { canonicalRoleId: "role_vmc_operator", totalYears: null },
      cfg,
    );
    expect(rows[0]?.monthsBucketed).toBe(0);
  });

  it("is DETERMINISTIC — sorted by skillId, stable across input order", () => {
    const a = deriveWorkerSkills(
      { profileSkills: ["skill_milling", "skill_turning", "skill_arc_welding"], totalYears: 2 },
      cfg,
    );
    const b = deriveWorkerSkills(
      { profileSkills: ["skill_arc_welding", "skill_milling", "skill_turning"], totalYears: 2 },
      cfg,
    );
    expect(a).toEqual(b);
    expect(a.map((r) => r.skillId)).toEqual([...a.map((r) => r.skillId)].sort());
  });

  it("ignores non-string attribute entries instead of throwing", () => {
    const rows = deriveWorkerSkills(
      {
        profileSkills: [null as unknown as string, 7 as unknown as string, "skill_turning"],
        totalYears: 1,
      },
      cfg,
    );
    expect(rows.map((r) => r.skillId)).toEqual(["mskill_cnc_turner"]);
  });

  it("honours a different month bucket from config", () => {
    const yearly = parseMatchConfig({ monthBucket: 12 });
    const rows = deriveWorkerSkills(
      { canonicalRoleId: "role_vmc_operator", totalYears: 2.5 },
      yearly,
    );
    expect(rows[0]?.monthsBucketed).toBe(24);
  });

  it("adds a DECLARED SECONDARY role through the same bridge (Layer A (f))", () => {
    const rows = deriveWorkerSkills(
      {
        canonicalRoleId: "role_welder",
        additionalRoleIds: ["role_plumber"],
        totalYears: 3,
      },
      cfg,
    );
    expect(rows.map((r) => r.skillId)).toEqual(["mskill_mig_welder", "mskill_plumber"]);
    // The coarse rule is not special-cased for secondaries: one bucketed total on every row.
    for (const r of rows) expect(r.monthsBucketed).toBe(36);
  });

  it("secondary roles are a UNION — a duplicate of the primary adds nothing", () => {
    const rows = deriveWorkerSkills(
      {
        canonicalRoleId: "role_plumber",
        additionalRoleIds: ["role_plumber", "role_carpenter"],
        totalYears: 1,
      },
      cfg,
    );
    expect(rows.map((r) => r.skillId)).toEqual(["mskill_carpenter", "mskill_plumber"]);
  });

  it("a secondary role alone derives its bridge row, and an unknown id contributes nothing", () => {
    const rows = deriveWorkerSkills(
      { additionalRoleIds: ["role_designer", "role_invented", null as unknown as string] },
      cfg,
    );
    expect(rows.map((r) => r.skillId)).toEqual(["mskill_designer"]);
  });
});

describe("workerSkillDeriveInput — the ONE assembly both writers of worker_skill call", () => {
  const welderForm = [
    { packId: "qp_welding_trade", attributeKey: "welding_process", optionKeys: ["mig_mag", "tig"] },
  ];

  it("returns null when there is nothing to derive from (the rebuild must not prune)", () => {
    expect(
      workerSkillDeriveInput({ profile: null, secondaryRoleIds: [], packAnswers: [] }),
    ).toBeNull();
    // Answers that imply nothing are not evidence either — e.g. only the universal tail.
    expect(
      workerSkillDeriveInput({
        profile: null,
        secondaryRoleIds: [],
        packAnswers: [
          { packId: "qp_universal", attributeKey: "shift_preference", optionKeys: ["day"] },
        ],
      }),
    ).toBeNull();
  });

  it("derives a FORM-ONLY worker (no profile row) from his pack answers alone", () => {
    const input = workerSkillDeriveInput({
      profile: null,
      secondaryRoleIds: [],
      packAnswers: welderForm,
    });
    expect(input).not.toBeNull();
    expect(deriveWorkerSkills(input!).map((r) => r.skillId)).toEqual([
      "mskill_mig_welder",
      "mskill_tig_welder",
    ]);
  });

  it("UNIONS profile skills, declared occupations and pack answers — never replaces", () => {
    const input = workerSkillDeriveInput({
      profile: {
        canonicalRoleId: "role_plumber",
        profileSkills: ["skill_cmm"],
        totalYears: 4,
        sourceSession: null,
      },
      secondaryRoleIds: ["role_carpenter"],
      packAnswers: [
        ...welderForm,
        { packId: "qp_vmc_milling", attributeKey: "milling_machine", optionKeys: ["hmc"] },
      ],
    });
    expect(deriveWorkerSkills(input!).map((r) => r.skillId)).toEqual([
      "mskill_carpenter",
      "mskill_hmc_operator",
      "mskill_mig_welder",
      "mskill_plumber",
      "mskill_quality_inspector",
      "mskill_tig_welder",
    ]);
    expect(input!.totalYears).toBe(4);
  });

  it("a pack-only trade (#2022) derives its OWN skill and no nearest-skill proxy", () => {
    // An electrician is not a fitter: before #2022 this bag derived nothing; now it derives the
    // minted Industrial Electrician skill and nothing else, for a form-only worker too.
    const packAnswers = [
      {
        packId: "qp_industrial_electrician",
        attributeKey: "electrical_work_type",
        optionKeys: ["panel_wiring", "motor_drive", "cable_laying"],
      },
    ];
    for (const profile of [
      null,
      { canonicalRoleId: null, profileSkills: [], totalYears: 6, sourceSession: null },
    ]) {
      const input = workerSkillDeriveInput({ profile, secondaryRoleIds: [], packAnswers });
      expect(input).not.toBeNull();
      expect(input!.matchSkillIds).toEqual(["mskill_industrial_electrician"]);
      expect(deriveWorkerSkills(input!).map((r) => r.skillId)).toEqual([
        "mskill_industrial_electrician",
      ]);
    }
  });

  it("a manual lathe claim derives CNC Turner AND the manual machinist (#2022 point 1)", () => {
    const input = workerSkillDeriveInput({
      profile: null,
      secondaryRoleIds: [],
      packAnswers: [
        {
          packId: "qp_conventional_machining",
          attributeKey: "machining_machine",
          optionKeys: ["centre_lathe"],
        },
      ],
    });
    expect(deriveWorkerSkills(input!).map((r) => r.skillId)).toEqual([
      "mskill_cnc_turner",
      "mskill_conventional_machinist",
    ]);
  });
});

describe("workerSkillDeriveInput — a worker-only generic qp_electrical chat (#2075)", () => {
  /** The persisted `conversation_state` subset `PROFILE_SOURCE_SESSION_ANSWERS` selects. */
  function session(
    values: readonly string[],
    stamp: Record<string, unknown> = { llm_led_turns: 0, llm_draft_settled: false },
  ): Record<string, unknown> {
    return {
      pack_id: "qp_electrical",
      answer_map: [
        {
          question_key: "electrical_scope",
          target_field: "skills",
          status: "answered",
          value_normalized: values,
        },
      ],
      ...stamp,
    };
  }
  const profileWith = (sourceSession: unknown) => ({
    canonicalRoleId: null,
    profileSkills: [],
    totalYears: 3,
    sourceSession,
  });
  const derived = (sourceSession: unknown): string[] => {
    const input = workerSkillDeriveInput({
      profile: profileWith(sourceSession),
      secondaryRoleIds: [],
      packAnswers: [],
    });
    return input === null ? [] : deriveWorkerSkills(input).map((r) => r.skillId);
  };

  it("`industrial` or `panel` derives the industrial electrician, via matchSkillIds only", () => {
    for (const values of [["industrial"], ["panel"], ["industrial", "panel", "house_wiring"]]) {
      const input = workerSkillDeriveInput({
        profile: profileWith(session(values)),
        secondaryRoleIds: [],
        packAnswers: [],
      });
      expect(input!.matchSkillIds).toEqual(["mskill_industrial_electrician"]);
      // The profile's corpus column is untouched: nothing is added to `profileSkills`.
      expect(input!.profileSkills).toEqual([]);
      expect(deriveWorkerSkills(input!).map((r) => r.skillId)).toEqual([
        "mskill_industrial_electrician",
      ]);
    }
  });

  it("`house_wiring` and `motor` derive nothing (no proxy)", () => {
    expect(derived(session(["house_wiring", "motor"]))).toEqual([]);
  });

  it("fails closed: an LLM-led, LLM-settled, legacy or absent session derives nothing", () => {
    expect(
      derived(session(["industrial"], { llm_led_turns: 2, llm_draft_settled: false })),
    ).toEqual([]);
    expect(derived(session(["panel"], { llm_led_turns: 0, llm_draft_settled: true }))).toEqual([]);
    expect(derived(session(["panel"], {}))).toEqual([]);
    expect(derived(null)).toEqual([]);
    expect(derived("not an object")).toEqual([]);
  });

  it("is pack-scoped: the same answer under another pack derives nothing", () => {
    expect(derived({ ...session(["industrial", "panel"]), pack_id: "qp_painting" })).toEqual([]);
  });

  it("unions with the form's pack-only skill and dedupes", () => {
    const input = workerSkillDeriveInput({
      profile: profileWith(session(["panel"])),
      secondaryRoleIds: [],
      packAnswers: [
        {
          packId: "qp_industrial_electrician",
          attributeKey: "electrical_work_type",
          optionKeys: ["panel_wiring"],
        },
      ],
    });
    expect(input!.matchSkillIds).toEqual(["mskill_industrial_electrician"]);
  });
});

describe("deriveWorkerSkills — pack-only match skills (#2022)", () => {
  it("adds a closed-set mskill_ id and drops anything outside the vocabulary", () => {
    const rows = deriveWorkerSkills({
      matchSkillIds: ["mskill_press_operator", "mskill_not_real", "skill_turning", "role_welder"],
      totalYears: 2,
    });
    expect(rows.map((r) => r.skillId)).toEqual(["mskill_press_operator"]);
    expect(rows[0]!.industryId).toBe("ind_industrial_manufacturing");
  });
});
