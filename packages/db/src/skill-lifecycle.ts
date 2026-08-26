/**
 * The lifecycle of a skill and a skill alias — every path from a worker's words to a
 * retrievable row, as typed data with a validator.
 *
 * ===========================================================================
 * WHY THIS IS DATA AND NOT A DIAGRAM IN A DOCUMENT
 * ===========================================================================
 * "How does a new alias get created?" has been answered three different ways in this
 * repository, each correct about its own runner and silent about the other four. A diagram
 * cannot be wrong loudly: it drifts as runners are added and nothing fails.
 *
 * So the paths are rows, every write step names the FILE that performs the write, and
 * `validateLifecycle` re-derives the writer set from the source tree. Add a sixth
 * `.insert(skillAliases)` and the validator reports a path nobody declared. Delete a runner
 * and the step that names it fails. The claim that survives is therefore about the code as it
 * is, not as it was documented.
 *
 * ===========================================================================
 * THE ONE QUESTION THIS FILE EXISTS TO ANSWER
 * ===========================================================================
 * Not "can the vocabulary grow" — it can, five ways. The question is **how far a worker's
 * phrase travels on its own**, because that is what decides whether coverage improves while
 * nobody is looking.
 *
 * `automaticPrefix` answers it: the leading run of steps no human performs. On every path in
 * this file that prefix ends before a row is written. That is not a defect to be fixed by
 * removing the human — CLAUDE.md §3 puts the mapping decision with a person on purpose — but
 * it does mean **alias coverage is a function of review cadence, not of traffic**, and a
 * programme that expects the corpus to grow with usage is expecting something no path here
 * delivers.
 *
 * ===========================================================================
 * DIRECTIONALITY
 * ===========================================================================
 * `job_domain_alias` (how a worker says their OCCUPATION) is never a source for `skill_alias`
 * (how a worker says a UNIT OF WORK). The two vocabularies meet only through the edge table
 * `job_domain_skill`. That was established by reading in
 * `job-domain-alias-skill-alias-coverage-2026-08-21.md`; here it is a property a test can
 * check — `crossVocabularyWriters` finds any file that both reads one table and writes the
 * other, and the expected answer is the empty set.
 *
 * PRIVACY: table names, runner names and counts. No worker data of any kind.
 */

/** Who performs a step. The distinction the whole file turns on. */
export type Actor =
  /** Production code, on the request path. No operator involved. */
  | "RUNTIME"
  /** A `pnpm db:*` runner someone has to invoke. */
  | "OFFLINE_RUNNER"
  /** An LLM drafting a proposal that something downstream must still accept. */
  | "MODEL"
  /** A person reading, deciding, and committing. */
  | "HUMAN";

/** What a step leaves behind. */
export type Artifact =
  | "skill"
  | "skill_alias"
  | "job_domain"
  | "job_domain_alias"
  | "job_domain_skill"
  | "unresolved_phrase"
  | "worker_skill"
  | "job_posting_skill"
  | "repository_file"
  | "review_packet"
  | "nothing";

export interface LifecycleStep {
  readonly id: string;
  readonly what: string;
  readonly actor: Actor;
  /** The runner, route or file that performs it. `null` for a pure decision. */
  readonly performedBy: string | null;
  readonly writes: Artifact;
  /**
   * For a step whose actor is OFFLINE_RUNNER and which writes a table: the source file that
   * must contain the write. `validateLifecycle` checks it against the discovered writer set.
   */
  readonly writerFile?: string;
}

export interface LifecyclePath {
  readonly id: string;
  readonly title: string;
  /** Where the vocabulary comes from. */
  readonly origin: "WORKER_UTTERANCE" | "JOB_POSTING" | "STANDARDS_CATALOGUE" | "MODEL_DRAFT" | "HAND_AUTHORED";
  /** What it ultimately creates. The reason a reader is looking at this path. */
  readonly produces: Artifact;
  readonly steps: readonly LifecycleStep[];
  /** Whether the path has ever completed end to end in production, and the evidence. */
  readonly everCompleted: string;
}

// ---------------------------------------------------------------------------
// THE PATHS
// ---------------------------------------------------------------------------

/**
 * Path 1 — the hand-authored catalogue. The oldest path and the only one that has produced
 * most of the live corpus.
 */
const CATALOGUE: LifecyclePath = {
  id: "P1-CATALOGUE",
  title: "Hand-authored SKILL_CORPUS -> skill + skill_alias",
  origin: "HAND_AUTHORED",
  produces: "skill_alias",
  everCompleted:
    "Yes. 234 of 336 live skill_alias rows carry source='rvm', and all 22 ratified wedge " +
    "aliases are present and embedded (re-verified read-only 2026-08-26).",
  steps: [
    {
      id: "P1.1",
      what: "An engineer adds a SkillSeed (or a WedgeAliasProposal) to the committed catalogue",
      actor: "HUMAN",
      performedBy: "packages/taxonomy/src/skill-corpus.ts, wedge-aliases.ts",
      writes: "repository_file",
    },
    {
      id: "P1.2",
      what: "The owner sets ratified: true — TAX-0 gate (d), explicitly not automatable",
      actor: "HUMAN",
      performedBy: "packages/taxonomy/src/wedge-aliases.ts",
      writes: "repository_file",
    },
    {
      id: "P1.3",
      what: "Seed inserts skill + skill_alias rows; alias ids are deterministic in (skill_id, text, lang)",
      actor: "OFFLINE_RUNNER",
      performedBy: "pnpm db:seed:skills --apply",
      writes: "skill_alias",
      writerFile: "seed-skills.ts",
    },
    {
      id: "P1.4",
      what: "Vectors are backfilled — the row becomes visible to retrieval",
      actor: "OFFLINE_RUNNER",
      performedBy: "pnpm db:embed:skills",
      writes: "skill_alias",
      writerFile: "embed-skill-aliases.ts",
    },
  ],
};

/**
 * Path 2 — the model-drafted domain->skill batch. The only path that has ever added skills at
 * any scale, and the one whose input file is the coverage ceiling.
 */
const BATCH: LifecyclePath = {
  id: "P2-BATCH",
  title: "Model-drafted domain->skill batch -> skill + skill_alias + job_domain_skill",
  origin: "MODEL_DRAFT",
  produces: "job_domain_skill",
  everCompleted:
    "Once. One batch directory (2026-08-16) plus two remediations produced 106 skills and " +
    "244 edges; 197 skill_alias rows landed 2026-08-20.",
  steps: [
    {
      id: "P2.1",
      what: "Prompts are emitted for the domains in sample-domains.jsonl — a 28-row hand-picked file",
      actor: "OFFLINE_RUNNER",
      performedBy: "pnpm db:gen:domain-skills --emit-prompts",
      writes: "repository_file",
    },
    {
      id: "P2.2",
      what: "An operator runs the prompts against a model out-of-band and saves raw-responses.jsonl",
      actor: "MODEL",
      performedBy: "(out of process — packages/db holds no provider key)",
      writes: "repository_file",
    },
    {
      id: "P2.3",
      what: "Ingest validates structurally, then semantically; a BLOCK writes blocked-*.jsonl and exits 1",
      actor: "OFFLINE_RUNNER",
      performedBy: "pnpm db:gen:domain-skills --ingest",
      writes: "repository_file",
    },
    {
      id: "P2.4",
      what: "A person reads the accepted-*.jsonl diff and commits it into data/taxonomy/",
      actor: "HUMAN",
      performedBy: "git",
      writes: "repository_file",
    },
    {
      id: "P2.5",
      what: "Seed writes skill, skill_alias and job_domain_skill; every write is a conditional upsert",
      actor: "OFFLINE_RUNNER",
      performedBy: "pnpm db:seed:domain-skills --apply",
      writes: "job_domain_skill",
      writerFile: "seed-domain-skills.ts",
    },
    {
      id: "P2.6",
      what: "Vectors are backfilled",
      actor: "OFFLINE_RUNNER",
      performedBy: "pnpm db:embed:skills",
      writes: "skill_alias",
      writerFile: "embed-skill-aliases.ts",
    },
  ],
};

/**
 * Path 3 — the SKILL growth loop. The one the architecture calls "learning", and the only
 * path whose origin is a real worker utterance that failed to resolve.
 */
const SKILL_GROWTH: LifecyclePath = {
  id: "P3-SKILL-GROWTH",
  title: "Below-floor skill phrase -> clustered proposal -> ratified wedge alias",
  origin: "WORKER_UTTERANCE",
  produces: "skill_alias",
  everCompleted:
    "No. The queue holds 7 skill-scope rows (2026-08-26); the runner has never been run " +
    "against production and no proposal has ever been generated from it.",
  steps: [
    {
      id: "P3.1",
      what: "Canonicalization misses; the PSEUDONYMIZED phrase is upserted and an event is emitted",
      actor: "RUNTIME",
      performedBy: "ai-service canonicalize_skill -> api POST /internal/skills/unresolved",
      writes: "unresolved_phrase",
    },
    {
      id: "P3.2",
      what: "Open rows are embedded and clustered against the skill_alias anchors; a proposal needs cluster>=2 OR summed count>=3",
      actor: "OFFLINE_RUNNER",
      performedBy: "pnpm db:growth:cluster",
      writes: "review_packet",
    },
    {
      id: "P3.3",
      what: "A person reads the packet and pastes accepted entries into wedge-aliases.ts",
      actor: "HUMAN",
      performedBy: "packages/taxonomy/src/wedge-aliases.ts",
      writes: "repository_file",
    },
    {
      id: "P3.4",
      what: "The owner sets ratified: true",
      actor: "HUMAN",
      performedBy: null,
      writes: "repository_file",
    },
    {
      id: "P3.5",
      what: "Seed + embed, exactly as Path 1",
      actor: "OFFLINE_RUNNER",
      performedBy: "pnpm db:seed:skills --apply && pnpm db:embed:skills",
      writes: "skill_alias",
      writerFile: "seed-skills.ts",
    },
  ],
};

/**
 * Path 4 — the OCCUPATION growth loop. Structurally the same shape, a different vocabulary,
 * and the only loop with production rows waiting in it.
 */
const OCCUPATION_GROWTH: LifecyclePath = {
  id: "P4-OCCUPATION-GROWTH",
  title: "Unmatched occupation phrase -> ranked packet -> rvm alias",
  origin: "WORKER_UTTERANCE",
  produces: "job_domain_alias",
  everCompleted:
    "No. 40 occupation-scope rows are queued (2026-08-26) and every one has count = 1, " +
    "below the default promotion floor of 3, so the runner would emit zero proposals.",
  steps: [
    {
      id: "P4.1",
      what: "L0-L3 occupation retrieval finds nothing; IdentifyService records the pseudonymized phrase",
      actor: "RUNTIME",
      performedBy: "api IdentifyService -> OccupationService.recordUnresolved",
      writes: "unresolved_phrase",
    },
    {
      id: "P4.2",
      what: "Rows at count >= 3 are ranked into a packet. No embedding and no clustering — retrieval already failed over the whole catalogue",
      actor: "OFFLINE_RUNNER",
      performedBy: "pnpm db:growth:occupation",
      writes: "review_packet",
    },
    {
      id: "P4.3",
      what: "A person fills in the deliberately blank job_domain_id and appends to rvm-aliases.jsonl",
      actor: "HUMAN",
      performedBy: "packages/db/data/job-domains/rvm-aliases.jsonl",
      writes: "repository_file",
    },
    {
      id: "P4.4",
      what: "Seed, normalize, embed — the alias resolves at L0 from then on",
      actor: "OFFLINE_RUNNER",
      performedBy: "pnpm db:seed:domains --apply && db:normalize:aliases --apply && db:embed:domains",
      writes: "job_domain_alias",
      writerFile: "seed-job-domains.ts",
    },
  ],
};

/**
 * Path 5 — mining the chat transcript. The highest-fidelity source there is, and the only
 * generator whose input is what a worker actually typed rather than what a model guessed.
 *
 * Note the `produces`: this path grows the OCCUPATION vocabulary. It is frequently spoken of
 * as the alias-learning path for skills, and it is not one — there is no skill-side miner.
 */
const MINING: LifecyclePath = {
  id: "P5-MINING",
  title: "Inbound chat n-grams -> occupation alias candidates",
  origin: "WORKER_UTTERANCE",
  produces: "job_domain_alias",
  everCompleted:
    "The generator now runs (232 inbound messages, 2026-08-26) but no candidate has ever " +
    "been accepted into rvm-aliases.jsonl from it.",
  steps: [
    {
      id: "P5.1",
      what: "Every inbound message is pseudonymized (fail-closed, stdlib regex, zero AI spend)",
      actor: "OFFLINE_RUNNER",
      performedBy: "pnpm db:mine:aliases -> ai-service POST /pseudonymize",
      writes: "nothing",
    },
    {
      id: "P5.2",
      what: "Messages that already resolve are dropped; the rest yield 1-3 token spans, ranked by distinct sessions",
      actor: "OFFLINE_RUNNER",
      performedBy: "pnpm db:mine:aliases",
      writes: "review_packet",
    },
    {
      id: "P5.3",
      what: "A person maps each accepted phrase to a job_domain_id — the business decision no count can make",
      actor: "HUMAN",
      performedBy: "packages/db/data/job-domains/rvm-aliases.jsonl",
      writes: "repository_file",
    },
    {
      id: "P5.4",
      what: "Seed, normalize, embed",
      actor: "OFFLINE_RUNNER",
      performedBy: "pnpm db:seed:domains --apply && db:normalize:aliases --apply && db:embed:domains",
      writes: "job_domain_alias",
      writerFile: "seed-job-domains.ts",
    },
  ],
};

export const LIFECYCLE: readonly LifecyclePath[] = [
  CATALOGUE,
  BATCH,
  SKILL_GROWTH,
  OCCUPATION_GROWTH,
  MINING,
];

// ---------------------------------------------------------------------------
// DERIVED FACTS
// ---------------------------------------------------------------------------

/**
 * The leading run of steps that need no person.
 *
 * THE POINT OF THE WHOLE FILE. A path whose automatic prefix stops before its first table
 * write cannot improve coverage between reviews, however much traffic arrives.
 */
export function automaticPrefix(path: LifecyclePath): readonly LifecycleStep[] {
  const stop = path.steps.findIndex((s) => s.actor === "HUMAN");
  return stop === -1 ? path.steps : path.steps.slice(0, stop);
}

/** Every step a person must perform. Answers "is it one approval or several". */
export function humanGates(path: LifecyclePath): readonly LifecycleStep[] {
  return path.steps.filter((s) => s.actor === "HUMAN");
}

/**
 * Does the path reach WHAT IT EXISTS TO PRODUCE without a person?
 *
 * Not the same as "writes any table". Both growth loops fill `unresolved_phrase` unattended —
 * that is the queue doing its job — and neither adds a single alias without review. Conflating
 * the two reads as "the learning loop is automatic", which is the exact wrong conclusion: what
 * is automatic is the OBSERVING, and what is manual is the LEARNING.
 */
export function reachesProductAutomatically(path: LifecyclePath): boolean {
  return automaticPrefix(path).some((s) => s.writes === path.produces);
}

/**
 * Paths that write their product without a person anywhere in the chain.
 *
 * Expected to be EMPTY, and asserted so. If this ever returns a path, an ingestion route has
 * become fully automatic and CLAUDE.md §3 ("AI never owns business decisions") needs re-reading
 * against it — the mapping from a phrase to a canonical id is exactly such a decision.
 */
export function fullyAutomaticPaths(
  paths: readonly LifecyclePath[] = LIFECYCLE,
): readonly LifecyclePath[] {
  return paths.filter((p) => humanGates(p).length === 0);
}

/** Paths whose origin is a real worker utterance — the ones that could respond to traffic. */
export function trafficDrivenPaths(
  paths: readonly LifecyclePath[] = LIFECYCLE,
): readonly LifecyclePath[] {
  return paths.filter((p) => p.origin === "WORKER_UTTERANCE");
}

export interface LifecycleProblem {
  readonly id: string;
  readonly problem: string;
}

/**
 * Check the model against the source tree.
 *
 * `discoveredWriters` is injected rather than read here so the module stays IO-free and the
 * test can drive it both ways: with the real writer set, and with a fabricated one that proves
 * the check can actually fail.
 */
export function validateLifecycle(
  paths: readonly LifecyclePath[],
  discoveredWriters: ReadonlySet<string>,
): LifecycleProblem[] {
  const problems: LifecycleProblem[] = [];
  const ids = new Set<string>();

  for (const p of paths) {
    if (ids.has(p.id)) problems.push({ id: p.id, problem: "duplicate path id" });
    ids.add(p.id);
    if (p.steps.length === 0) problems.push({ id: p.id, problem: "path with no steps" });

    // A path must actually reach what it claims to produce. Otherwise "produces skill_alias"
    // is an aspiration and a reader cannot tell the difference.
    if (p.produces !== "nothing" && !p.steps.some((s) => s.writes === p.produces)) {
      problems.push({ id: p.id, problem: `claims to produce ${p.produces} but no step writes it` });
    }

    for (const s of p.steps) {
      if (ids.has(s.id)) problems.push({ id: s.id, problem: "duplicate step id" });
      ids.add(s.id);

      // A runner that writes a table must name the file that holds the write, and that file
      // must be one the source scan actually found.
      const writesTable = s.writes !== "repository_file" && s.writes !== "review_packet" && s.writes !== "nothing";
      if (s.actor === "OFFLINE_RUNNER" && writesTable) {
        if (s.writerFile === undefined) {
          problems.push({ id: s.id, problem: `writes ${s.writes} but names no writer file` });
        } else if (!discoveredWriters.has(s.writerFile)) {
          problems.push({
            id: s.id,
            problem: `names writer ${s.writerFile}, which the source scan did not find`,
          });
        }
      }
      // Only a runner or the request path can write a table. A person writes files; a model
      // writes proposals. Marking a table write as HUMAN would hide an unguarded runner.
      if ((s.actor === "HUMAN" || s.actor === "MODEL") && writesTable) {
        problems.push({ id: s.id, problem: `actor ${s.actor} cannot write ${s.writes} directly` });
      }
    }
  }
  return problems;
}
