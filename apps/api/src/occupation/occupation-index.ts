/**
 * The in-process occupation index — everything L0/L1 retrieval needs, in one immutable
 * snapshot, built without touching the database.
 *
 * WHY A SNAPSHOT AND NOT A LIVE LOOKUP. L0 and L1 are the two layers whose entire value is
 * that they cost nothing: the plan budgets ~2 ms each and targets ≥45% of turns resolving
 * there, precisely so most interviews never pay for a trigram scan or an embedding call. A
 * database round trip per span candidate would spend exactly what the layers exist to save,
 * and there are dozens of span candidates in one sentence.
 *
 * WHY IMMUTABLE. The snapshot is REPLACED on refresh, never mutated. A resolve that runs
 * during a rebuild reads the old snapshot start to finish and returns a coherent answer
 * from a slightly stale catalogue — which is correct and boring. Mutating in place would
 * let a turn see a half-built index and silently return nothing, which the caller cannot
 * distinguish from "this worker's trade is not in the catalogue" and would record as an
 * unresolved phrase. Wrong, plausible, and invisible.
 *
 * WHY FAMILIES ARE RESOLVED AT BUILD TIME. The auto-pin margin is computed at FAMILY level
 * (see `occupation-calibration.ts`), so every candidate needs its family before the
 * decision is made. Resolving per candidate per turn is four-plus database hits on the chat
 * hot path; resolving all 4,071 once per refresh is a few milliseconds of arithmetic over
 * data already in memory.
 *
 * PRIVACY: public occupation reference data only. No worker text is stored here — the
 * utterance is an argument, never a field.
 */
import { buildSpanIndex, type SpanIndex } from "@badabhai/profiling-lexicon";
import { resolveFamily, type ResolvableBinding } from "@badabhai/db";

/** One alias row, as the index needs to see it. */
export interface IndexAliasRow {
  readonly jobDomainId: string;
  readonly text: string;
}

/** One occupation row, as the index needs to see it. */
export interface IndexDomainRow {
  readonly jobDomainId: string;
  readonly labelEn: string;
  readonly labelHi: string | null;
  readonly iscoUnitCode: string | null;
}

/**
 * An occupation as retrieval hands it onward.
 *
 * `chipLabel` IS NEVER `labelEn`, and that is a product rule with teeth. NCO's official
 * title for unit 7223 is "Metal Working Machine Tool Setters and Operators" — nobody has
 * ever said that out loud, and a disambiguation chip becomes the worker's answer of record
 * verbatim. `labelHi` first because it is the language of the conversation; otherwise the
 * shortest alias, because the alias corpus IS the worker's own vocabulary by construction.
 * `labelEn` stays on the record for logs and ops, where a stable official name is the point.
 */
export interface IndexedDomain {
  readonly jobDomainId: string;
  readonly labelEn: string;
  readonly labelHi: string | null;
  readonly iscoUnitCode: string | null;
  readonly familyId: string | null;
  readonly chipLabel: string;
}

export interface OccupationSnapshot {
  /**
   * Changes whenever the catalogue changes. Pinned per conversation, so a refresh that
   * lands mid-interview cannot move the ground under a worker who is halfway through.
   */
  readonly catalogVersion: string;
  readonly spans: SpanIndex;
  readonly domains: ReadonlyMap<string, IndexedDomain>;
  readonly aliasCount: number;
}

/**
 * Pick the chip label for one domain.
 *
 * TIES ARE BROKEN LEXICOGRAPHICALLY, NOT BY ARRIVAL ORDER, and this is a multi-instance
 * correctness rule rather than tidiness. Every API instance builds its own snapshot from
 * its own query, and Postgres does not promise row order without an ORDER BY. Two
 * instances that picked "arrival order" could offer two different chips for the same
 * occupation in the same conversation, and the chip is what gets recorded as the answer.
 */
export function pickChipLabel(labelHi: string | null, aliases: readonly string[], labelEn: string): string {
  if (labelHi !== null && labelHi.trim().length > 0) return labelHi;
  let best: string | null = null;
  for (const alias of aliases) {
    const candidate = alias.trim();
    if (candidate.length === 0) continue;
    if (best === null) {
      best = candidate;
      continue;
    }
    if (candidate.length < best.length || (candidate.length === best.length && candidate < best)) {
      best = candidate;
    }
  }
  return best ?? labelEn;
}

/**
 * Build a snapshot from catalogue rows. Pure: no database, no clock, no environment.
 *
 * ONLY DOMAINS THAT APPEAR IN `domains` ARE INDEXED. An alias whose domain was filtered
 * out by the caller's query (not selectable, not active, shadowed) is dropped here rather
 * than indexed against a domain the snapshot cannot describe — a hit that resolves to an
 * id with no metadata would surface as a chip with no label.
 */
export function buildOccupationSnapshot(input: {
  readonly catalogVersion: string;
  readonly domains: readonly IndexDomainRow[];
  readonly aliases: readonly IndexAliasRow[];
  readonly bindings: readonly ResolvableBinding[];
}): OccupationSnapshot {
  const aliasesByDomain = new Map<string, string[]>();
  const known = new Set(input.domains.map((d) => d.jobDomainId));

  let aliasCount = 0;
  for (const alias of input.aliases) {
    if (!known.has(alias.jobDomainId)) continue;
    const at = aliasesByDomain.get(alias.jobDomainId);
    if (at === undefined) aliasesByDomain.set(alias.jobDomainId, [alias.text]);
    else at.push(alias.text);
    aliasCount++;
  }

  const domains = new Map<string, IndexedDomain>();
  for (const d of input.domains) {
    const aliases = aliasesByDomain.get(d.jobDomainId) ?? [];
    const family = resolveFamily(input.bindings, {
      jobDomainId: d.jobDomainId,
      iscoUnitCode: d.iscoUnitCode,
    });
    domains.set(d.jobDomainId, {
      jobDomainId: d.jobDomainId,
      labelEn: d.labelEn,
      labelHi: d.labelHi,
      iscoUnitCode: d.iscoUnitCode,
      familyId: family?.familyId ?? null,
      chipLabel: pickChipLabel(d.labelHi, aliases, d.labelEn),
    });
  }

  const spans = buildSpanIndex(
    [...aliasesByDomain].map(([id, aliases]) => ({ id, aliases })),
  );

  return { catalogVersion: input.catalogVersion, spans, domains, aliasCount };
}
