/**
 * Occupation-text normalization — the ONE function the alias seeder and the retrieval
 * query path both call.
 *
 * The classic failure mode this exists to prevent: two normalizers that drift. If the
 * seeder writes `job_domain_alias.text_norm` with one set of rules and the query path
 * normalizes the worker's phrase with another, exact-match retrieval (L0) silently
 * degrades to zero hits and every turn falls through to a paid embedding call.
 *
 * Owner: Divyanshu (Occupation Intelligence). Implemented in Phase 1.
 */

/** A stripped occupational particle, kept for diagnostics. */
export interface NormalizationTrace {
  /** The input, unchanged. */
  readonly input: string;
  /** The normalized output — what is stored in `text_norm` and what L0 looks up. */
  readonly normalized: string;
  /** Particles removed, in the order they were stripped (e.g. `["wala", "ka kaam"]`). */
  readonly strippedParticles: readonly string[];
  /** Script detected. Devanagari is NEVER transliterated — both scripts are separate alias rows. */
  readonly script: "latin" | "devanagari" | "mixed";
}

/**
 * NFKC → lowercase → strip punctuation (keeping intra-word `-` and `/`) → collapse
 * whitespace → strip Indian occupational particles (`wala/wale/wali`, `ka kaam`,
 * `karta hun`, `ki/ka/ke`).
 *
 * The particle list is DATA (`data/particles.json`), not code, so adding one is a
 * corpus edit and a re-run of `db:normalize:aliases` — never a deploy.
 *
 * Deliberately NOT a Postgres `GENERATED` column: the particle list changes, a generated
 * column would force a full table rewrite on every rule change, and Postgres forbids
 * non-IMMUTABLE expressions there anyway.
 */
export declare function normalizeOccupationText(input: string): string;

/** As {@link normalizeOccupationText}, but returns what it did. For the seeder's audit output. */
export declare function normalizeOccupationTextTraced(input: string): NormalizationTrace;

/**
 * The Hinglish confusion folder used by retrieval layer L1.
 *
 * Folds `kh↔k`, `aa↔a`, `ee↔i`, `oo↔u`, `w↔v`, `z↔j`, `sh↔s`, drops a trailing `-a`, and
 * collapses doubled consonants — so *welder / waelder / velder*, *kharad / kharaad* and
 * *silai / silaai* all reach one key. Applied to an already-normalized string.
 */
export declare function skeletonKey(normalized: string): string;
