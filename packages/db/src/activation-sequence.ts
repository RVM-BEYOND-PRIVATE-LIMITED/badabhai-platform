/**
 * The activation sequence — the exact order, and what each step is allowed to assume.
 *
 * ===========================================================================
 * WHY THIS IS DATA AND NOT A RUNBOOK PAGE
 * ===========================================================================
 * An activation plan written as prose has one failure mode and it is always the same: a step
 * silently loses its precondition. Someone rules on a decision, the ordering shifts, the page
 * still lists the old order, and the person following it does step 6 before step 4 because
 * nothing said they could not.
 *
 * So the sequence is typed rows whose preconditions are `programme-graph.ts` ITEM IDS. The
 * validator checks the two things a plan can be wrong about:
 *
 *   1. a step's preconditions must be items that actually exist; and
 *   2. no step may come before a step it depends on.
 *
 * Both are structural, so they hold whatever the graph says today. When a decision lands and an
 * item flips to COMPLETE, the sequence does not need editing — `readyNow` simply returns more.
 *
 * ===========================================================================
 * WHAT THIS FILE CANNOT DO
 * ===========================================================================
 * It cannot activate anything. There is no runner here, no database handle and no flag write.
 * Every step names the runner an operator would invoke, and every one of those has its own
 * two-signal ops guard.
 *
 * `authorisation` is the field that matters most. A step marked `NONE` is engineering-only; any
 * other value names a human who must act first, and `readyNow` refuses to include a step whose
 * preconditions are unmet **regardless** of how safe the step looks in isolation.
 */
import { PROGRAMME, type ProgrammeItem } from "./programme-graph";

/** Who must act before a step may run. */
export type Authorisation = "NONE" | "OWNER" | "PRODUCTION_WRITE" | "AI_SPEND";

export interface ActivationStep {
  readonly order: number;
  readonly id: string;
  readonly what: string;
  /** The command an operator runs, or null for a step that is a decision or an observation. */
  readonly runner: string | null;
  /** `programme-graph.ts` item ids that must be COMPLETE first. */
  readonly preconditions: readonly string[];
  /** Step ids that must come earlier. Ordering the graph does not already imply. */
  readonly after: readonly string[];
  readonly authorisation: Authorisation;
  /** How an operator knows it worked. Required for anything that writes. */
  readonly verification: string;
  /** How to undo it. Required for anything that writes. `null` only for read-only steps. */
  readonly rollback: string | null;
}

/**
 * The sequence.
 *
 * Ordered by dependency, not by convenience. Two orderings are load-bearing and neither is
 * obvious, so both are stated where they apply:
 *
 *   - the **evidence** run comes after the `NO_REGRESSION` semantics ruling, because the ruling
 *     decides which fixture to measure and spending first buys the wrong measurement; and
 *   - the **flag read** comes first, before anything is changed, because every severity
 *     assessment in the register is a function of a value nobody has read.
 */
export const ACTIVATION_SEQUENCE: readonly ActivationStep[] = [
  {
    order: 1,
    id: "READ-FLAG",
    what:
      "Read the effective SKILL_CANONICALIZE_ENABLED in the running ai-service. It was changed " +
      "on 2026-08-24 and every deploy since carries it.",
    runner: "docker compose exec ai-service env | grep SKILL_CANONICALIZE_ENABLED   (on the box)",
    preconditions: [],
    after: [],
    authorisation: "OWNER",
    verification: "The value is written into the register with the date it was read.",
    rollback: null,
  },
  {
    order: 2,
    id: "RULE-DECISIONS",
    what:
      "Rule on D-7A, D-7C-1a, D-7C-1b, §5a-2 and the NO_REGRESSION semantics. Nothing below " +
      "moves without them, and three of the five have measured evidence that narrows the choice.",
    runner: null,
    preconditions: [],
    after: ["READ-FLAG"],
    authorisation: "OWNER",
    verification: "Each decision recorded in the register; the graph items flip to COMPLETE.",
    rollback: null,
  },
  {
    order: 3,
    id: "ALIAS-CLEANUP",
    what:
      "Apply the ratified de-elections. Drives duplicate-text rows from 19 to 0 and moves no " +
      "ceiling — determinism, not floor safety.",
    runner: "pnpm db:decollide:aliases --run --i-am-authorised-to-write-to-production",
    preconditions: ["D-7C-1b"],
    after: ["RULE-DECISIONS"],
    authorisation: "PRODUCTION_WRITE",
    verification:
      "pnpm db:audit:alias-cleanup — S0 duplicate_residue_rows should read 0 against the new baseline.",
    rollback:
      "Remove the entry from decollided-aliases.json and re-run db:embed:skills; the row, its " +
      "id and its text were never deleted, so it is re-embedded.",
  },
  {
    order: 4,
    id: "D7C-SEED",
    what: "Seed the three approved corpus deprecations. skill_boring is excluded by allow-list.",
    runner:
      "pnpm db:seed:deprecations --only=<the three> --apply --i-am-authorised-to-write-to-production",
    preconditions: ["D-7C-1a", "D-7A"],
    after: ["ALIAS-CLEANUP"],
    authorisation: "PRODUCTION_WRITE",
    verification:
      "The runner reads every row back and compares; pnpm db:audit:crosswalk-invariants then " +
      "shows the three moving from CORPUS-ONLY to LIVE.",
    rollback:
      "UPDATE skill SET status='active', replaced_by=NULL for the three. Nothing is deleted, so " +
      "it is a status flip back. Re-tagged rows would need db:retag:skills — there are none today.",
  },
  {
    order: 5,
    id: "FRESH-EVIDENCE",
    what:
      "Run a fingerprinted floor sweep and evaluation. AFTER the corpus writes above, so the " +
      "fingerprint describes the corpus that will be promoted rather than the one before it.",
    runner: "pnpm db:sweep:floor --run --experiment ... && pnpm db:eval:taxonomy --run --experiment ...",
    preconditions: ["NO-REGRESSION-SEMANTICS"],
    after: ["D7C-SEED"],
    authorisation: "AI_SPEND",
    verification:
      "Both records carry a corpus_fingerprint equal to the live one; pnpm db:audit:gate-evidence " +
      "reports zero independent blockers for NO_REGRESSION freshness.",
    rollback:
      "None needed — experiment records are immutable and additive, and the runner refuses to " +
      "overwrite a run_id.",
  },
  {
    order: 6,
    id: "CLEAR-FLOOR-GATE",
    what:
      "Close RESOLVABLE_ABOVE_FLOOR: 28 skills resolve correctly below 0.75 and need corpus " +
      "work, not a threshold change. The 6 unmeasured are answered by step 5 at no extra cost.",
    runner: "pnpm db:audit:gate-evidence --batch <dir>",
    preconditions: ["RESOLVABLE-28", "RESOLVABLE-6"],
    after: ["FRESH-EVIDENCE"],
    authorisation: "OWNER",
    verification: "promote-skills --plan reports RESOLVABLE_ABOVE_FLOOR blocking 0.",
    rollback: null,
  },
  {
    order: 7,
    id: "PROMOTE",
    what: "Promote the 96. Fail-closed: nothing is promoted unless every candidate clears every gate.",
    // `--fixture` IS NOT OPTIONAL HERE, and leaving it off was a live defect in this plan.
    // `promote-skills` imports its default from `taxonomy-retrieval-eval.ts`, and that default
    // is retrieval-v2 — under which EVAL_COVERED blocks 41 of the 96. The programme's "0 of 96
    // uncovered" is a v3 number. Naming the fixture is what makes the documented command match
    // the documented gate state.
    runner:
      "pnpm db:promote:skills --batch <dir> --fixture data/taxonomy/eval/retrieval-v3.jsonl " +
      "--sweep <fresh> --eval <fresh> --apply --i-am-authorised-to-write-to-production",
    preconditions: ["PROMOTION"],
    after: ["CLEAR-FLOOR-GATE"],
    authorisation: "PRODUCTION_WRITE",
    verification:
      "The runner writes an audit report to docs/registers/skill-promotions/; skill.status " +
      "reads 96 fewer provisional and 96 more active.",
    rollback:
      "UPDATE skill SET status='provisional' for the batch's 96 ids. Additive and reversible; " +
      "no id changes and no row is deleted.",
  },
  {
    order: 8,
    id: "OBSERVE",
    what:
      "Observe with canonicalization still OFF. Promotion widens the retrieval surface — 96 " +
      "skills become visible to it — and that is measurable before anything routes to it.",
    runner: "pnpm db:audit:vernacular-resweep && pnpm db:audit:sibling-margin",
    preconditions: [],
    after: ["PROMOTE"],
    authorisation: "NONE",
    verification:
      "The three ceilings re-measured against the promoted corpus. A ceiling that rises above " +
      "its pre-promotion value is a reason to stop, not a reason to continue carefully.",
    rollback: null,
  },
  {
    order: 9,
    id: "ENABLE-CANONICALIZATION",
    what:
      "Set SKILL_CANONICALIZE_ENABLED. THIS IS THE ACTIVATION — the route stops returning " +
      "`unresolved` and starts assigning canonical ids to worker phrases.",
    runner: "set the GitHub Actions secret, then merge to main (the deploy job runs on every push)",
    preconditions: ["CANONICALIZATION"],
    after: ["OBSERVE"],
    authorisation: "OWNER",
    verification:
      "unresolved_phrase stops accumulating skill-scope misses for phrases the corpus covers; " +
      "worker_skill begins to fill.",
    rollback:
      "Set the secret back and merge. One deploy cycle. Rows already written are NOT rolled " +
      "back by this — worker_skill would need a separate, reviewed deletion.",
  },
];

export interface SequenceProblem {
  readonly id: string;
  readonly problem: string;
}

/**
 * Check the plan is a plan.
 *
 * The `after` edges are validated against declared order rather than inferred from it, because a
 * plan whose ordering is implicit is one renumbering away from being wrong.
 */
export function validateSequence(
  steps: readonly ActivationStep[],
  items: readonly ProgrammeItem[] = PROGRAMME,
): SequenceProblem[] {
  const known = new Set(items.map((i) => i.id));
  const byId = new Map(steps.map((s) => [s.id, s]));
  const problems: SequenceProblem[] = [];

  steps.forEach((s, idx) => {
    if (s.order !== idx + 1) problems.push({ id: s.id, problem: `order ${s.order} at index ${idx}` });
    for (const p of s.preconditions) {
      if (!known.has(p)) problems.push({ id: s.id, problem: `unknown precondition ${p}` });
    }
    for (const a of s.after) {
      const prior = byId.get(a);
      if (prior === undefined) problems.push({ id: s.id, problem: `unknown predecessor ${a}` });
      else if (prior.order >= s.order) {
        problems.push({ id: s.id, problem: `must come after ${a}, which is ordered later` });
      }
    }
    // A step that writes must say how you know it worked and how to undo it. Without both, the
    // plan is a list of commands rather than a procedure.
    if (s.authorisation === "PRODUCTION_WRITE") {
      if (s.rollback === null) problems.push({ id: s.id, problem: "production write with no rollback" });
      if (s.verification.trim() === "") {
        problems.push({ id: s.id, problem: "production write with no verification" });
      }
    }
    if (s.runner !== null && s.runner.includes("--apply") && s.authorisation === "NONE") {
      problems.push({ id: s.id, problem: "runs --apply but claims to need no authorisation" });
    }
  });
  return problems;
}

/**
 * Steps whose preconditions are all COMPLETE — what could actually start.
 *
 * Deliberately ignores `after`: a step can be ready in the graph's terms while an earlier step
 * has not been performed. Reporting both separately is what makes "ready" mean something; the
 * doc pairs this with the ordering rather than merging them.
 */
export function readyNow(
  steps: readonly ActivationStep[],
  items: readonly ProgrammeItem[] = PROGRAMME,
): readonly ActivationStep[] {
  const complete = new Set(items.filter((i) => i.status === "COMPLETE").map((i) => i.id));
  return steps.filter((s) => s.preconditions.every((p) => complete.has(p)));
}

/** The first step that is NOT ready — where the sequence actually stops today. */
export function stopsAt(
  steps: readonly ActivationStep[],
  items: readonly ProgrammeItem[] = PROGRAMME,
): ActivationStep | null {
  const ready = new Set(readyNow(steps, items).map((s) => s.id));
  return steps.find((s) => !ready.has(s.id)) ?? null;
}
