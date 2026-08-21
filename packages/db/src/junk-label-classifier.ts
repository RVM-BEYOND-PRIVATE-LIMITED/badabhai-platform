/**
 * Classifying the non-title `job_domain.label_en` rows and their aliases — the PURE core.
 *
 * ===========================================================================
 * THE TRAP THIS MODULE EXISTS TO AVOID
 * ===========================================================================
 * "Junk label" invites two false inferences, and cleanup driven by either would lose data:
 *
 *   "junk label  => safe to delete"   — the LABEL is scrape residue; the DOMAIN underneath it
 *                                       is usually a real NCO occupation with a real code and
 *                                       real worker-vocabulary aliases.
 *   "alias       => duplicate"        — an alias may be a synonym, a legacy title, a scraped
 *                                       prose fragment, or the one usable name the row has.
 *
 * So nothing here decides to remove anything. It classifies, states the rule it used, and
 * leaves `AMBIGUOUS` where the evidence does not reach — which is a real answer, not a gap.
 *
 * NO IO. Inputs are values, so every rule is testable without a database.
 */

/** Why a label is not a title. Both are shapes of NCO PDF scrape residue. */
export type LabelDefect =
  /** "ISCO 08 Unit Group Details:" — a section HEADER captured as the occupation name. */
  | "SECTION_HEADER"
  /** "...spreads skin or hide with hair" — a wrapped CONTINUATION LINE of a description. */
  | "PROSE_FRAGMENT";

export interface LabelVerdict {
  readonly defective: boolean;
  readonly defect: LabelDefect | null;
}

/**
 * The detector, stated once so the audit and its tests cannot drift apart.
 *
 * Deliberately the same two shapes the original survey used (`label_en LIKE '%:'`,
 * `label_en ~ '^[a-z]'`) rather than a cleverer rule — a wider net would change the
 * population mid-investigation and make the count incomparable with the figure on record.
 */
export function classifyLabel(labelEn: string): LabelVerdict {
  if (labelEn.endsWith(":")) return { defective: true, defect: "SECTION_HEADER" };
  const first = labelEn.charAt(0);
  if (first !== "" && first === first.toLowerCase() && first !== first.toUpperCase()) {
    return { defective: true, defect: "PROSE_FRAGMENT" };
  }
  return { defective: false, defect: null };
}

/* ===========================================================================
 * ALIASES
 * =========================================================================== */

export type AliasClass =
  /** Title-shaped and unique — the row's usable occupational vocabulary. */
  | "LEGITIMATE_ALIAS"
  /** Scraped prose, not something a worker would say as their trade. */
  | "JUNK"
  /** Normalizes onto an alias of a DIFFERENT domain — both retrievable, so both compete. */
  | "CONFLICTING_ALIAS"
  /** Not on the retrieval surface: a within-domain duplicate that lost its election. */
  | "DUPLICATE"
  /** Shape gives no honest signal either way. Owner review. */
  | "AMBIGUOUS";

export interface AliasInput {
  readonly text: string;
  readonly isSearchable: boolean;
  /** How many DISTINCT domains share this alias's `text_norm` across the searchable surface. */
  readonly domainsSharingNorm: number;
}

/**
 * Order matters and encodes precedence, not convenience.
 *
 * A non-searchable row is reported as `DUPLICATE` FIRST, because `is_searchable=false` is the
 * database's own recorded election outcome and beats any guess made from the string's shape.
 * A collision is next, because competing for a worker's phrase is a live defect regardless of
 * how well-formed the text is.
 *
 * NOT decided here: `TYPO` and `LEGACY_ALIAS`. Neither is machine-decidable from the columns
 * available — a typo needs the intended spelling and a legacy title needs its supersession
 * history, and inventing a heuristic for either would manufacture confidence. They fall to
 * `AMBIGUOUS` on purpose.
 */
export function classifyAlias(a: AliasInput): AliasClass {
  if (!a.isSearchable) return "DUPLICATE";
  if (a.domainsSharingNorm > 1) return "CONFLICTING_ALIAS";
  if (isProse(a.text)) return "JUNK";
  if (isTitleShaped(a.text)) return "LEGITIMATE_ALIAS";
  return "AMBIGUOUS";
}

/** A wrapped sentence fragment: starts lowercase, trails a clause, or is simply too long. */
export function isProse(text: string): boolean {
  const t = text.trim();
  if (t === "") return false;
  const first = t.charAt(0);
  if (first === first.toLowerCase() && first !== first.toUpperCase()) return true;
  if (t.endsWith(":") || t.endsWith(",") || t.endsWith(";")) return true;
  if (t.length > 80) return true;
  return false;
}

/** What an occupation title looks like: capitalised, short, one clause. */
export function isTitleShaped(text: string): boolean {
  const t = text.trim();
  if (t.length === 0 || t.length > 45) return false;
  if (t.includes(";")) return false;
  const first = t.charAt(0);
  return first === first.toUpperCase() && first !== first.toLowerCase();
}

/* ===========================================================================
 * DOMAINS
 * =========================================================================== */

export type DomainClass =
  /** No reference anywhere AND no recoverable occupational identity. */
  | "A_UNUSED_JUNK"
  /** Something still points at it. Never remove casually. */
  | "B_LEGACY_REFERENCED"
  /** A real occupation wearing the wrong label. Rename, do not remove. */
  | "C_MISLABELLED_LEGITIMATE"
  /** Structurally load-bearing despite the label. Leave alone. */
  | "D_STRUCTURAL"
  /** Evidence does not reach. Owner review. */
  | "E_AMBIGUOUS";

export interface DomainInput {
  readonly jobDomainId: string;
  readonly labelEn: string;
  readonly childCount: number;
  /** Rows in `job_domain_skill`, `worker_profiles`, `job_postings`, `unresolved_phrase`, bindings. */
  readonly referenceCount: number;
  /** Aliases on the live retrieval surface (`is_searchable`). */
  readonly searchableAliases: number;
  /** Of those, how many are title-shaped — i.e. how recoverable the real identity is. */
  readonly titleShapedAliases: number;
  /** A published NCO/ISCO code. Its absence would make the row unverifiable. */
  readonly hasSourceCode: boolean;
}

/**
 * Deterministic, and ordered most-protective-first.
 *
 * The important rule is the LAST one before `E`: a domain with a published code and at least
 * one title-shaped alias is `C_MISLABELLED_LEGITIMATE` — a real occupation whose `label_en`
 * captured the wrong line of a PDF. That is a rename question. Treating it as deletable would
 * discard a coded NCO occupation and its paid embeddings over a cosmetic defect.
 *
 * `A_UNUSED_JUNK` therefore requires the identity to be genuinely unrecoverable: nothing
 * references it, nothing descends from it, and no alias reads as an occupation.
 */
export function classifyDomain(d: DomainInput): DomainClass {
  if (d.referenceCount > 0) return "B_LEGACY_REFERENCED";
  if (d.childCount > 0) return "D_STRUCTURAL";
  if (d.hasSourceCode && d.titleShapedAliases > 0) return "C_MISLABELLED_LEGITIMATE";
  if (!d.hasSourceCode && d.searchableAliases === 0) return "A_UNUSED_JUNK";
  return "E_AMBIGUOUS";
}

/** The sentence that must accompany any recommendation derived from this module. */
export const NO_REMEDIATION_NOTICE =
  "This is a classification, not an authorization. No row is removed, renamed, or " +
  "de-elected by this audit; a label defect is not evidence that the occupation beneath " +
  "it is disposable.";
