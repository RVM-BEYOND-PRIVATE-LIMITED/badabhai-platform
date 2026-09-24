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
import { buildSpanIndex, normalizeOccupationText, type SpanIndex } from "@badabhai/profiling-lexicon";
import { resolveFamily, type ResolvableBinding } from "@badabhai/db";

import { FAMILY_CHIP_LABELS } from "./family-chip-labels";

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
 * verbatim. It is also LATIN SCRIPT (#1679), the script every other line of the interview is
 * written in — see {@link pickChipLabel}. `labelEn` stays on the record for logs and ops,
 * where a stable official name is the point.
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
  /**
   * family id -> its display label (Latin first, see {@link familyDisplayLabel}). Kept on the
   * snapshot, not only folded into `chipLabel`, because the disambiguation collision guard
   * needs it as a QUALIFIER: when two chips share a shortest alias, the family label is what
   * tells them apart — and a qualifier is a chip label too, so it follows the same script rule.
   */
  readonly familyLabels: ReadonlyMap<string, string>;
  /** Rough retained size, in bytes. Observability for the plan's ~2–4 MB budget. */
  readonly approxBytes: number;
}

/**
 * Is every character of `text` Latin script (or script-neutral: digits, spaces, punctuation)?
 *
 * A SCRIPT TEST, NOT A DEVANAGARI TEST. The display rule (#1679) is "Latin", so a label in any
 * other script fails it — asking "does it contain Devanagari?" would let a Gurmukhi or Bengali
 * alias through the day the corpus grows one. `Common` and `Inherited` are the Unicode scripts of
 * digits, punctuation and combining accents, which every script shares.
 */
const NON_LATIN_SCRIPT = /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u;

export function isLatinScript(text: string): boolean {
  return !NON_LATIN_SCRIPT.test(text);
}

/** A family's two labels, as the chip picker sees them. */
export interface FamilyChipLabels {
  /** The committed Latin-script label, {@link FAMILY_CHIP_LABELS}. */
  readonly latin: string | null;
  /** `profiling_family.label_hi` — Devanagari. The last-resort fallback only. */
  readonly hi: string | null;
}

const NO_FAMILY: FamilyChipLabels = { latin: null, hi: null };

/**
 * Pick the chip label for one domain: the most worker-sounding label, in LATIN SCRIPT.
 *
 *   1. the shortest Latin-script alias that is NOT merely the English title again
 *   2. the FAMILY's Latin-script label ({@link FAMILY_CHIP_LABELS})
 *   3. then, only for a family with no Latin label — a catalogue that is ahead of this code —
 *      the Devanagari chain this function used to lead with: the occupation's own `label_hi`,
 *      the shortest remaining alias, the family's `label_hi`
 *   4. `label_en`, and only when a domain has no family and no alias of its own
 *
 * WHY LATIN FIRST (#1679, owner ruling 2026-09-24). Display script is romanized Hinglish: every
 * served pack string, the "Kuch aur" escape appended to every offer, and every persona line are
 * Latin, and Devanagari is for read-aloud only. This function used to rank by length alone, and
 * UTF-16 length is not script-neutral — `नक्शा` (5) beat `naksha` (6), so a CAD draughtsman was
 * offered `cad`, `नक्शा`, `Kuch aur`, and would have been recorded in Devanagari had they tapped.
 * Behind the aliases, the family's `label_hi` was the chip for 2,915 of 3,515 occupations.
 *
 * STEP 1 HAD TO LEARN TO SKIP `label_en`, AND STEP 2 HAD TO EXIST AT ALL. The first version
 * of this function took the shortest alias outright, on the reasoning that "aliases ARE the
 * worker's vocabulary by design". Measured against the seeded catalogue, that reasoning was
 * wrong for most of it: `label_hi` is NULL on all 4,071 occupations (plan finding F1), the
 * seeder writes `label_en` INTO the alias array, and 77% of occupations have exactly one
 * alias — the official English title. So the shortest alias WAS `label_en` for
 * **1,808 of 2,156** blue-collar occupations, and the "never `label_en`" guarantee this
 * function is named after was delivered for 348 of them.
 *
 * The family label is the right fallback rather than a convenient one. Chips are already
 * deduplicated to ONE PER FAMILY (see `decide`), so a chip is a family-level choice in the
 * first place — labelling it with the family's own name says exactly what the worker is being
 * asked to choose between. `family-chip-labels.test.ts` holds every corpus family to a Latin
 * label, so step 2 cannot silently become step 3.
 *
 * A LATIN FAMILY LABEL BEATS A DEVANAGARI ALIAS. Two occupations own only Devanagari aliases
 * (`धान`, `कुआं खोदना`). Their family's Latin label is coarser, but it is in the script of the
 * rest of the list; a finer word in the wrong script is exactly the mixed list this rule ends.
 *
 * TIES ARE BROKEN LEXICOGRAPHICALLY, NOT BY ARRIVAL ORDER, and this is a multi-instance
 * correctness rule rather than tidiness. Every API instance builds its own snapshot from
 * its own query, and Postgres does not promise row order without an ORDER BY. Two
 * instances that picked "arrival order" could offer two different chips for the same
 * occupation in the same conversation, and the chip is what gets recorded as the answer.
 */
export function pickChipLabel(
  labelHi: string | null,
  aliases: readonly string[],
  labelEn: string,
  family: FamilyChipLabels = NO_FAMILY,
): string {
  // Compared NORMALIZED, not raw. "Welder, Gas" and "welder gas" are the same title wearing
  // different punctuation, and a raw comparison would call the second one vernacular.
  const officialNorm = normalizeOccupationText(labelEn);
  const vernacular = aliases
    .map((alias) => alias.trim())
    .filter((alias) => alias.length > 0 && normalizeOccupationText(alias) !== officialNorm);

  return (
    shortest(vernacular.filter(isLatinScript)) ??
    nonBlank(family.latin) ??
    nonBlank(labelHi) ??
    shortest(vernacular) ??
    nonBlank(family.hi) ??
    labelEn
  );
}

/** The shortest string, ties broken lexicographically — see {@link pickChipLabel}. */
function shortest(candidates: readonly string[]): string | null {
  let best: string | null = null;
  for (const candidate of candidates) {
    if (
      best === null ||
      candidate.length < best.length ||
      (candidate.length === best.length && candidate < best)
    ) {
      best = candidate;
    }
  }
  return best;
}

function nonBlank(value: string | null | undefined): string | null {
  return value !== null && value !== undefined && value.trim().length > 0 ? value : null;
}

/**
 * The label a family is shown by, as a chip or as a collision qualifier: Latin first, the
 * catalogue's `label_hi` only for a family this code has no Latin label for.
 */
function familyDisplayLabel(family: FamilyChipLabels): string | null {
  return nonBlank(family.latin) ?? nonBlank(family.hi);
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
  /** `profiling_family.label_hi`, keyed by family id. The chip's last-resort fallback. */
  readonly familyLabels?: ReadonlyMap<string, string | null>;
  /**
   * The Latin-script family labels. Defaults to the committed {@link FAMILY_CHIP_LABELS} so
   * that no caller can forget them and quietly serve Devanagari; a test passes its own.
   */
  readonly familyChipLabels?: Readonly<Record<string, string>>;
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

  const latinLabels = input.familyChipLabels ?? FAMILY_CHIP_LABELS;
  const familyOf = (familyId: string): FamilyChipLabels => ({
    latin: Object.hasOwn(latinLabels, familyId) ? (latinLabels[familyId] ?? null) : null,
    hi: input.familyLabels?.get(familyId) ?? null,
  });

  const domains = new Map<string, IndexedDomain>();
  for (const d of input.domains) {
    const aliases = aliasesByDomain.get(d.jobDomainId) ?? [];
    const family = resolveFamily(input.bindings, {
      jobDomainId: d.jobDomainId,
      iscoUnitCode: d.iscoUnitCode,
    });
    const familyId = family?.familyId ?? null;
    domains.set(d.jobDomainId, {
      jobDomainId: d.jobDomainId,
      labelEn: d.labelEn,
      labelHi: d.labelHi,
      iscoUnitCode: d.iscoUnitCode,
      familyId,
      chipLabel: pickChipLabel(
        d.labelHi,
        aliases,
        d.labelEn,
        familyId === null ? NO_FAMILY : familyOf(familyId),
      ),
    });
  }

  const spans = buildSpanIndex(
    [...aliasesByDomain].map(([id, aliases]) => ({ id, aliases })),
  );

  // Only the families that actually HAVE a label. A null-valued entry would make the
  // collision guard's `?? null` fall through anyway, so storing them would be storing
  // nothing but ambiguity about whether a miss meant "absent" or "null".
  const familyLabels = new Map<string, string>();
  const familyIds = new Set([...(input.familyLabels?.keys() ?? []), ...Object.keys(latinLabels)]);
  for (const familyId of familyIds) {
    const label = familyDisplayLabel(familyOf(familyId));
    if (label !== null) familyLabels.set(familyId, label);
  }

  return {
    catalogVersion: input.catalogVersion,
    spans,
    domains,
    aliasCount,
    familyLabels,
    approxBytes: approximateBytes(spans, domains),
  };
}

/**
 * A rough retained size for the snapshot, so the plan's "~2–4 MB" is observed rather than
 * asserted.
 *
 * DELIBERATELY APPROXIMATE. An exact figure would need a heap walk; what this is for is a
 * log line that makes an order-of-magnitude regression obvious — a corpus growth that turns
 * 3 MB into 300 MB should be visible on the boot line, and a number that is 30% off does
 * that job perfectly well. Two bytes per character is the JS engine's UTF-16 cost, plus a
 * flat per-entry allowance for object and map overhead.
 */
function approximateBytes(
  spans: SpanIndex,
  domains: ReadonlyMap<string, IndexedDomain>,
): number {
  const ENTRY_OVERHEAD = 48;
  let bytes = 0;
  for (const [key, ids] of spans.exact) bytes += key.length * 2 + ids.length * 16 + ENTRY_OVERHEAD;
  for (const [key, ids] of spans.skeleton) bytes += key.length * 2 + ids.length * 16 + ENTRY_OVERHEAD;
  for (const [key, ids] of spans.tokenPostings) {
    bytes += key.length * 2 + ids.length * 16 + ENTRY_OVERHEAD;
  }
  bytes += spans.idf.size * (16 + ENTRY_OVERHEAD);
  for (const d of domains.values()) {
    bytes +=
      (d.jobDomainId.length + d.labelEn.length + (d.labelHi?.length ?? 0) + d.chipLabel.length) * 2 +
      ENTRY_OVERHEAD * 2;
  }
  return bytes;
}
