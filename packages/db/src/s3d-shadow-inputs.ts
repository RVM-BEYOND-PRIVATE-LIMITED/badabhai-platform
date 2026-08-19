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
  type CorpusInput,
  type ReplayCorpus,
} from "./path-a-replay";
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
export function runBothPaths(
  inputs: ShadowInputs,
  cases: readonly { case_id: string; query: string; job_domain_id: string }[],
  k = 5,
): ShadowCase[] {
  const out: ShadowCase[] = [];
  for (const c of cases) {
    const q = inputs.queryVectors.get(sha(c.query));
    // A case with no cached vector is SKIPPED, not scored as empty. Counting a cache miss as
    // "Path A returned nothing" would manufacture the exact signal the report exists to measure.
    if (q === undefined) continue;

    const a = rankSkillsFromAliases(
      rankAliases(q, pathACandidates(inputs.corpus, c.job_domain_id, RETRIEVABLE_SKILL_STATUSES), k),
    );
    const b = rankSkillsFromAliases(
      rankAliases(q, pathBCandidates(inputs.corpus, LEGACY_ANCHOR_SKILL_DOMAIN, RETRIEVABLE_SKILL_STATUSES), k),
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
