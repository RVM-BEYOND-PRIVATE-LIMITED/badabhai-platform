/**
 * D-7C-1 — the duplicate-text cleanup, as a set of RULES rather than a script.
 *
 * ===========================================================================
 * THE DEFECT
 * ===========================================================================
 * TD-01 merged `skill_gdt_reading` and `skill_cad_interpretation` into `skill_drawing_reading`
 * by COPYING their alias texts onto the successor and leaving the originals in place. The
 * corpus therefore holds nine phrases on two skills each, with byte-identical vectors.
 *
 * A duplicated text is not a near-miss that a threshold can arbitrate. Both rows score exactly
 * 1.0000 against the query, so **no floor can separate them** and the winner is whichever row
 * the index happens to return first. The assignment is nondeterministic between a live skill
 * and a corpus-deprecated one, and it is invisible: nothing logs a tie.
 *
 * ===========================================================================
 * WHAT THIS MODULE IS AND IS NOT
 * ===========================================================================
 * It is the classification and the safety rules. It holds no database handle, performs no IO
 * beyond reading two committed JSON files, and cannot mutate anything.
 *
 * It deliberately does **not** decide which skill keeps a contested text. Election is a
 * taxonomy decision with a reviewer (`alias-exclusions.ts` says so, and the four already-decided
 * rows carry `decided_by: "product owner, 2026-08-21"`). The four undecided rows below are
 * carried as a **PROPOSAL** in a separate file, marked pending, and wired into nothing.
 *
 * ===========================================================================
 * THE ONE RULE THAT MATTERS MORE THAN THE ELECTION
 * ===========================================================================
 * De-electing every holder of a phrase removes the phrase from retrieval altogether. That is
 * strictly worse than a nondeterministic winner — a coin flip between two related skills still
 * resolves; an orphaned phrase resolves to nothing, and the corpus no longer contains the
 * worker's own words. `orphanedPhrases` finds that condition before a runner can create it, and
 * it is checked against the LIVE rows, not against the file's own beliefs.
 */
import { existsSync, readFileSync } from "node:fs";

import type { AliasExclusion } from "./alias-exclusions";

/** One `skill_alias` row inside a duplicate-text group, as production actually holds it. */
export interface DuplicateMember {
  readonly alias_id: string;
  readonly skill_id: string;
  readonly text: string;
  readonly domain_id: string | null;
  readonly embedded: boolean;
  readonly skill_status: string;
}

/** Every row whose normalized text is shared with a row on a different skill. */
export interface DuplicateGroup {
  /** `lower(btrim(text))` — the key rows collide on. */
  readonly norm: string;
  readonly members: readonly DuplicateMember[];
}

/**
 * What still has to happen to a group.
 *
 * `LATENT` is the one worth reading twice: the group is not a collision **today** only because
 * one holder sits on a non-active skill or carries no vector. Promotion or a backfill makes it
 * one, with no code change and no test failing. It is a scheduled defect, not an absent one.
 */
export type GroupDisposition =
  | "DECIDED_COMPLETE"
  | "DECIDED_PARTIAL"
  | "UNDECIDED"
  | "LATENT"
  | "WOULD_ORPHAN";

/** A member is live — i.e. reachable by retrieval — only if it is embedded on an active skill. */
export const isLive = (m: DuplicateMember): boolean =>
  m.embedded && m.skill_status === "active";

/**
 * Classify one group against a set of de-elected alias ids.
 *
 * Pure, and ordered so the dangerous answers win: an election that would orphan the phrase is
 * reported as `WOULD_ORPHAN` even when the file looks internally consistent, because "the file
 * agrees with itself" is exactly the state a stale exclusion list is in.
 */
export function classifyDuplicateGroup(
  group: DuplicateGroup,
  excludedIds: ReadonlySet<string>,
): GroupDisposition {
  const live = group.members.filter(isLive);
  const survivors = live.filter((m) => !excludedIds.has(m.alias_id));
  const distinctSurvivingSkills = new Set(survivors.map((m) => m.skill_id));

  if (live.length > 0 && survivors.length === 0) return "WOULD_ORPHAN";
  // Fewer than two live holders on DIFFERENT skills is not a live collision. Counting rows
  // rather than skills would mis-report two aliases of the same skill as a collision.
  if (new Set(live.map((m) => m.skill_id)).size < 2) return "LATENT";
  if (live.length === survivors.length) return "UNDECIDED";
  return distinctSurvivingSkills.size === 1 ? "DECIDED_COMPLETE" : "DECIDED_PARTIAL";
}

/**
 * Phrases that would stop existing in retrieval if the exclusions were applied as given.
 *
 * Checked against LIVE rows so a phrase whose only other holder is provisional or unembedded
 * counts as orphaned — because after the write it would be, and the write is what we are
 * deciding about.
 */
export function orphanedPhrases(
  groups: readonly DuplicateGroup[],
  excludedIds: ReadonlySet<string>,
): readonly string[] {
  return groups
    .filter((g) => classifyDuplicateGroup(g, excludedIds) === "WOULD_ORPHAN")
    .map((g) => g.norm)
    .sort();
}

/**
 * Phrases that survive globally but stop existing **inside a legacy slug**.
 *
 * The global check is not enough, and the four proposed elections are precisely why. Path B
 * filters `sa.domain_id = $1`, so a scope is its own retrieval universe. `CAD` is held by
 * `skill_cad_interpretation` in `cnc-programming` and by `skill_drawing_reading` in
 * `cnc-machining` — two different universes. De-electing the first leaves `CAD` alive globally
 * and **absent from `cnc-programming` entirely**, which the global rule reports as a clean
 * resolution and a caller querying that slug experiences as the word disappearing.
 *
 * Returns `"<norm> @ <domain_id>"` pairs, so a reader sees which slug pays.
 */
export function scopeOrphanedPhrases(
  groups: readonly DuplicateGroup[],
  excludedIds: ReadonlySet<string>,
): readonly string[] {
  const out: string[] = [];
  for (const g of groups) {
    const byScope = new Map<string, DuplicateMember[]>();
    for (const m of g.members.filter(isLive)) {
      const k = m.domain_id ?? "(null)";
      byScope.set(k, [...(byScope.get(k) ?? []), m]);
    }
    for (const [scope, ms] of byScope) {
      if (ms.every((m) => excludedIds.has(m.alias_id))) out.push(`${g.norm} @ ${scope}`);
    }
  }
  return out.sort();
}

/**
 * Groups that are still nondeterministic after the given elections are applied.
 *
 * This is the number the cleanup exists to drive to zero, and it is the honest one: a group
 * counts as unresolved whether nobody has ruled on it (`UNDECIDED`) or somebody ruled on only
 * half of it (`DECIDED_PARTIAL`).
 */
export function unresolvedGroups(
  groups: readonly DuplicateGroup[],
  excludedIds: ReadonlySet<string>,
): readonly DuplicateGroup[] {
  return groups.filter((g) => {
    const d = classifyDuplicateGroup(g, excludedIds);
    return d === "UNDECIDED" || d === "DECIDED_PARTIAL";
  });
}

// ---------------------------------------------------------------------------
// THE PROPOSAL
// ---------------------------------------------------------------------------

/**
 * The proposed D-7C-1 elections, held in a file that no runner reads.
 *
 * Kept OUT of `decollided-aliases.json` on purpose. That file is ratified input: `db:embed:skills`
 * seeds its blocked-id list from it and `db:decollide:aliases` writes from it. Adding an
 * unratified proposal there would change the behaviour of two production runners as a side
 * effect of writing a report — the exact class of quiet scope creep this programme keeps finding.
 */
export const PROPOSED_CLEANUP_PATH = "data/taxonomy/proposed-d7c1-cleanup.json";

export interface CleanupProposalFile {
  readonly kind: "alias-cleanup-proposal";
  readonly decision: string;
  readonly owner_decision: "PENDING" | "RATIFIED";
  readonly why: string;
  readonly wired_into: string;
  readonly proposals: readonly AliasExclusion[];
}

/**
 * Load the proposal. Fail closed on anything that would make it read as ratified.
 *
 * A proposal file that has quietly become `RATIFIED` without moving into
 * `decollided-aliases.json` would be a third source of truth, so the loader refuses it: the
 * only legitimate way to ratify is to move the rows into the file the runners actually read.
 */
export function parseCleanupProposal(raw: string): CleanupProposalFile {
  const doc = JSON.parse(raw) as Partial<CleanupProposalFile>;
  if (doc.kind !== "alias-cleanup-proposal") {
    throw new Error(
      `[alias-cleanup-plan] wrong kind: expected "alias-cleanup-proposal", got ${JSON.stringify(doc.kind)}`,
    );
  }
  if (doc.owner_decision !== "PENDING") {
    throw new Error(
      `[alias-cleanup-plan] owner_decision is ${JSON.stringify(doc.owner_decision)}. ` +
        `A ratified election belongs in decollided-aliases.json, which is what the runners read; ` +
        `leaving it here would create a second, unread source of truth.`,
    );
  }
  if (!Array.isArray(doc.proposals)) {
    throw new Error(`[alias-cleanup-plan] "proposals" must be an array`);
  }
  return doc as CleanupProposalFile;
}

export function loadCleanupProposal(
  path: string = PROPOSED_CLEANUP_PATH,
): readonly AliasExclusion[] {
  if (!existsSync(path)) return [];
  return parseCleanupProposal(readFileSync(path, "utf8")).proposals;
}

// ---------------------------------------------------------------------------
// THE SCENARIOS
// ---------------------------------------------------------------------------

/**
 * The three states worth measuring, in the order they can actually be reached.
 *
 * S1 exists as its own scenario because the four 2026-08-21 elections are **ratified and
 * unapplied**. Reporting only S0 and S2 would blur an authorised write that is merely owed
 * together with an unauthorised one that is not.
 */
export type ScenarioId =
  | "S0_TODAY"
  | "S1_RATIFIED_APPLIED"
  | "S2_RATIFIED_PLUS_PROPOSED"
  | "S3_PLUS_D7C_DEPRECATION";

export interface Scenario {
  readonly id: ScenarioId;
  readonly label: string;
  readonly excluded: readonly string[];
}

export function buildScenarios(
  ratified: readonly AliasExclusion[],
  proposed: readonly AliasExclusion[],
  d7cDeprecatedAliasIds: readonly string[] = [],
): readonly Scenario[] {
  const r = ratified.map((x) => x.alias_id);
  const p = proposed.map((x) => x.alias_id);
  return [
    { id: "S0_TODAY", label: "production as it stands", excluded: [] },
    {
      id: "S1_RATIFIED_APPLIED",
      label: `the ${r.length} elections ratified 2026-08-21, applied`,
      excluded: r,
    },
    {
      id: "S2_RATIFIED_PLUS_PROPOSED",
      label: `those ${r.length} plus the ${p.length} proposed D-7C-1 elections`,
      excluded: [...r, ...p],
    },
    {
      id: "S3_PLUS_D7C_DEPRECATION",
      label: `all elections AND the D-7C seed (${d7cDeprecatedAliasIds.length} subject aliases go dark)`,
      excluded: [...new Set([...r, ...p, ...d7cDeprecatedAliasIds])],
    },
  ];
}

/**
 * Deprecation and de-election are the SAME operation as far as retrieval is concerned.
 *
 * Retrieval admits a candidate on `s.status = 'active' AND sa.embedding IS NOT NULL`. NULLing a
 * vector fails the second conjunct; deprecating the skill fails the first. Either way the row
 * leaves both the probe and the candidate pool, so a scenario can model a deprecation exactly by
 * adding the skill's alias ids to the excluded set. No approximation is involved — which is why
 * the two decisions can be measured on one surface, and why they can silently combine.
 */
export const DEPRECATION_IS_EXCLUSION =
  "s.status = 'active' AND sa.embedding IS NOT NULL — deprecating a skill and NULLing its " +
  "vectors remove a row from retrieval by the same predicate, so one scenario can model both.";
