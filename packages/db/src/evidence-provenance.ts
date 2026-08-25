/**
 * Provenance for evidence artifacts — the header every committed measurement must carry.
 *
 * ===========================================================================
 * WHY THIS IS A SHARED TYPE AND NOT A CONVENTION
 * ===========================================================================
 * An artifact without provenance is unfalsifiable. A reader holding a JSON file full of counts
 * cannot tell WHEN it was true, WHICH database it describes, whether the reader could SEE the
 * rows, or WHAT defined the population — and every one of those has already produced a wrong
 * conclusion in this programme:
 *
 *   WHEN   `d1-runtime-path-trace.md` recorded 44 worker profiles. 45 were deleted hours later
 *          the same day. Both measurements were correct; the document could not say which
 *          side of the deletion it sat on, so its numbers were quoted for three days as
 *          current.
 *   SEE    Every table in the taxonomy spine is FORCE ROW LEVEL SECURITY with zero policies.
 *          A role without BYPASSRLS reads them empty, and "0 references" then means "not
 *          permitted to look" — indistinguishable from "unused" in a bare artifact.
 *   WHAT   The 96 junk-labelled domains are defined by a specific predicate. Without it, a
 *          later run measuring a slightly different population reports a "change" that is
 *          only a redefinition.
 *
 * Conventions decay because nothing enforces them; `evidence-provenance.test.ts` asserts that
 * every committed artifact carries this header, so a new audit cannot ship without one.
 *
 * NO IO beyond the clock. `measuredAt` is injectable so a caller can stamp a run deterministically.
 */

/** The header. Four fields are mandatory; the rest are mandatory when they apply. */
export interface EvidenceProvenance {
  /** ISO-8601. WHEN the statement was true — not when the file was committed. */
  readonly measured_at: string;
  /** The command that produced it, so the reader can re-run rather than re-derive. */
  readonly source: string;
  /** Host class, or `repository-only` for an artifact that touched no database. */
  readonly target: string;
  /** Whether the producing session could write. A measurement is worth more when it could not. */
  readonly read_only: boolean;
  /** The database role. `null` for repository-only artifacts. */
  readonly role?: string | null;
  /**
   * Whether that role bypassed RLS. **A zero count from a role without it is not evidence.**
   * Omitted only where no table in the artifact is RLS-protected.
   */
  readonly bypass_rls?: boolean;
  /** The predicate that DEFINES the population, so two runs compare like for like. */
  readonly population_predicate?: string;
}

export const REQUIRED_PROVENANCE_KEYS = [
  "measured_at",
  "source",
  "target",
  "read_only",
] as const;

/** For an artifact produced without touching a database. */
export const REPOSITORY_ONLY = "repository-only (no database)";

export interface ProvenanceInput {
  readonly source: string;
  readonly target: string;
  readonly readOnly: boolean;
  readonly role?: string | null;
  readonly bypassRls?: boolean;
  readonly populationPredicate?: string;
  /** Injectable so a test can stamp a fixed instant. */
  readonly measuredAt?: Date;
}

export function provenance(input: ProvenanceInput): EvidenceProvenance {
  return {
    measured_at: (input.measuredAt ?? new Date()).toISOString(),
    source: input.source,
    target: input.target,
    read_only: input.readOnly,
    ...(input.role !== undefined ? { role: input.role } : {}),
    ...(input.bypassRls !== undefined ? { bypass_rls: input.bypassRls } : {}),
    ...(input.populationPredicate !== undefined
      ? { population_predicate: input.populationPredicate }
      : {}),
  };
}

/**
 * Which required keys an artifact is missing. Empty means it is self-describing.
 *
 * Checks presence and type, not plausibility — a reader can judge whether a timestamp is
 * stale, but only if it is there at all, and that is the property worth enforcing.
 */
export function missingProvenance(artifact: unknown): string[] {
  if (typeof artifact !== "object" || artifact === null) return [...REQUIRED_PROVENANCE_KEYS];
  const a = artifact as Record<string, unknown>;
  const missing: string[] = [];
  for (const k of REQUIRED_PROVENANCE_KEYS) {
    const v = a[k];
    if (v === undefined || v === null) {
      missing.push(k);
      continue;
    }
    if (k === "read_only" ? typeof v !== "boolean" : typeof v !== "string" || v.trim() === "") {
      missing.push(k);
    }
  }
  return missing;
}
