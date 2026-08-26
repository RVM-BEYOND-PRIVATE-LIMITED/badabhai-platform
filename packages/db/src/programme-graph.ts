/**
 * Every remaining item in the Phase 9 programme, and what each one is actually waiting for.
 *
 * ===========================================================================
 * WHY A TYPED GRAPH AND NOT A CHECKLIST
 * ===========================================================================
 * `project-control.md` §H says *"No independently executable engineering task remains in this
 * programme"*. That was true when written and it is the kind of sentence that stays in a
 * document long after it stops being true — nine engineering tasks have landed since. A prose
 * list cannot be wrong out loud; a typed graph with a validator can.
 *
 * The classification is the useful part, and it is deliberately about **who is blocking**, not
 * about difficulty:
 *
 *   EXECUTABLE                   an agent or engineer can finish it today, alone
 *   BLOCKED_ON_OWNER             needs a product or taxonomy judgement
 *   BLOCKED_ON_PRODUCTION_WRITE  the mechanism exists and the write is unauthorised
 *   BLOCKED_ON_AI_SPEND          needs a provider call
 *   BLOCKED_ON_DATA              needs data that does not exist yet
 *   BLOCKED_ON_INFRA             needs access nobody in this repository has
 *   COMPLETE                     landed and verified on origin/main
 *
 * Those six blockers are exactly the things an agent must not decide for itself, plus the one it
 * cannot do at all. Sorting by them turns "the programme is blocked" — which is useless — into
 * "these three people are each holding one thread".
 *
 * ===========================================================================
 * THE INVARIANT THIS FILE DEFENDS
 * ===========================================================================
 * An item may not be `BLOCKED_ON_OWNER` without naming the decision, and may not be
 * `EXECUTABLE` while depending on something that is not `COMPLETE`. Both are checked. The second
 * is what stops a plan from claiming work can start when its input has not arrived.
 *
 * Pure data and pure rules. No IO, no clock, no database.
 */

export type ItemStatus =
  | "COMPLETE"
  | "EXECUTABLE"
  | "BLOCKED_ON_OWNER"
  | "BLOCKED_ON_PRODUCTION_WRITE"
  | "BLOCKED_ON_AI_SPEND"
  | "BLOCKED_ON_DATA"
  | "BLOCKED_ON_INFRA";

export interface ProgrammeItem {
  readonly id: string;
  readonly title: string;
  readonly status: ItemStatus;
  /** Ids this item cannot start without. */
  readonly dependsOn: readonly string[];
  /** For BLOCKED_ON_OWNER: the decision, in the owner's terms. Required. */
  readonly decision?: string;
  /** For BLOCKED_ON_AI_SPEND: the measured rupee cost. Required, and never an estimate range. */
  readonly costInr?: number;
  /** Where the evidence lives. */
  readonly evidence: string;
  /** What it unblocks. Empty for leaves. */
  readonly unblocks: readonly string[];
}

/**
 * The whole programme, as of 2026-08-26.
 *
 * Ordered by id rather than by priority on purpose: a priority order is a judgement that goes
 * stale, and the dependency edges already encode everything that is genuinely ordered.
 */
export const PROGRAMME: readonly ProgrammeItem[] = [
  // ── settled ───────────────────────────────────────────────────────────────
  {
    id: "Q1",
    title: "Every promotable skill carries a MATCHED or INTENTIONALLY_UNMATCHED disposition",
    status: "COMPLETE",
    dependsOn: [],
    evidence: "q1-disposition-triage.md · MATCH_VOCABULARY gate passes 0/96",
    unblocks: ["PROMOTION"],
  },
  {
    id: "FLOOR-0.75",
    title: "Keep the canonicalization floor at 0.75",
    status: "COMPLETE",
    dependsOn: [],
    evidence: "decision-canonicalization-floor-0.75.md · owner ruling 2026-08-26",
    unblocks: [],
  },
  {
    id: "D6-0",
    title: "The 22 ratified vernacular aliases",
    status: "COMPLETE",
    dependsOn: [],
    evidence: "shipped 2026-07-16; all 22 live and embedded, measured 2026-08-24",
    unblocks: [],
  },
  {
    id: "D-7B",
    title: "skill_chassis_fitting widens to mskill_fitter — accepted as-is",
    status: "COMPLETE",
    dependsOn: [],
    evidence: "d7b-chassis-fitting-decision.md · ratified 2026-08-26 · pinned in the crosswalk matrix",
    unblocks: [],
  },
  {
    id: "EVAL-COVERED",
    title: "EVAL_COVERED — mechanical corpus_alias cases do not count as coverage",
    status: "COMPLETE",
    dependsOn: [],
    evidence:
      "countsAsEvalCoverage implements the strict reading; gate-evidence.json shows 0 of 96 " +
      "uncovered under retrieval-v3. The 41/96 quoted elsewhere is retrieval-v2.",
    unblocks: ["PROMOTION"],
  },
  {
    id: "DOMAIN-MATCH-FLAG",
    title: "Is DOMAIN_MATCH_ENABLED off in production?",
    status: "COMPLETE",
    dependsOn: [],
    evidence: "deployed-flag-facts.md — the secret does not exist, so compose's :- default governs. PROVED false.",
    unblocks: [],
  },

  // ── owner decisions ───────────────────────────────────────────────────────
  {
    id: "D-7A",
    title: "skill_boring stays on hold — unmapped, unseeded, unretagged",
    status: "COMPLETE",
    dependsOn: [],
    evidence:
      "RULED 2026-08-26: KEEP THE HOLD. No widening mapping for boring, no invented mskill " +
      "target, re-evaluate later against real performance. This is the option d7a-boring-hold.md " +
      "describes as the current safe behaviour, so nothing changed in the corpus — which is the " +
      "point. It also keeps the three-vs-four split in D-7C load-bearing: skill_boring must stay " +
      "out of the seed set, and seed-deprecations.ts refuses it by allow-list.",
    unblocks: ["D-7C-SEED"],
  },
  {
    id: "D-7C-1a",
    title: "GD&T survives the seed — the two exclusions were re-pointed at the deprecation subject",
    status: "COMPLETE",
    dependsOn: [],
    evidence:
      "RULED 2026-08-26: OPTION A, applied. decollided-aliases.json now excludes " +
      "skill_gdt_reading's copies of `GD&T` and `geometric dimensioning and tolerancing` so the " +
      "surviving holder keeps both. VERIFIED against live rows: db:seed:deprecations --plan " +
      "reports cross-decision orphans 0, down from 2, and its preconditions now PASS. The " +
      "tripwire in alias-cleanup-plan.test.ts was INVERTED rather than deleted — it now " +
      "asserts that no de-election hands a text to a D-7C subject, for any subject.",
    unblocks: ["D-7C-SEED"],
  },
  {
    id: "D-7C-1b",
    title: "skill_drawing_reading keeps CAD, drawing padhna, read engineering drawings, technical drawing",
    status: "COMPLETE",
    dependsOn: [],
    evidence:
      "RULED 2026-08-26: OPTION A — the successor keeps the text, the reading the ratified " +
      "crosswalk already names. The four rows were MOVED into decollided-aliases.json and the " +
      "proposal file was DELETED (see d7c1-alias-collision-cleanup.md), because ratifying in " +
      "place would leave a second source of truth no runner reads. The stated cost stands and " +
      "was not re-litigated: the " +
      "cnc-programming slug loses those four phrases until TAX-6 replaces slug-scoped retrieval. " +
      "`drawing padhna` is one of the 22 ratified vernacular aliases and its surviving copy was " +
      "verified present and embedded before the file was written.",
    unblocks: ["ALIAS-CLEANUP-APPLY"],
  },
  {
    id: "5a-2",
    title: "The sibling margin — accepted as measured; no separation rule, floor unmoved",
    status: "COMPLETE",
    dependsOn: [],
    evidence:
      "RULED 2026-08-26: OPTION A — accept the margin. No minimum-separation rule and no " +
      "disambiguation group; the 0.75 floor is unmoved and the existing gate is untouched. The " +
      "evidence supported this: option B costs 26 of 43 right answers at δ=0.15, its first " +
      "working value, and option C's simple form misses GMAW/SMAW at 0.8405. NOTHING WAS " +
      "IMPLEMENTED, which is the ruling: the tripwire asserting that no runtime config mentions " +
      "separation|min_margin|margin_floor stays in place and now guards the decision rather " +
      "than the absence of one. Residual risk accepted: four welding-acronym pairs at " +
      "0.80-0.84 inside the correct domain, re-measurable at activation step 8 (OBSERVE).",
    unblocks: ["CANONICALIZATION"],
  },
  {
    id: "NO-REGRESSION-SEMANTICS",
    title: "Does NO_REGRESSION keep strict v2-only semantics, or split regression from coverage?",
    status: "BLOCKED_ON_OWNER",
    dependsOn: [],
    decision:
      "Options A-D in decision-no-regression-fixture-architecture.md. Two owner messages " +
      "point different ways — 'regression-budget architecture' and 'do not weaken the gate' — " +
      "so the gate is untouched pending an unambiguous ruling.",
    evidence: "decision-no-regression-fixture-architecture.md · no-regression-v3-conflict.test.ts",
    unblocks: ["NO-REGRESSION-EVIDENCE"],
  },
  {
    id: "CNC-PROGRAMMING",
    title: "The cnc-programming slug — A/B/C",
    status: "BLOCKED_ON_OWNER",
    dependsOn: [],
    decision: "Three costed options; 11 candidate rows across 4 skills, unchanged since 2026-08-20.",
    evidence: "phase-9-cnc-programming-decision.md",
    unblocks: [],
  },
  {
    id: "TD-07",
    title: "skill_welder_occupation → mskill_mig_welder — T1..T4",
    status: "BLOCKED_ON_OWNER",
    dependsOn: [],
    decision: "Four costed remedies. Zero welding rows exist, so the fix is free today.",
    evidence: "phase-9-open-decisions.md §2",
    unblocks: [],
  },
  {
    id: "OIE-CANONICALIZE",
    title: "Should the OIE path populate job_domain_id?",
    status: "BLOCKED_ON_OWNER",
    dependsOn: [],
    decision: "O1/O2/O3. The occupation pin and the canonicalize pass sit on mutually exclusive branches.",
    evidence: "phase-9-open-decisions.md §3",
    unblocks: [],
  },
  {
    id: "MIGRATION-ORPHAN",
    title: "One production migration from a checkout that never reached main",
    status: "BLOCKED_ON_OWNER",
    dependsOn: [],
    decision: "Its author owes the reconciliation. Locked, so there is no exposure.",
    evidence: "phase-9-remaining-gates.md gate 13",
    unblocks: [],
  },
  {
    id: "RESOLVABLE-28",
    title: "28 promotable skills resolve CORRECTLY below the floor",
    status: "BLOCKED_ON_OWNER",
    dependsOn: [],
    decision:
      "The remedy is corpus — more or better aliases — and ratifying an alias is an owner act " +
      "(TAX-0 gate d). Lowering the floor is prohibited and would admit the §5a misassignments.",
    evidence: "gate-evidence.md · worst is skill_wiring_harness_routing at 0.5986",
    unblocks: ["PROMOTION"],
  },

  // ── needs spend ───────────────────────────────────────────────────────────
  {
    id: "NO-REGRESSION-EVIDENCE",
    title: "A fingerprinted floor sweep — the evaluation half is done, at ₹0",
    status: "BLOCKED_ON_AI_SPEND",
    // The RULING still decides which fixture the SWEEP runs on, so the remaining spend cannot
    // be commissioned before it.
    dependsOn: ["SWEEP-FINGERPRINT", "NO-REGRESSION-SEMANTICS"],
    // Was ₹0.028128 for both halves. The evaluation half cost NOTHING: every fixture-v2 query
    // vector was already in the local embed cache, so `db:eval:taxonomy --run --cache`
    // re-measured the whole fixture with 127 hits and 0 provider calls. What remains is the
    // sweep; on fixture v3 only its 41 added queries are uncached, which is why this is now
    // roughly an eighth of the original figure rather than half of it.
    costInr: 0.0035,
    evidence:
      "gate-evidence.md + EXP-P9-REGRESSION-FRESH (2026-08-26). The claim that neither record " +
      "could be produced from stored vectors was WRONG for the evaluation and is corrected here. " +
      "The fresh fingerprinted v2 run scored R@1 0.9912 / MRR 0.9956 against a 1.0/1.0 reference " +
      "— one case of 123, in paraphrase_latin. Freshness is no longer the blocker; the score is.",
    unblocks: ["PROMOTION", "RESOLVABLE-6"],
  },
  {
    id: "RESOLVABLE-6",
    title: "6 promotable skills produced no correct case in the 2026-08-21 sweep",
    status: "BLOCKED_ON_AI_SPEND",
    dependsOn: ["NO-REGRESSION-EVIDENCE"],
    costInr: 0,
    evidence:
      "gate-evidence.md — they ARE in fixture v3, so this is a property of that run. The fresh " +
      "sweep answers it at no additional cost; it is the same run.",
    unblocks: ["PROMOTION"],
  },

  // ── needs a production write nobody has authorised ────────────────────────
  {
    id: "ALIAS-CLEANUP-APPLY",
    title: "Apply the ratified de-elections (4) and, if ratified, the proposed ones (4)",
    status: "BLOCKED_ON_PRODUCTION_WRITE",
    dependsOn: ["D-7C-1b"],
    evidence:
      "db:decollide:aliases exists with a two-signal ops guard and has never run. " +
      "d7c1-alias-collision-cleanup.md simulates the outcome exactly.",
    unblocks: ["CANONICALIZATION"],
  },
  {
    id: "D-7C-SEED",
    title: "Seed the three approved corpus deprecations",
    status: "BLOCKED_ON_PRODUCTION_WRITE",
    dependsOn: ["D-7C-1a", "D-7A"],
    evidence:
      "db:seed:deprecations exists, is tested, and currently REFUSES on D-7C-1a. It has never " +
      "been invoked with --apply.",
    unblocks: ["CANONICALIZATION"],
  },
  {
    id: "FORENSICS-JOBS",
    title: "Delete-forensics triggers on jobs and applications",
    status: "BLOCKED_ON_PRODUCTION_WRITE",
    dependsOn: [],
    evidence:
      "live-population-2026-08-26.md — jobs 25→19 and applications 92→28 with no forensic " +
      "record, because the trigger exists on workers and worker_profiles only.",
    unblocks: [],
  },

  // ── needs data that does not exist ────────────────────────────────────────
  {
    id: "D6-1",
    title: "A human-reviewed romanized-Hindi evaluation fixture",
    status: "BLOCKED_ON_DATA",
    dependsOn: [],
    evidence:
      "Recorded as needing human authoring or worker traffic. Worker traffic now EXISTS — 37 " +
      "workers and 22 profiles as of 2026-08-26, against 1 worker when the item was written — " +
      "so db:mine:aliases has real phrases to mine for the first time. Agent-authored " +
      "paraphrases still must not become ground truth; mined WORKER language is not that.",
    unblocks: [],
  },
  {
    id: "ONE-WORKER-PREDICATE",
    title: 'What did the recorded "1 worker [08-24]" count?',
    status: "BLOCKED_ON_DATA",
    dependsOn: [],
    evidence:
      "live-population-2026-08-26.md — 31 workers existed before 08-24 and nothing was deleted " +
      "after 08-21. Five candidate predicates were probed and none yields 1. The figure carries " +
      "no population_predicate; only its author can say.",
    unblocks: [],
  },

  // ── needs access nobody here has ──────────────────────────────────────────
  {
    id: "CANONICALIZE-FLAG-VALUE",
    title: "The effective value of SKILL_CANONICALIZE_ENABLED in the running container",
    status: "BLOCKED_ON_INFRA",
    dependsOn: [],
    evidence:
      "deployed-flag-facts.md — the secret exists and its value was CHANGED on 2026-08-24 " +
      "11:30:45 UTC; deploys run on every main push, so the change is live. GitHub never " +
      "exposes a value. One command on the box settles it.",
    unblocks: ["CANONICALIZATION"],
  },
  {
    id: "POOLER",
    title: "Supabase pooler saturation (EMAXCONNSESSION, pool_size 15)",
    status: "BLOCKED_ON_INFRA",
    dependsOn: [],
    evidence:
      "project-control.md — intermittent, the binding constraint on every measurement task. " +
      "No configuration changed. It did not fire once across this session's runs.",
    unblocks: [],
  },
  {
    id: "R38",
    title: "R38 residual — host-only, CD cannot fix it",
    status: "BLOCKED_ON_INFRA",
    dependsOn: [],
    evidence: "phase-9-remaining-gates.md gate 6",
    unblocks: [],
  },
  {
    id: "REDIS-IPV6",
    title: "AI_SPEND_REDIS_URL IPv6",
    status: "BLOCKED_ON_INFRA",
    dependsOn: [],
    evidence: "project-control.md, optional/hardening",
    unblocks: [],
  },

  // ── executable ────────────────────────────────────────────────────────────
  {
    id: "SWEEP-FINGERPRINT",
    title: "Both record kinds must CARRY a corpus_fingerprint into the experiment file",
    status: "COMPLETE",
    dependsOn: [],
    evidence:
      "gate-evidence.md — TWO defects, same shape, found a week apart. (1) ExperimentRecord had " +
      "no such field while promote-skills already read it. (2) 2026-08-26: the EVALUATION side " +
      "computed the fingerprint all along, printed it, and then dropped it on the way into the " +
      "experiment record — the only artifact judgeRegression ever sees. So every evaluation ever " +
      "recorded reached the gate with corpus_fingerprint undefined and was refused as unprovable, " +
      "and the gate's own advice (\"re-run db:eval:taxonomy\") pointed at a re-run that could not " +
      "have helped. Both fixed; the 1.0/1.0 bar and the floor are untouched, and a record with no " +
      "fingerprint is still refused (regression-evidence.test.ts).",
    unblocks: ["NO-REGRESSION-EVIDENCE"],
  },
  {
    id: "OPS-GUARD-COVERAGE",
    title: "Ops-guard coverage on the activation-path write runners",
    status: "COMPLETE",
    dependsOn: [],
    evidence:
      "RETRACTED AND RE-MEASURED 2026-08-26. A first pass grepped each runner for the literal " +
      "`enforceOpsGuard` and reported six as unguarded — materialize-job-reach, " +
      "normalize-skill-aliases, seed-domain-skills, normalize-job-domain-aliases, " +
      "backfill-worker-skills, grant-free-tier. That method cannot see indirection. All six " +
      "call parseCommonCli (match-v1-cli.ts), which calls enforceOpsGuard with " +
      "`mutating: apply` and also owns the missing-DATABASE_URL refusal. They are guarded, and " +
      "the guard is in ONE place rather than six. See programme-graph.md for the correction.",
    unblocks: [],
  },

  // ── the leaves ────────────────────────────────────────────────────────────
  {
    id: "PROMOTION",
    title: "Promote the 96",
    status: "BLOCKED_ON_OWNER",
    dependsOn: ["Q1", "EVAL-COVERED", "RESOLVABLE-28", "RESOLVABLE-6", "NO-REGRESSION-EVIDENCE"],
    decision: "Nothing to decide until its inputs land. Listed so the graph has a terminus.",
    evidence: "audit-promotion-gates + promote-skills --plan: 96 candidates, 0 eligible",
    unblocks: ["CANONICALIZATION"],
  },
  {
    id: "CANONICALIZATION",
    title: "Turn SKILL_CANONICALIZE_ENABLED on",
    status: "BLOCKED_ON_OWNER",
    dependsOn: ["PROMOTION", "ALIAS-CLEANUP-APPLY", "D-7C-SEED", "5a-2", "CANONICALIZE-FLAG-VALUE"],
    decision: "The activation itself.",
    evidence: "phase-9-path-a-activation-plan.md",
    unblocks: [],
  },
];

export interface GraphProblem {
  readonly id: string;
  readonly problem: string;
}

/**
 * Check the graph says something coherent.
 *
 * The second rule is the one that earns its keep: an item cannot be `EXECUTABLE` while it
 * depends on something unfinished. Without it a plan can promise work that cannot start, which
 * is the specific way a dependency list becomes reassuring and wrong.
 */
export function validateProgramme(items: readonly ProgrammeItem[]): GraphProblem[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const problems: GraphProblem[] = [];
  const seen = new Set<string>();

  for (const i of items) {
    if (seen.has(i.id)) problems.push({ id: i.id, problem: "duplicate id" });
    seen.add(i.id);

    if (i.status === "BLOCKED_ON_OWNER" && (i.decision ?? "").trim() === "") {
      problems.push({ id: i.id, problem: "BLOCKED_ON_OWNER without naming the decision" });
    }
    if (i.status === "BLOCKED_ON_AI_SPEND" && i.costInr === undefined) {
      problems.push({ id: i.id, problem: "BLOCKED_ON_AI_SPEND without a measured cost" });
    }
    if (i.evidence.trim() === "") {
      problems.push({ id: i.id, problem: "no evidence reference" });
    }
    for (const d of i.dependsOn) {
      if (!byId.has(d)) problems.push({ id: i.id, problem: `depends on unknown item ${d}` });
      else if (i.status === "EXECUTABLE" && byId.get(d)!.status !== "COMPLETE") {
        problems.push({
          id: i.id,
          problem: `EXECUTABLE but depends on ${d}, which is ${byId.get(d)!.status}`,
        });
      }
    }
    for (const u of i.unblocks) {
      if (!byId.has(u)) problems.push({ id: i.id, problem: `claims to unblock unknown item ${u}` });
      else if (!byId.get(u)!.dependsOn.includes(i.id)) {
        problems.push({ id: i.id, problem: `claims to unblock ${u}, which does not depend on it` });
      }
    }
  }
  return problems;
}

/** Everything that can be finished today without asking anyone. */
export function executable(items: readonly ProgrammeItem[]): readonly ProgrammeItem[] {
  return items.filter((i) => i.status === "EXECUTABLE");
}

/** Counts by status, for a header line that cannot drift from the list under it. */
export function statusCounts(items: readonly ProgrammeItem[]): Record<ItemStatus, number> {
  const out = {
    COMPLETE: 0,
    EXECUTABLE: 0,
    BLOCKED_ON_OWNER: 0,
    BLOCKED_ON_PRODUCTION_WRITE: 0,
    BLOCKED_ON_AI_SPEND: 0,
    BLOCKED_ON_DATA: 0,
    BLOCKED_ON_INFRA: 0,
  } as Record<ItemStatus, number>;
  for (const i of items) out[i.status] += 1;
  return out;
}

/**
 * The transitive blockers of one item — what would actually have to happen first.
 *
 * Reported as a set of ITEMS rather than a path, because several branches are independent and a
 * single path would imply an order the graph does not require.
 */
export function blockersOf(
  items: readonly ProgrammeItem[],
  id: string,
): readonly ProgrammeItem[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const out = new Map<string, ProgrammeItem>();
  const walk = (cur: string): void => {
    for (const d of byId.get(cur)?.dependsOn ?? []) {
      const item = byId.get(d);
      if (item === undefined || out.has(d)) continue;
      if (item.status !== "COMPLETE") out.set(d, item);
      walk(d);
    }
  };
  walk(id);
  return [...out.values()].sort((a, b) => a.id.localeCompare(b.id));
}
