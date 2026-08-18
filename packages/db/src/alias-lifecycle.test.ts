import { describe, expect, it } from "vitest";

import {
  ALIAS_TABLE_SPECS,
  JOB_DOMAIN_ALIAS_SPEC,
  SKILL_ALIAS_SPEC,
  aliasFetchSql,
  aliasState,
  computeElection,
  parentFetchSql,
  toLifecycleAlias,
  toLifecycleParent,
  verifyElection,
  type LifecycleAliasRow,
  type LifecycleParentRow,
} from "./alias-lifecycle";

const alias = (o: Partial<LifecycleAliasRow> & { id: string }): LifecycleAliasRow => ({
  parentId: "p1",
  text: "welding",
  textNorm: "welding",
  lang: "en",
  hasEmbedding: true,
  isSearchable: false,
  ...o,
});

/** An eligible, unshadowed job_domain. */
const domain = (o: Partial<LifecycleParentRow> & { id: string }): LifecycleParentRow => ({
  status: "active",
  selectable: true,
  source: "nco",
  hasSelectableActiveChild: false,
  ...o,
});

const skill = (o: Partial<LifecycleParentRow> & { id: string }): LifecycleParentRow => ({
  status: "active",
  ...o,
});

const elected = (input: Parameters<typeof computeElection>[0]): string[] =>
  computeElection(input).filter((r) => r.elected).map((r) => r.id);

describe("election — reason 1: parent eligibility", () => {
  it("domains: a non-selectable parent elects nothing", () => {
    // Bucket rows organize the tree; nobody holds one as a job.
    const r = computeElection({
      spec: JOB_DOMAIN_ALIAS_SPEC,
      aliases: [alias({ id: "a" })],
      parents: [domain({ id: "p1", selectable: false })],
    });
    expect(r[0]?.elected).toBe(false);
    expect(r[0]?.reasons).toContain("parent_ineligible");
  });

  it("domains: an inactive parent elects nothing", () => {
    expect(
      elected({
        spec: JOB_DOMAIN_ALIAS_SPEC,
        aliases: [alias({ id: "a" })],
        parents: [domain({ id: "p1", status: "deprecated" })],
      }),
    ).toEqual([]);
  });

  it("skills: PROVISIONAL parents stay elected", () => {
    // Deliberate. Retrieval filters s.status='active' in its own WHERE, so a provisional
    // skill is already unreachable. De-electing here would make promotion a SECOND corpus
    // mutation, with a window where a freshly promoted skill is active and invisible.
    expect(
      elected({
        spec: SKILL_ALIAS_SPEC,
        aliases: [alias({ id: "a" })],
        parents: [skill({ id: "p1", status: "provisional" })],
      }),
    ).toEqual(["a"]);
  });

  it("skills: a DEPRECATED parent elects nothing", () => {
    expect(
      elected({
        spec: SKILL_ALIAS_SPEC,
        aliases: [alias({ id: "a" })],
        parents: [skill({ id: "p1", status: "deprecated" })],
      }),
    ).toEqual([]);
  });

  it("a missing parent is reported as such, not silently elected", () => {
    const r = computeElection({
      spec: SKILL_ALIAS_SPEC,
      aliases: [alias({ id: "a", parentId: "ghost" })],
      parents: [],
    });
    expect(r[0]?.elected).toBe(false);
    expect(r[0]?.reasons).toContain("parent_missing");
  });
});

describe("election — reason 2: parent shadowing", () => {
  it("domains: an isco08 unit WITH a selectable active child is shadowed", () => {
    // The F4 fix: "Welders and Flame Cutters" must not compete with 44 specific NCO
    // welding occupations. Measured in production: 3,989 aliases sit here.
    const r = computeElection({
      spec: JOB_DOMAIN_ALIAS_SPEC,
      aliases: [alias({ id: "a" })],
      parents: [domain({ id: "p1", source: "isco08", hasSelectableActiveChild: true })],
    });
    expect(r[0]?.elected).toBe(false);
    expect(r[0]?.reasons).toContain("parent_shadowed");
  });

  it("domains: an UNSHADOWED isco08 unit stays elected — the unit IS the leaf", () => {
    expect(
      elected({
        spec: JOB_DOMAIN_ALIAS_SPEC,
        aliases: [alias({ id: "a" })],
        parents: [domain({ id: "p1", source: "isco08", hasSelectableActiveChild: false })],
      }),
    ).toEqual(["a"]);
  });

  it("domains: a NON-isco08 parent with children is not shadowed", () => {
    expect(
      elected({
        spec: JOB_DOMAIN_ALIAS_SPEC,
        aliases: [alias({ id: "a" })],
        parents: [domain({ id: "p1", source: "nco", hasSelectableActiveChild: true })],
      }),
    ).toEqual(["a"]);
  });

  it("skills: shadowing is a STATED no-op, and never fires", () => {
    // The point of the unified engine. An omitted rule reads identically to a forgotten
    // one — which is how the two runners drifted apart. This asserts the rule EXISTS on the
    // skill spec and evaluates false, rather than being absent from the skill path.
    expect(SKILL_ALIAS_SPEC.parentShadowed).toBeTypeOf("function");
    expect(SKILL_ALIAS_SPEC.parentShadowed(skill({ id: "p1" }))).toBe(false);
    expect(
      SKILL_ALIAS_SPEC.parentShadowed({
        id: "p1",
        status: "active",
        source: "isco08",
        hasSelectableActiveChild: true,
      }),
    ).toBe(false);
    expect(SKILL_ALIAS_SPEC.shadowingNote).toMatch(/no-op/);
  });

  it("every spec implements all four reasons", () => {
    for (const spec of ALIAS_TABLE_SPECS) {
      expect(spec.parentEligible, spec.table).toBeTypeOf("function");
      expect(spec.parentShadowed, spec.table).toBeTypeOf("function");
      expect(spec.shadowingNote.length, spec.table).toBeGreaterThan(0);
    }
  });
});

describe("election — reason 3: group representative", () => {
  it("elects exactly one row per (parent, text_norm, lang)", () => {
    const r = elected({
      spec: SKILL_ALIAS_SPEC,
      aliases: [
        alias({ id: "long", text: "kharad ka kaam", textNorm: "kharad", lang: "hi" }),
        alias({ id: "short", text: "kharad", textNorm: "kharad", lang: "hi" }),
      ],
      parents: [skill({ id: "p1" })],
    });
    expect(r).toEqual(["short"]);
  });

  it("prefers an EMBEDDED row over a shorter unembedded one — never strand paid work", () => {
    expect(
      elected({
        spec: SKILL_ALIAS_SPEC,
        aliases: [
          alias({ id: "short-noembed", text: "abc", hasEmbedding: false }),
          alias({ id: "long-embedded", text: "abcdefghij", hasEmbedding: true }),
        ],
        parents: [skill({ id: "p1" })],
      }),
    ).toEqual(["long-embedded"]);
  });

  it("breaks a total tie by lowest id, deterministically", () => {
    const rows = [alias({ id: "b" }), alias({ id: "a" })];
    expect(elected({ spec: SKILL_ALIAS_SPEC, aliases: rows, parents: [skill({ id: "p1" })] })).toEqual(["a"]);
    // Input order must not matter.
    expect(elected({ spec: SKILL_ALIAS_SPEC, aliases: [...rows].reverse(), parents: [skill({ id: "p1" })] })).toEqual(["a"]);
  });

  it("measures length in CODE POINTS, matching Postgres length()", () => {
    // Devanagari is BMP so JS .length agrees today; this pins the behaviour before a
    // non-BMP alias makes the engine disagree with the SQL it mirrors.
    expect(
      elected({
        spec: SKILL_ALIAS_SPEC,
        aliases: [alias({ id: "dev", text: "वेल्डिंग" }), alias({ id: "long", text: "welding work now" })],
        parents: [skill({ id: "p1" })],
      }),
    ).toEqual(["dev"]);
  });

  it("groups are scoped by parent AND lang", () => {
    const r = elected({
      spec: SKILL_ALIAS_SPEC,
      aliases: [
        alias({ id: "en", lang: "en" }),
        alias({ id: "hi", lang: "hi" }),
        alias({ id: "other-parent", parentId: "p2" }),
      ],
      parents: [skill({ id: "p1" }), skill({ id: "p2" })],
    });
    expect(r.sort()).toEqual(["en", "hi", "other-parent"]);
  });

  it("treats NULL lang as equal (NULLS NOT DISTINCT) but not equal to the string 'null'", () => {
    expect(
      elected({
        spec: SKILL_ALIAS_SPEC,
        aliases: [alias({ id: "a", lang: null }), alias({ id: "b", lang: null })],
        parents: [skill({ id: "p1" })],
      }),
    ).toEqual(["a"]);
    expect(
      elected({
        spec: SKILL_ALIAS_SPEC,
        aliases: [alias({ id: "a", lang: null }), alias({ id: "b", lang: "null" })],
        parents: [skill({ id: "p1" })],
      }).sort(),
    ).toEqual(["a", "b"]);
  });

  it("RANKS OVER ALL NORMALIZED ROWS, then ANDs eligibility — mirroring the SQL", () => {
    // ORDER IS LOAD-BEARING. Production computes row_number() in a CTE over every
    // normalized row and applies `eligible AND rn = 1` afterwards. If eligibility filtered
    // the ranking instead, a group whose best row has an ineligible parent would elect a
    // DIFFERENT winner — and verifyElection against production would report thousands of
    // false mismatches. Two rows, same group, different parents: the short one's parent is
    // ineligible, so the group's winner is ineligible and NOBODY is elected.
    const r = computeElection({
      spec: JOB_DOMAIN_ALIAS_SPEC,
      aliases: [
        alias({ id: "short", parentId: "bad", text: "abc" }),
        alias({ id: "long", parentId: "bad", text: "abcdefgh" }),
      ],
      parents: [domain({ id: "bad", selectable: false })],
    });
    expect(r.filter((x) => x.elected)).toEqual([]);
    expect(r.find((x) => x.id === "short")?.reasons).toEqual(["parent_ineligible"]);
    // The loser carries BOTH reasons — every applicable one, not just the first.
    expect(r.find((x) => x.id === "long")?.reasons).toEqual([
      "parent_ineligible",
      "not_group_representative",
    ]);
  });
});

describe("election — reason 4: recorded demotion", () => {
  it("demotes only the named row, and says why", () => {
    const r = computeElection({
      spec: SKILL_ALIAS_SPEC,
      aliases: [alias({ id: "fitting" }), alias({ id: "other", textNorm: "bench fitting" })],
      parents: [skill({ id: "p1" })],
      demotions: new Set(["fitting"]),
    });
    expect(r.find((x) => x.id === "fitting")?.elected).toBe(false);
    expect(r.find((x) => x.id === "fitting")?.reasons).toEqual(["recorded_demotion"]);
    expect(r.find((x) => x.id === "other")?.elected).toBe(true);
  });

  it("is never inferred — an absent register demotes nothing", () => {
    expect(
      elected({ spec: SKILL_ALIAS_SPEC, aliases: [alias({ id: "a" })], parents: [skill({ id: "p1" })] }),
    ).toEqual(["a"]);
  });

  it("does not promote the runner-up when the winner is demoted", () => {
    // Demotion removes a row from retrieval; it does not re-run the election. Promoting the
    // loser would silently resurrect the very surface form a human just retired.
    const r = elected({
      spec: SKILL_ALIAS_SPEC,
      aliases: [alias({ id: "winner", text: "abc" }), alias({ id: "loser", text: "abcdef" })],
      parents: [skill({ id: "p1" })],
      demotions: new Set(["winner"]),
    });
    expect(r).toEqual([]);
  });
});

describe("election — normalization gate", () => {
  it("an un-normalized row is never elected and has no group", () => {
    const r = computeElection({
      spec: SKILL_ALIAS_SPEC,
      aliases: [alias({ id: "a", textNorm: null })],
      parents: [skill({ id: "p1" })],
    });
    expect(r[0]).toEqual({ id: "a", elected: false, reasons: ["not_normalized"], winnerId: null });
  });

  it("un-normalized rows do not participate in another row's group", () => {
    expect(
      elected({
        spec: SKILL_ALIAS_SPEC,
        aliases: [alias({ id: "raw", text: "a", textNorm: null }), alias({ id: "norm", text: "zzzz" })],
        parents: [skill({ id: "p1" })],
      }),
    ).toEqual(["norm"]);
  });
});

describe("aliasState", () => {
  it("maps columns onto the lifecycle", () => {
    expect(aliasState(alias({ id: "a", textNorm: null }), true)).toBe("raw");
    expect(aliasState(alias({ id: "a", isSearchable: false }), true)).toBe("normalized");
    expect(aliasState(alias({ id: "a", isSearchable: true, hasEmbedding: false }), true)).toBe("elected");
    expect(aliasState(alias({ id: "a", isSearchable: true, hasEmbedding: true }), false)).toBe("embedded");
    expect(aliasState(alias({ id: "a", isSearchable: true, hasEmbedding: true }), true)).toBe("retrievable");
  });
});

describe("verifyElection", () => {
  const parents = [skill({ id: "p1" })];

  it("is clean when stored matches the rule", () => {
    const r = verifyElection({
      spec: SKILL_ALIAS_SPEC,
      aliases: [alias({ id: "a", isSearchable: true })],
      parents,
    });
    expect(r.clean).toBe(true);
    expect(r.mismatches).toEqual([]);
    expect(r.storedElected).toBe(1);
    expect(r.expectedElected).toBe(1);
  });

  it("reports a row the rule says should NOT be searchable", () => {
    const r = verifyElection({
      spec: SKILL_ALIAS_SPEC,
      aliases: [
        alias({ id: "winner", text: "abc", isSearchable: true }),
        alias({ id: "loser", text: "abcdef", isSearchable: true }),
      ],
      parents,
    });
    expect(r.clean).toBe(false);
    expect(r.mismatches.map((m) => m.id)).toEqual(["loser"]);
    expect(r.mismatches[0]?.reasons).toContain("not_group_representative");
  });

  it("reports a row the rule says SHOULD be searchable but is not (the never-ran case)", () => {
    // This is the live skill_alias condition in production: 98 rows, 0 searchable.
    const r = verifyElection({
      spec: SKILL_ALIAS_SPEC,
      aliases: [alias({ id: "a", isSearchable: false })],
      parents,
    });
    expect(r.mismatches).toEqual([
      { id: "a", stored: false, expected: true, reasons: [] },
    ]);
  });

  it("tallies every not-elected reason", () => {
    const r = verifyElection({
      spec: JOB_DOMAIN_ALIAS_SPEC,
      aliases: [
        alias({ id: "s1", parentId: "shadow" }),
        alias({ id: "s2", parentId: "shadow", text: "zzzzzzz" }),
        alias({ id: "r", parentId: "raw", textNorm: null }),
      ],
      parents: [
        domain({ id: "shadow", source: "isco08", hasSelectableActiveChild: true }),
        domain({ id: "raw" }),
      ],
    });
    expect(r.reasonHistogram.parent_shadowed).toBe(2);
    expect(r.reasonHistogram.not_group_representative).toBe(1);
    expect(r.reasonHistogram.not_normalized).toBe(1);
  });

  describe("invariants", () => {
    const inv = (r: ReturnType<typeof verifyElection>, name: string) =>
      r.invariants.find((i) => i.name === name);

    it("catches a searchable row with no text_norm", () => {
      const r = verifyElection({
        spec: SKILL_ALIAS_SPEC,
        aliases: [alias({ id: "a", textNorm: null, isSearchable: true })],
        parents,
      });
      expect(inv(r, "normalized_before_elected")?.passed).toBe(false);
      expect(inv(r, "normalized_before_elected")?.sample).toEqual(["a"]);
    });

    it("catches two searchable rows in one group — a violated UNIQUE index", () => {
      const r = verifyElection({
        spec: SKILL_ALIAS_SPEC,
        aliases: [alias({ id: "a", isSearchable: true }), alias({ id: "b", isSearchable: true })],
        parents,
      });
      expect(inv(r, "one_winner_per_group")?.violations).toBe(2);
    });

    it("catches a searchable row with no vector", () => {
      const r = verifyElection({
        spec: SKILL_ALIAS_SPEC,
        aliases: [alias({ id: "a", isSearchable: true, hasEmbedding: false })],
        parents,
      });
      expect(inv(r, "searchable_is_embedded")?.passed).toBe(false);
    });

    it("catches a searchable row on a missing or ineligible parent", () => {
      const missing = verifyElection({
        spec: SKILL_ALIAS_SPEC,
        aliases: [alias({ id: "a", parentId: "ghost", isSearchable: true })],
        parents,
      });
      expect(inv(missing, "searchable_parent_exists")?.passed).toBe(false);

      const shadowed = verifyElection({
        spec: JOB_DOMAIN_ALIAS_SPEC,
        aliases: [alias({ id: "a", isSearchable: true })],
        parents: [domain({ id: "p1", source: "isco08", hasSelectableActiveChild: true })],
      });
      expect(inv(shadowed, "searchable_parent_eligible")?.passed).toBe(false);
    });

    it("catches an empty text_norm", () => {
      const r = verifyElection({
        spec: SKILL_ALIAS_SPEC,
        aliases: [alias({ id: "a", textNorm: "" })],
        parents,
      });
      expect(inv(r, "no_empty_text_norm")?.passed).toBe(false);
    });

    it("passes all six on a healthy table", () => {
      const r = verifyElection({
        spec: SKILL_ALIAS_SPEC,
        aliases: [alias({ id: "a", isSearchable: true }), alias({ id: "b", textNorm: "milling" , isSearchable: true })],
        parents,
      });
      expect(r.invariants).toHaveLength(6);
      expect(r.invariants.every((i) => i.passed)).toBe(true);
      expect(r.clean).toBe(true);
    });
  });
});

describe("read-only SQL", () => {
  it("emits SELECT-only statements for both tables", () => {
    for (const spec of ALIAS_TABLE_SPECS) {
      for (const q of [aliasFetchSql(spec), parentFetchSql(spec)]) {
        const text = JSON.stringify(q);
        expect(text, spec.table).not.toMatch(/UPDATE|INSERT|DELETE|TRUNCATE|ALTER|DROP/i);
        expect(text, spec.table).toMatch(/SELECT/);
      }
    }
  });

  it("selects the right parent columns per table", () => {
    expect(JSON.stringify(parentFetchSql(JOB_DOMAIN_ALIAS_SPEC))).toMatch(/has_selectable_active_child/);
    // Skills have no shadow test to precompute — the no-op needs no column.
    expect(JSON.stringify(parentFetchSql(SKILL_ALIAS_SPEC))).not.toMatch(/has_selectable_active_child/);
  });
});

describe("row coercion", () => {
  it("coerces driver rows without inventing values", () => {
    const a = toLifecycleAlias({
      id: 1, parent_id: "p", text: "x", text_norm: null, lang: null,
      has_embedding: false, is_searchable: false,
    });
    expect(a).toEqual({
      id: "1", parentId: "p", text: "x", textNorm: null, lang: null,
      hasEmbedding: false, isSearchable: false,
    });
    const p = toLifecycleParent({ id: "p", status: "active" });
    expect(p.selectable).toBeUndefined();
    expect(p.hasSelectableActiveChild).toBeUndefined();
  });

  it("treats only literal true as true — a driver string must not pass", () => {
    expect(toLifecycleAlias({ id: "a", parent_id: "p", is_searchable: "t" }).isSearchable).toBe(false);
    expect(toLifecycleAlias({ id: "a", parent_id: "p", is_searchable: true }).isSearchable).toBe(true);
  });
});
