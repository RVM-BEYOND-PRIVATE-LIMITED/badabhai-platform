/**
 * THE WIRE CONTRACT, as tests rather than as a docblock.
 *
 * `admin-skill-discovery.dto.ts` is the whole agreement between this service and
 * `apps/admin-web`: the frontend issue (#1260) tells Frontend Platform to MIRROR these types
 * rather than re-derive shapes from sample JSON. That makes every bound, every `.strict()` and
 * every refusal in this file a promise to another team — and a promise nothing was checking.
 *
 * The DTO's runtime behaviour was verified once, by a throwaway probe suite that was run and then
 * DELETED. That is a verification with a half-life: it proved the schemas behaved on the day they
 * were written and left nothing behind to notice when they stopped. These assertions are that
 * probe suite made permanent, plus the cases it did not cover.
 *
 * WHAT IS DELIBERATELY NOT HERE. Authorization (`admin-skill-discovery.authz.test.ts`), service
 * behaviour (`.service.test.ts`), the provenance round trip (`.provenance.test.ts`) and the write
 * surface (`taxonomy-write-surface.test.ts`). This file is only about what the PIPE accepts and
 * refuses, because that is the layer a client actually programs against.
 */
import { describe, expect, it } from "vitest";

import { MATCH_SKILLS } from "@badabhai/taxonomy";

import {
  ADMIN_SKILL_APPROVED_DOMAINS_MAX,
  ADMIN_SKILL_DISCOVERY_PAGE_DEFAULT,
  ADMIN_SKILL_DISCOVERY_PAGE_MAX,
  ADMIN_SKILL_DISCOVERY_SORT_DEFAULT,
  ADMIN_SKILL_PHRASE_PREFIX_MAX,
  ADMIN_SKILL_PROPOSED_LABEL_MAX,
  ADMIN_SKILL_REVIEW_DECISIONS,
  ADMIN_SKILL_REVIEW_REASON_MIN,
  AdminSkillDecisionSchema,
  AdminSkillDiscoveryMetricsQuerySchema,
  AdminSkillDiscoveryParamsSchema,
  AdminSkillDiscoveryQuerySchema,
  SKILL_CANDIDATE_STATUSES,
  SKILL_DECISION_TO_LIBRARY_DECISION,
  SKILL_MATCH_RELATION_LABELS,
  SKILL_MATCH_STRENGTH_LABELS,
  SKILL_PHRASE_CLASS_LABELS,
  ADMIN_SKILL_MATCH_RELATIONS,
  ADMIN_SKILL_MATCH_STRENGTHS,
  ADMIN_SKILL_PHRASE_CLASSES,
} from "./admin-skill-discovery.dto";

/** A valid decision body minus the branch-specific fields. */
const BASE = {
  expected_status: "needs_review" as const,
  review_reason: "names a concrete competency, not an occupation",
};

const CREATE = {
  decision: "create" as const,
  ...BASE,
  proposed_skill_name: "Shuttering Erection",
  approved_job_domain_ids: ["jd_carpenter"],
};

// ═══════════════════════════════════════════════════════════════════════════════════════════
// The queue query
// ═══════════════════════════════════════════════════════════════════════════════════════════

describe("GET /admin/skill-discovery — the query contract", () => {
  it("defaults the page size and the sort, and a client may send neither", () => {
    const out = AdminSkillDiscoveryQuerySchema.parse({});
    expect(out.limit).toBe(ADMIN_SKILL_DISCOVERY_PAGE_DEFAULT);
    expect(out.sort).toBe(ADMIN_SKILL_DISCOVERY_SORT_DEFAULT);
  });

  it("has NO server-side default status — absent means unfiltered", () => {
    // A hidden default is how a screen ends up claiming to show a queue while showing a filtered
    // subset of it. The console sends the two undecided statuses explicitly, so the URL says what
    // the screen shows.
    expect(AdminSkillDiscoveryQuerySchema.parse({}).status).toBeUndefined();
  });

  it("bounds the page size, and coerces the string a query string actually delivers", () => {
    expect(AdminSkillDiscoveryQuerySchema.parse({ limit: "25" }).limit).toBe(25);
    expect(AdminSkillDiscoveryQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(AdminSkillDiscoveryQuerySchema.safeParse({ limit: -1 }).success).toBe(false);
    expect(AdminSkillDiscoveryQuerySchema.safeParse({ limit: 2.5 }).success).toBe(false);
    expect(
      AdminSkillDiscoveryQuerySchema.safeParse({ limit: ADMIN_SKILL_DISCOVERY_PAGE_MAX }).success,
    ).toBe(true);
    expect(
      AdminSkillDiscoveryQuerySchema.safeParse({ limit: ADMIN_SKILL_DISCOVERY_PAGE_MAX + 1 })
        .success,
    ).toBe(false);
  });

  it("takes status as ONE value or MANY — the undecided view is two statuses, not one", () => {
    // With a single-valued filter the console would have to make two requests and paste the pages
    // together, which breaks keyset paging outright: two cursors over two result sets cannot be
    // merged into one honest `nextCursor`.
    expect(AdminSkillDiscoveryQuerySchema.parse({ status: "pending" }).status).toEqual(["pending"]);
    expect(
      AdminSkillDiscoveryQuerySchema.parse({ status: ["pending", "needs_review"] }).status,
    ).toEqual(["pending", "needs_review"]);
  });

  it("refuses an unknown status rather than ignoring it", () => {
    expect(AdminSkillDiscoveryQuerySchema.safeParse({ status: "approved" }).success).toBe(false);
    expect(
      AdminSkillDiscoveryQuerySchema.safeParse({ status: ["pending", "nonsense"] }).success,
    ).toBe(false);
  });

  it("accepts every status the ladder actually has", () => {
    for (const status of SKILL_CANDIDATE_STATUSES) {
      expect(AdminSkillDiscoveryQuerySchema.safeParse({ status }).success).toBe(true);
    }
  });

  it("a typo'd filter is a 400, not a silently unfiltered page", () => {
    // `.strict()`. Dropping an unknown key would serve an unfiltered list under a URL that claims
    // otherwise — a wrong answer that looks like a right one.
    expect(AdminSkillDiscoveryQuerySchema.safeParse({ teir: "direct" }).success).toBe(false);
    expect(AdminSkillDiscoveryQuerySchema.safeParse({ tier: "direct" }).success).toBe(true);
    expect(AdminSkillDiscoveryQuerySchema.safeParse({ statuses: ["pending"] }).success).toBe(false);
  });

  it("normalizes `phrase` to a trimmed lowercase prefix, and bounds it", () => {
    expect(AdminSkillDiscoveryQuerySchema.parse({ phrase: "  Arc Welding " }).phrase).toBe(
      "arc welding",
    );
    expect(
      AdminSkillDiscoveryQuerySchema.safeParse({ phrase: "x".repeat(ADMIN_SKILL_PHRASE_PREFIX_MAX) })
        .success,
    ).toBe(true);
    expect(
      AdminSkillDiscoveryQuerySchema.safeParse({
        phrase: "x".repeat(ADMIN_SKILL_PHRASE_PREFIX_MAX + 1),
      }).success,
    ).toBe(false);
  });

  it("keeps a vernacular phrase intact — lowercasing must not mangle Devanagari", () => {
    // The corpus this queue serves is 1.1% activity phrases and a real share of them are Hindi.
    // `toLowerCase()` is a no-op on a unicase script, and this asserts it stays one.
    expect(AdminSkillDiscoveryQuerySchema.parse({ phrase: "शटरिंग" }).phrase).toBe("शटरिंग");
    expect(AdminSkillDiscoveryQuerySchema.parse({ phrase: " वेल्डिंग " }).phrase).toBe("वेल्डिंग");
  });

  it("coerces the created_at range the way a query string delivers it", () => {
    const out = AdminSkillDiscoveryQuerySchema.parse({
      createdFrom: "2026-08-26T00:00:00.000Z",
      createdTo: "2026-08-27T00:00:00.000Z",
    });
    expect(out.createdFrom).toBeInstanceOf(Date);
    expect(out.createdTo?.toISOString()).toBe("2026-08-27T00:00:00.000Z");
  });

  it("has NO decided-by filter — that is an audit question the spine already answers", () => {
    // So this surface cannot be turned into a per-reviewer performance report by URL.
    expect(AdminSkillDiscoveryQuerySchema.safeParse({ reviewerAdminId: "x" }).success).toBe(false);
    expect(AdminSkillDiscoveryQuerySchema.safeParse({ decidedBy: "x" }).success).toBe(false);
    expect(AdminSkillDiscoveryQuerySchema.safeParse({ reviewedFrom: "2026-01-01" }).success).toBe(
      false,
    );
  });

  it("`runId` is NOT a uuid rule — run ids are text and a uuid rule would reject every one", () => {
    expect(
      AdminSkillDiscoveryQuerySchema.safeParse({ runId: "sdr_20260826-123559Z_phase5" }).success,
    ).toBe(true);
  });
});

describe("the two other request schemas", () => {
  it("the :id param IS a uuid, because the column is one", () => {
    // A non-uuid can only fail at BIND with Postgres 22P02, which arrives as a 500. A 400 says
    // what actually happened.
    expect(
      AdminSkillDiscoveryParamsSchema.safeParse({ id: "11111111-1111-4111-8111-111111111111" })
        .success,
    ).toBe(true);
    expect(AdminSkillDiscoveryParamsSchema.safeParse({ id: "metrics" }).success).toBe(false);
    expect(AdminSkillDiscoveryParamsSchema.safeParse({ id: "not-a-uuid" }).success).toBe(false);
  });

  it("the metrics query takes an optional run and NOTHING else — a backlog has no window", () => {
    // A 30-day window on a backlog hides the oldest undecided candidates, which are precisely the
    // rows the tile exists to make visible.
    expect(AdminSkillDiscoveryMetricsQuerySchema.safeParse({}).success).toBe(true);
    expect(AdminSkillDiscoveryMetricsQuerySchema.safeParse({ runId: "sdr_x" }).success).toBe(true);
    expect(AdminSkillDiscoveryMetricsQuerySchema.safeParse({ windowDays: 30 }).success).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// The decision body
// ═══════════════════════════════════════════════════════════════════════════════════════════

describe("POST .../decision — the five branches, and what each one refuses", () => {
  it("every reviewer-facing decision word parses", () => {
    for (const decision of ADMIN_SKILL_REVIEW_DECISIONS) {
      const body =
        decision === "create"
          ? CREATE
          : decision === "alias" || decision === "merge"
            ? { decision, ...BASE, resulting_skill_id: "skill_arc_welding" }
            : { decision, ...BASE };
      expect(AdminSkillDecisionSchema.safeParse(body).success, decision).toBe(true);
    }
  });

  it("refuses the LADDER's words at the wire — the API and the screen must agree", () => {
    // The button says "add as alias" and the ladder says `approved_map`. A route that accepted
    // `map` would make the API and the screen disagree about what the reviewer just did.
    for (const word of ["map", "defer", "approved_create", "approved_map"]) {
      expect(
        AdminSkillDecisionSchema.safeParse({ decision: word, ...BASE }).success,
        word,
      ).toBe(false);
    }
  });

  it("translates each button to exactly one library decision, and nothing else", () => {
    expect(SKILL_DECISION_TO_LIBRARY_DECISION).toEqual({
      create: "create",
      alias: "map",
      merge: "merge",
      reject: "reject",
      hold: "defer",
    });
    // A Record over the union, so a sixth button cannot be added without translating it.
    expect(Object.keys(SKILL_DECISION_TO_LIBRARY_DECISION).sort()).toEqual(
      [...ADMIN_SKILL_REVIEW_DECISIONS].sort(),
    );
  });

  it("`create` REQUIRES a label and at least one trade", () => {
    // `.min(1)` mirrors `skill_candidate_create_domain_chk`, and the reason is SKILL_ORPHAN:
    // "it seeds, it embeds, and it is invisible".
    const { proposed_skill_name: _n, ...noLabel } = CREATE;
    expect(AdminSkillDecisionSchema.safeParse(noLabel).success).toBe(false);
    const { approved_job_domain_ids: _d, ...noDomains } = CREATE;
    expect(AdminSkillDecisionSchema.safeParse(noDomains).success).toBe(false);
    expect(
      AdminSkillDecisionSchema.safeParse({ ...CREATE, approved_job_domain_ids: [] }).success,
    ).toBe(false);
  });

  it("`create` defaults the requirement to `preferred`, the conservative claim", () => {
    // `required` is a strong claim about hiring and a newly discovered skill has no evidence
    // behind it yet. A reviewer who knows better says so; the default never overstates for them.
    const parsed = AdminSkillDecisionSchema.parse(CREATE);
    expect(parsed).toMatchObject({ approved_requirement: "preferred" });
    expect(
      AdminSkillDecisionSchema.parse({ ...CREATE, approved_requirement: "required" }),
    ).toMatchObject({ approved_requirement: "required" });
  });

  it("`create` REFUSES resulting_skill_id — invariant 6, expressed as a type", () => {
    // The column stays NULL until the offline chain mints the skill and the backfill runner
    // stamps it. A request field for it would be the exact shortcut this surface refuses.
    expect(
      AdminSkillDecisionSchema.safeParse({ ...CREATE, resulting_skill_id: "skill_arc_welding" })
        .success,
    ).toBe(false);
  });

  it("`alias` and `merge` REQUIRE a target and refuse a label", () => {
    for (const decision of ["alias", "merge"] as const) {
      expect(AdminSkillDecisionSchema.safeParse({ decision, ...BASE }).success, decision).toBe(
        false,
      );
      expect(
        AdminSkillDecisionSchema.safeParse({
          decision,
          ...BASE,
          resulting_skill_id: "skill_arc_welding",
          proposed_skill_name: "Arc Welding",
        }).success,
        decision,
      ).toBe(false);
    }
  });

  it("`reject` and `hold` accept NEITHER a target nor a label", () => {
    // A rejection that names a resulting skill is not a rejection.
    for (const decision of ["reject", "hold"] as const) {
      expect(AdminSkillDecisionSchema.safeParse({ decision, ...BASE }).success, decision).toBe(
        true,
      );
      expect(
        AdminSkillDecisionSchema.safeParse({
          decision,
          ...BASE,
          resulting_skill_id: "skill_arc_welding",
        }).success,
        decision,
      ).toBe(false);
      expect(
        AdminSkillDecisionSchema.safeParse({ decision, ...BASE, proposed_skill_name: "X" }).success,
        decision,
      ).toBe(false);
    }
  });

  it("bounds the proposed label", () => {
    expect(
      AdminSkillDecisionSchema.safeParse({ ...CREATE, proposed_skill_name: "A" }).success,
    ).toBe(false);
    expect(
      AdminSkillDecisionSchema.safeParse({
        ...CREATE,
        proposed_skill_name: "x".repeat(ADMIN_SKILL_PROPOSED_LABEL_MAX + 1),
      }).success,
    ).toBe(false);
  });

  it("bounds the approved trade list", () => {
    expect(
      AdminSkillDecisionSchema.safeParse({
        ...CREATE,
        approved_job_domain_ids: Array.from(
          { length: ADMIN_SKILL_APPROVED_DOMAINS_MAX + 1 },
          (_, i) => `jd_${i}`,
        ),
      }).success,
    ).toBe(false);
  });
});

describe("the reason is mandatory on every branch, and whitespace cannot buy it", () => {
  it("refuses a reason below the floor", () => {
    expect(
      AdminSkillDecisionSchema.safeParse({ ...CREATE, review_reason: "too short" }).success,
    ).toBe(false);
  });

  it("refuses a reason padded to the floor with spaces", () => {
    // The sharp case. `validateCandidate` rejects a whitespace-only reason as
    // DECISION_WITHOUT_REVIEWER, so a blank reason is not a decision even though it satisfies
    // NOT NULL — and a schema that counted the padding would let one through.
    expect(
      AdminSkillDecisionSchema.safeParse({
        ...CREATE,
        review_reason: " ".repeat(ADMIN_SKILL_REVIEW_REASON_MIN + 5),
      }).success,
    ).toBe(false);
    expect(
      AdminSkillDecisionSchema.safeParse({ ...CREATE, review_reason: "  ok  " }).success,
    ).toBe(false);
  });

  it("requires one on `reject`, which is the decision most likely to need explaining", () => {
    const { review_reason: _r, ...noReason } = BASE;
    expect(AdminSkillDecisionSchema.safeParse({ decision: "reject", ...noReason }).success).toBe(
      false,
    );
  });

  it("neither the reviewer nor the moment may be sent — they come from the session", () => {
    // An actor a caller can type is not an actor, and this row is the audit trail for a taxonomy
    // decision that outlives everyone in it.
    for (const extra of [
      { reviewer_admin_id: "22222222-2222-4222-8222-222222222222" },
      { reviewed_at: "2026-08-26T13:00:00.000Z" },
      { candidate_id: "11111111-1111-4111-8111-111111111111" },
    ]) {
      expect(AdminSkillDecisionSchema.safeParse({ ...CREATE, ...extra }).success).toBe(false);
    }
  });
});

describe("the mskill_* wall, at the pipe", () => {
  it("refuses the prefix in any casing", () => {
    for (const id of ["mskill_arc_welding", "MSKILL_ARC_WELDING", "MsKiLl_arc_welding"]) {
      expect(
        AdminSkillDecisionSchema.safeParse({
          decision: "alias",
          ...BASE,
          resulting_skill_id: id,
        }).success,
        id,
      ).toBe(false);
    }
  });

  it("refuses EVERY member of the closed 18, by membership and not only by prefix", () => {
    // The two halves are different guarantees: the prefix mirrors the DB CHECKs, and set
    // membership mirrors `validateCandidate` — which would still catch a match skill renamed out
    // of the prefix convention.
    expect(MATCH_SKILLS.length).toBeGreaterThan(0);
    for (const skill of MATCH_SKILLS) {
      expect(
        AdminSkillDecisionSchema.safeParse({
          decision: "merge",
          ...BASE,
          resulting_skill_id: skill.skillId,
        }).success,
        skill.skillId,
      ).toBe(false);
    }
  });

  it("refuses the `skill_mskill_` form a match-skill LABEL would mint", () => {
    expect(
      AdminSkillDecisionSchema.safeParse({
        decision: "alias",
        ...BASE,
        resulting_skill_id: "skill_mskill_welding",
      }).success,
    ).toBe(false);
  });

  it("still accepts an ordinary corpus id — the wall is not just a refusal of everything", () => {
    expect(
      AdminSkillDecisionSchema.safeParse({
        decision: "alias",
        ...BASE,
        resulting_skill_id: "skill_arc_welding",
      }).success,
    ).toBe(true);
  });

  it("is a CHARSET rule, not a uuid rule — `skill.skill_id` is `skill_<slug>` text", () => {
    // A uuid rule would reject every legal value, since `taxonomySkillIdFor` produces
    // `skill_arc_welding`. So the pipe bounds the CHARACTER SET and nothing more, and a uuid
    // happens to satisfy it — which is fine and is worth stating rather than asserting away:
    // whether a well-formed id NAMES A REAL SKILL is not a question a schema can answer. The
    // service answers it, with `findCorpusSkill`, which also checks the skill is not deprecated
    // and not `kind = 'match_skill'` — the fact the `mskill_` prefix is only a proxy for.
    expect(
      AdminSkillDecisionSchema.safeParse({
        decision: "alias",
        ...BASE,
        resulting_skill_id: "11111111-1111-4111-8111-111111111111",
      }).success,
    ).toBe(true);
  });

  it("the charset still refuses what a charset is FOR — the rule is not decorative", () => {
    // Without these the previous assertion would read as "anything goes". A skill id reaches a
    // `text` primary key, so the shapes worth refusing are the ones that are not identifiers at
    // all.
    for (const junk of [
      "skill arc welding",
      "skill_arc_welding; DROP TABLE skill",
      "skill_arc_welding'",
      "skill/arc",
      "",
      "   ",
      "x".repeat(129),
    ]) {
      expect(
        AdminSkillDecisionSchema.safeParse({
          decision: "alias",
          ...BASE,
          resulting_skill_id: junk,
        }).success,
        JSON.stringify(junk),
      ).toBe(false);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// The display maps — the "no reviewer needs to know cosine" layer
// ═══════════════════════════════════════════════════════════════════════════════════════════

describe("the plain-language maps are total, and say nothing numeric", () => {
  it("every relation, strength and phrase class has a sentence", () => {
    // Exhaustive by construction, so an unlabelled member is a compile error rather than a blank
    // cell on a review screen. Asserted at runtime too, because the frontend reads these maps.
    for (const relation of ADMIN_SKILL_MATCH_RELATIONS) {
      expect(SKILL_MATCH_RELATION_LABELS[relation], relation).toBeTruthy();
    }
    for (const strength of ADMIN_SKILL_MATCH_STRENGTHS) {
      expect(SKILL_MATCH_STRENGTH_LABELS[strength], strength).toBeTruthy();
    }
    for (const phraseClass of ADMIN_SKILL_PHRASE_CLASSES) {
      expect(SKILL_PHRASE_CLASS_LABELS[phraseClass], phraseClass).toBeTruthy();
    }
  });

  it("no label leaks a score, a threshold or a model name", () => {
    // The whole point of serving a relation and a sentence instead of a number is that a reviewer
    // never learns "0.9 is fine" — which would recreate an approval floor with no owner ruling
    // behind it. A label that quoted one would put the number back on the screen by the side door.
    const all = [
      ...Object.values(SKILL_MATCH_RELATION_LABELS),
      ...Object.values(SKILL_MATCH_STRENGTH_LABELS),
      ...Object.values(SKILL_PHRASE_CLASS_LABELS),
    ];
    for (const label of all) {
      expect(label, label).not.toMatch(/\b0\.\d+\b/);
      expect(label.toLowerCase(), label).not.toContain("cosine");
      expect(label.toLowerCase(), label).not.toContain("embedding");
      expect(label.toLowerCase(), label).not.toContain("gemini");
      expect(label.toLowerCase(), label).not.toContain("threshold");
    }
  });
});
