import { describe, expect, it } from "vitest";

import { resolveReachSet } from "@badabhai/match-engine";
import { ROLE_TO_MATCH_SKILL, isMatchSkillId } from "@badabhai/taxonomy";
import { TRADE_FORM_KINDS_ALL } from "@badabhai/types";
import { workerVisibleTextScreens } from "@badabhai/validators";

import {
  DEFAULT_DEMO_PLAN,
  DEMO_PERSONAS,
  DEMO_TRADES,
  MAX_DEMO_PERSONAS,
  DEMO_PHONE_PATTERN,
  RESERVED_TEST_PHONE_PATTERN,
  buildDemoPlan,
  demoIdLikePattern,
  demoPhone,
  demoUuid,
  personaExpectation,
  workerVisibleFields,
} from "./demo-matching-plan";
import {
  parseAllowPhones,
  personaConsentPurposes,
  resetPhoneProblem,
  targetDeclarationProblem,
  tradeReportRows,
} from "./seed-demo-matching";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The publish rule with related skills on (the shipped default). */
function withReach(plan: ReturnType<typeof buildDemoPlan>) {
  return plan.postings.map((p) => ({
    postingId: p.postingId,
    matchSkillIds: p.matchSkillIds,
    reachSkillIds: [
      ...resolveReachSet({ postedSkillIds: p.matchSkillIds, relatedDefault: "on", untickedIds: [] })
        .reachSkillIds,
    ],
  }));
}

describe("demo-matching plan — determinism and ids", () => {
  it("same options → byte-identical plan", () => {
    expect(JSON.stringify(buildDemoPlan(DEFAULT_DEMO_PLAN))).toBe(
      JSON.stringify(buildDemoPlan(DEFAULT_DEMO_PLAN)),
    );
  });

  it("a different seed → a different plan", () => {
    const a = buildDemoPlan({ ...DEFAULT_DEMO_PLAN, rngSeed: 1 });
    const b = buildDemoPlan({ ...DEFAULT_DEMO_PLAN, rngSeed: 2 });
    expect(JSON.stringify(a.postings)).not.toBe(JSON.stringify(b.postings));
  });

  it("every id is a v4-shaped uuid in its kind's namespace, and unique", () => {
    const plan = buildDemoPlan();
    const like = (kind: Parameters<typeof demoIdLikePattern>[0]) =>
      new RegExp(`^${demoIdLikePattern(kind).replace("%", ".*")}$`);
    const ids = [
      ...plan.payers.map((p) => [p.payerId, "payer"] as const),
      ...plan.personas.flatMap((p) => [
        [p.workerId, "worker"] as const,
        [p.profileId, "profile"] as const,
        [p.consentId, "consent"] as const,
      ]),
      ...plan.postings.map((p) => [p.postingId, "posting"] as const),
    ];
    for (const [id, kind] of ids) {
      expect(id).toMatch(UUID_V4);
      expect(id).toMatch(like(kind));
    }
    expect(new Set(ids.map(([id]) => id)).size).toBe(ids.length);
    expect(demoUuid("worker", 0)).not.toMatch(like("posting"));
  });

  it("phones are inside the reserved test-login range, distinct, and never collide with E4's", () => {
    const phones = buildDemoPlan().personas.map((p) => p.phoneE164);
    for (const ph of phones) {
      expect(ph).toMatch(RESERVED_TEST_PHONE_PATTERN);
      expect(ph).toMatch(DEMO_PHONE_PATTERN);
    }
    expect(new Set(phones).size).toBe(phones.length);
    expect(phones).not.toContain("+910000019844");
    expect(() => demoPhone(999)).toThrow();
  });
});

describe("demo-matching plan — catalogue", () => {
  it("covers every one of the 21 declared role kinds, with valid match skills", () => {
    const kinds = new Set(DEMO_TRADES.map((t) => t.roleKind));
    expect([...kinds].sort()).toEqual([...TRADE_FORM_KINDS_ALL].sort());
    for (const t of DEMO_TRADES) expect(isMatchSkillId(t.skillId)).toBe(true);
  });

  it("every role kind appears on at least one seeded posting, even at the smallest size", () => {
    const plan = buildDemoPlan({ ...DEFAULT_DEMO_PLAN, postings: DEMO_TRADES.length });
    expect(new Set(plan.postings.map((p) => p.roleKind)).size).toBe(TRADE_FORM_KINDS_ALL.length);
  });

  it("welder and CNC postings name the skills onboarding derives (ROLE_TO_MATCH_SKILL)", () => {
    const plan = buildDemoPlan();
    const named = (kind: string) =>
      new Set(plan.postings.filter((p) => p.roleKind === kind).flatMap((p) => p.matchSkillIds));
    expect(named("welder").has(ROLE_TO_MATCH_SKILL.role_welder)).toBe(true);
    expect(named("cnc_turner").has(ROLE_TO_MATCH_SKILL.role_cnc_turner_operator)).toBe(true);
    expect(named("conventional_machinist").has(ROLE_TO_MATCH_SKILL.role_cnc_operator)).toBe(true);
  });

  it("proxy postings post a single skill (never a second related one)", () => {
    for (const p of buildDemoPlan().postings.filter((x) => x.proxy)) {
      expect(p.matchSkillIds).toHaveLength(1);
    }
  });

  it("every worker-visible string passes the ADR-0024 screens", () => {
    for (const p of buildDemoPlan().postings) {
      for (const [field, text] of workerVisibleFields(p)) {
        expect(workerVisibleTextScreens(text), `${p.postingId} ${field}`).toEqual([]);
      }
    }
  });

  it("card fields satisfy the job_postings CHECK constraints", () => {
    for (const p of buildDemoPlan().postings) {
      expect(p.payMax).toBeGreaterThanOrEqual(p.payMin);
      expect(p.payMin).toBeGreaterThan(0);
      expect(p.maxExperienceYears).toBeGreaterThanOrEqual(p.minExperienceYears);
      expect(p.publishedMinutesAgo).toBeGreaterThanOrEqual(0);
    }
  });

  it("~3% of postings are boosted, and several employers own several postings", () => {
    const plan = buildDemoPlan();
    const boosted = plan.postings.filter((p) => p.boosted).length / plan.postings.length;
    expect(boosted).toBeGreaterThan(0.015);
    expect(boosted).toBeLessThan(0.05);
    const perPayer = new Map<number, number>();
    for (const p of plan.postings)
      perPayer.set(p.payerIndex, (perPayer.get(p.payerIndex) ?? 0) + 1);
    expect(perPayer.size).toBe(plan.payers.length);
    expect([...perPayer.values()].filter((n) => n >= 10).length).toBeGreaterThanOrEqual(10);
  });
});

describe("demo-matching plan — personas", () => {
  it("caps personas at 10 and puts both showcases first", () => {
    expect(DEMO_PERSONAS.length).toBeLessThanOrEqual(MAX_DEMO_PERSONAS);
    expect(DEMO_PERSONAS.slice(0, 2).every((p) => p.showcase)).toBe(true);
    expect(() =>
      buildDemoPlan({ ...DEFAULT_DEMO_PLAN, personas: MAX_DEMO_PERSONAS + 1 }),
    ).toThrow();
  });

  it("EVERY persona has direct, related-only and hidden postings — full size and the small CI profile", () => {
    for (const size of [
      DEFAULT_DEMO_PLAN,
      { personas: 5, postings: 200, rngSeed: DEFAULT_DEMO_PLAN.rngSeed },
    ]) {
      const plan = buildDemoPlan(size);
      const rows = withReach(plan);
      for (const persona of plan.personas) {
        const e = personaExpectation(persona, rows);
        expect(e.direct.length, `${persona.key} direct`).toBeGreaterThan(0);
        expect(e.relatedOnly.length, `${persona.key} related`).toBeGreaterThan(0);
        expect(e.hidden.length, `${persona.key} hidden`).toBeGreaterThan(e.direct.length);
      }
    }
  });
});

describe("seed-demo-matching guards (pure)", () => {
  it("a production-like target refuses unless --target=production is declared", () => {
    const prod = "postgresql://u:p@db.example-host.com:5432/app";
    const local = "postgresql://u:p@localhost:5432/app";
    expect(targetDeclarationProblem(prod, undefined)).toMatch(/production-like/);
    expect(targetDeclarationProblem(prod, "local")).toMatch(/production-like/);
    expect(targetDeclarationProblem(prod, "production")).toBeNull();
    expect(targetDeclarationProblem(local, undefined)).toBeNull();
    expect(targetDeclarationProblem(local, "production")).toMatch(/mismatch/);
    expect(targetDeclarationProblem(local, "staging")).toMatch(/must be/);
    expect(targetDeclarationProblem("not a url", undefined)).toMatch(/production-like/);
    // The URL (and its credential) is never echoed.
    expect(targetDeclarationProblem(prod, undefined)).not.toContain("example-host");
  });

  it("employer_sharing is granted to personas on a local target only", () => {
    expect(personaConsentPurposes("local")).toContain("employer_sharing");
    expect(personaConsentPurposes("production")).not.toContain("employer_sharing");
  });

  it("--reset-live-worker only touches allow-listed phones in the demo block", () => {
    const allowed = parseAllowPhones(
      "# demo phones\n+910000026001\n\n+910000026101  # live welder\n",
    );
    expect(resetPhoneProblem("+910000026101", allowed)).toBeNull();
    expect(resetPhoneProblem("+910000026002", allowed)).toMatch(/allow-phones/);
    expect(resetPhoneProblem("+919876543210", new Set(["+919876543210"]))).toMatch(/demo block/);
    // The E4 fixture and the smoke worker sit in the reserved range but outside the demo block.
    expect(resetPhoneProblem("+910000019844", new Set(["+910000019844"]))).toMatch(/demo block/);
    expect(resetPhoneProblem("+910000000000", new Set(["+910000000000"]))).toMatch(/demo block/);
  });

  it("the trade report tracks the role bridge and covers every form kind", () => {
    const rows = tradeReportRows();
    for (const [roleId, skillId] of Object.entries(ROLE_TO_MATCH_SKILL)) {
      expect(rows).toContainEqual({
        label: roleId.replace(/^role_/, ""),
        path: "chat (role)",
        skills: [skillId],
      });
    }
    expect(
      rows
        .filter((r) => r.path === "trade form")
        .map((r) => r.label)
        .sort(),
    ).toEqual([...TRADE_FORM_KINDS_ALL].sort());
  });
});
