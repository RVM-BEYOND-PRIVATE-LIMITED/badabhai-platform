/**
 * The glue between the S3-D shadow report and the replay's corpus.
 *
 * Deliberately thin. Everything here delegates to `replay-path-a` / `path-a-replay` rather than
 * re-deriving it, because a second answer to "what can Path A see" is exactly the class of
 * defect this phase keeps finding — `COVERAGE_ONLY_CATEGORIES` in three places, `isScoreable`
 * honoured by two of five consumers, `hostClass` in two modules. One definition, imported.
 */
import { join } from "node:path";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import {
  buildVariant,
  pathACandidates,
  pathBCandidates,
  rankAliases,
  rankSkillsFromAliases,
  LEGACY_ANCHOR_SKILL_DOMAIN,
  RETRIEVABLE_SKILL_STATUSES,
  PRE_PROMOTION_STATUSES,
  type CorpusInput,
  type ReplayCorpus,
} from "./path-a-replay";
import type { SkillStatus } from "@badabhai/taxonomy";
import { loadCorpusInput, loadVectors } from "./replay-path-a";
import { DEFAULT_CACHE_DIR } from "./taxonomy-embed-cache";
import { EMBEDDING_MODEL } from "./taxonomy-alias-experiment";
import type { ShadowCase } from "./s3d-shadow-report";

const sha = (t: string): string => createHash("sha256").update(t, "utf8").digest("hex");

export interface ShadowInputs {
  /** The corpus as it will be AFTER S3-D — the state the shadow is asking about. */
  readonly corpus: ReplayCorpus;
  /** Query vectors from the gitignored cache. Offline: a miss is skipped, never fetched. */
  readonly queryVectors: ReadonlyMap<string, number[]>;
  readonly input: CorpusInput;
}

/** Query vectors from the local cache. No provider call, ever. */
export function cachedQueryVectors(): Map<string, number[]> {
  const out = new Map<string, number[]>();
  const file = join(DEFAULT_CACHE_DIR, "vectors.json");
  if (!existsSync(file)) return out;
  const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, number[]>;
  const prefix = `${EMBEDDING_MODEL}:`;
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith(prefix)) out.set(k.slice(prefix.length), v);
  }
  return out;
}

export function buildReplayInputs(vectorFile: string): ShadowInputs {
  const input = loadCorpusInput(loadVectors(vectorFile));
  // `as_applied` — the corpus with the merges applied, which is the state S3-D produces. The
  // shadow's question is "what would the switch do", not "what does today's corpus do".
  return { corpus: buildVariant(input, "as_applied").corpus, queryVectors: cachedQueryVectors(), input };
}

/**
 * Run both retrieval paths over the same query and pair the answers.
 *
 * `k = 5` and `RETRIEVABLE_SKILL_STATUSES` (active only) because the shadow must model what
 * PRODUCTION would serve, not what a pre-promotion experiment can see. A shadow measured with
 * provisional skills included would understate Path A's empty-rate — the first abort signal.
 */
/**
 * The statuses a run treats as retrievable.
 *
 * `production` is the only one that describes anything real. `if_promoted` includes
 * `provisional` and answers ONE counterfactual question the default run cannot: **how much of
 * Path A's empty-rate would promotion actually remove?** Without it the report can say "do not
 * flip yet" and cannot say what would change that, so the promotion decision has no number
 * attached to it and stays a matter of opinion.
 *
 * It is NOT a relaxation of anything. `RETRIEVABLE_SKILL_STATUSES` is untouched, no default
 * changes, and the report labels the counterfactual on every line it prints — because the one
 * way this becomes harmful is somebody quoting the optimistic figure as the current state.
 */
export type ShadowSemantics = "production" | "if_promoted";

export function statusesFor(semantics: ShadowSemantics): readonly SkillStatus[] {
  // PRE_PROMOTION_STATUSES already names exactly this set and is what `db:replay:path-a
  // --include-provisional` uses, so the counterfactual here and the replay's agree by
  // construction rather than by two lists happening to match.
  return semantics === "production" ? RETRIEVABLE_SKILL_STATUSES : PRE_PROMOTION_STATUSES;
}

export function runBothPaths(
  inputs: ShadowInputs,
  cases: readonly { case_id: string; query: string; job_domain_id: string }[],
  k = 5,
  semantics: ShadowSemantics = "production",
): ShadowCase[] {
  const statuses = statusesFor(semantics);
  const out: ShadowCase[] = [];
  for (const c of cases) {
    const q = inputs.queryVectors.get(sha(c.query));
    // A case with no cached vector is SKIPPED, not scored as empty. Counting a cache miss as
    // "Path A returned nothing" would manufacture the exact signal the report exists to measure.
    if (q === undefined) continue;

    const a = rankSkillsFromAliases(
      rankAliases(q, pathACandidates(inputs.corpus, c.job_domain_id, statuses), k),
    );
    const b = rankSkillsFromAliases(
      rankAliases(q, pathBCandidates(inputs.corpus, LEGACY_ANCHOR_SKILL_DOMAIN, statuses), k),
    );
    out.push({
      caseId: c.case_id,
      jobDomainId: c.job_domain_id,
      aTop1: a[0]?.skillId ?? null,
      bTop1: b[0]?.skillId ?? null,
      aScore: a[0]?.score ?? null,
      bScore: b[0]?.score ?? null,
    });
  }
  return out;
}

/**
 * WHY Path A has the candidate pool it has — reported, not guessed.
 *
 * This exists because the report guessed, and guessed wrong. Its headline said Path A returns
 * nothing "because most canonical skills are still 'provisional'", and therefore that S3-D
 * "cannot be flipped before promotion". Measured on 2026-08-20 with `--if-promoted`, promotion
 * changes NOTHING: identical empty-rate, identical top-1 agreement, identical score deltas.
 *
 * The reason is here. A skill needs two things to be rankable — a retrievable STATUS and an
 * alias with a VECTOR — and only the first is what promotion moves. Of 111 provisional skills
 * exactly ONE has an embedded alias (1 of 226 aliases), so promoting all of them adds one
 * candidate. The binding constraint is embedding coverage, which is a provider run and a
 * seed, not a status flip.
 *
 * Pure, so the composition can be asserted in a test rather than read off a console.
 */
export interface PoolComposition {
  readonly skillsByStatus: Readonly<Record<string, number>>;
  /** Per status: aliases that have a vector, and the total. */
  readonly aliasVectors: Readonly<Record<string, { readonly embedded: number; readonly total: number }>>;
  /** Skills that are provisional AND have at least one embedded alias — what promotion adds. */
  readonly promotionWouldAdd: number;
  readonly edges: number;
}

export function poolComposition(input: CorpusInput): PoolComposition {
  const statusOf = new Map(input.skills.map((s) => [s.skillId, s.status]));
  const skillsByStatus: Record<string, number> = {};
  for (const s of input.skills) skillsByStatus[s.status] = (skillsByStatus[s.status] ?? 0) + 1;

  const aliasVectors: Record<string, { embedded: number; total: number }> = {};
  for (const a of input.aliases) {
    const st = statusOf.get(a.skillId) ?? "<unknown>";
    const c = (aliasVectors[st] ??= { embedded: 0, total: 0 });
    c.total += 1;
    if (a.vector !== null) c.embedded += 1;
  }

  const rankableProvisional = new Set(
    input.aliases
      .filter((a) => statusOf.get(a.skillId) === "provisional" && a.vector !== null)
      .map((a) => a.skillId),
  );

  return { skillsByStatus, aliasVectors, promotionWouldAdd: rankableProvisional.size, edges: input.edges.length };
}
