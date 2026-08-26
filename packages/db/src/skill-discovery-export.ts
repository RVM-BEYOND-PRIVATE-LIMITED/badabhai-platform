/**
 * APPROVED CANDIDATES -> CORPUS BATCH. The bridge back into the pipeline that already exists.
 *
 * ===========================================================================
 * WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT
 * ===========================================================================
 * The admin review queue records DECISIONS. It does not write the taxonomy — no request-path
 * code may, and `skill_candidate` has no FK to `skill` that could carry one. So something has
 * to carry an approval from the queue into `data/taxonomy/*.jsonl`, where the two shipped gates
 * and a human commit already stand between a proposal and a database row.
 *
 * THIS IS THAT SOMETHING, AND IT IS DELIBERATELY NOT A SEEDER. It reads approvals, converts
 * them, runs BOTH gates, and writes files. It opens no connection to write anything, it never
 * calls `db:seed:domain-skills`, and the accepted file it produces still has to be COMMITTED BY
 * A PERSON before any seeder will look at it. The chain is unchanged:
 *
 *     admin approves  ->  [this module]  ->  validateTaxonomyCorpus   (structural)
 *                                        ->  taxonomyQualityVerdict   (semantic)
 *                                        ->  accepted-skills.jsonl
 *                                        ->  HUMAN COMMIT
 *                                        ->  db:seed:domain-skills --apply   (provisional)
 *                                        ->  db:embed:skills
 *                                        ->  db:eval:taxonomy
 *                                        ->  db:promote:skills  (C1..C5)     (active)
 *
 * Every one of those steps still runs. This module adds a step to the front; it removes none.
 *
 * ===========================================================================
 * WHY THE GATES RUN HERE AND NOT ONLY AT SEED TIME
 * ===========================================================================
 * `seed-domain-skills.ts` already refuses an invalid or unsound corpus, so running the gates
 * here is technically redundant. It is not redundant in practice, and the reason is about WHO
 * finds out:
 *
 *   at seed time    the operator finds out, at apply time, that a batch a human approved
 *                   three weeks ago cannot be seeded — and the approval is already recorded
 *                   as final in `skill_candidate`, with a reviewer's name on it.
 *   here            the reviewer finds out in the same session, while the decision is still
 *                   theirs to revise, and the blocked file names exactly which approval is
 *                   the problem and why.
 *
 * An approval that cannot become a skill is not an approval anyone should have to defend
 * later. `BLOCKED` output is therefore a first-class outcome, not an error.
 *
 * ===========================================================================
 * TWO DECISION KINDS PRODUCE TWO VERY DIFFERENT RECORDS
 * ===========================================================================
 *   `approved_create`  a NEW canonical skill. Becomes a `TaxonomySkillRecord` whose id is
 *                      MINTED from the approved label by `taxonomySkillIdFor` — never supplied
 *                      by a model, never by a reviewer, never stored on the candidate. The
 *                      cluster's other surface forms become its aliases.
 *   `approved_map`     an ALIAS on a skill that already exists. Becomes a record carrying
 *                      `reuses_existing: true`, which is the corpus's own opt-in flag for
 *                      "hang aliases on a shipped skill without re-declaring it". The seeder
 *                      never inserts or updates the `skill` row for such a record, so the
 *                      shipped row stays authoritative for its labels, kind and status.
 *
 * `approved_merge` produces NOTHING here, and that absence is a decision. A merge says two
 * CANDIDATES are one concept; it does not by itself say what the surviving concept should be
 * called or whether it exists yet. The merged-away candidate's sources are folded into the
 * survivor by the admin layer, and the survivor is exported under its own decision. Emitting
 * something for a merge would mean guessing which side won.
 *
 * `rejected` and `deferred` produce nothing, for the obvious reason.
 *
 * PURE. Candidates in, corpus records and a verdict out. No database, no clock, no filesystem —
 * the runner is a thin transport around this, exactly as `alias-lifecycle.ts` is to its runners.
 */
import {
  taxonomySkillIdFor,
  type TaxonomyCorpus,
  type TaxonomyDomainRecord,
  type TaxonomyDomainSkillRecord,
  type TaxonomySkillAliasRecord,
  type TaxonomySkillRecord,
} from "./taxonomy-corpus";
import { TAXONOMY_CONVERGENCE_GROUPS } from "./taxonomy-quality-gate";
import type { ConvergenceGroup } from "./taxonomy-convergence";
import type { SkillCandidateRecord } from "./skill-discovery-candidate";

// ===========================================================================
// Refusals
// ===========================================================================

/**
 * Why an approved candidate could not be exported, as a stable code.
 *
 * Same discipline as `TaxonomyProblemCode` and `CandidateProblemCode`: the manifest counts by
 * code, so a run six months from now stays comparable. These are refusals BEFORE the gates —
 * a candidate that cannot even be turned into a record never reaches `validateTaxonomyCorpus`.
 */
export type ExportRefusalCode =
  /** The decision kind produces no corpus record by design (`merge`, `reject`, `defer`). */
  | "NOT_EXPORTABLE"
  /** `approved_create` with no label to mint an id from. */
  | "NO_LABEL"
  /** `approved_map` with no target skill. */
  | "NO_TARGET_SKILL"
  /** The target or the minted id is in the closed `mskill_*` vocabulary. */
  | "MATCH_SKILL_TARGET"
  /** Two approved candidates minted the same `skill_id`. */
  | "ID_COLLISION_WITHIN_BATCH"
  /** The candidate carries no source phrase to become an alias. */
  | "NO_SOURCES"
  /** `approved_create` naming no trade. Would seed an invisible skill — see `SKILL_ORPHAN`. */
  | "NO_APPROVED_DOMAIN"
  /** A named trade is not in the occupation catalogue the run was given. */
  | "UNKNOWN_APPROVED_DOMAIN"
  /** The recorded decision is missing its reviewer, moment, or reason. */
  | "INCOMPLETE_DECISION";

export interface ExportRefusal {
  readonly candidate_id: string;
  readonly cluster_key: string;
  readonly code: ExportRefusalCode;
  readonly detail: string;
}

export interface ExportedBatch {
  /** `kind: "skill"` records, ready for `validateTaxonomyCorpus`. */
  readonly skills: readonly TaxonomySkillRecord[];
  /**
   * `kind: "domain_skill"` edges, one per (approved skill, reviewer-named trade).
   *
   * `source: 'curated'` and `confidence: null`, and both are the honest values rather than
   * convenient ones. A human authored this edge by naming the trade on the review screen, which
   * is precisely what `curated` means in `job_domain_skill` — and it carries the property that
   * matters: a curated edge always wins a materialization conflict, so the offline inheritance
   * pass can never quietly overwrite what a reviewer decided. `confidence` is NULL because for a
   * curated row the schema says the question is moot, and inventing 0.9 would be inventing a
   * measurement.
   */
  readonly edges: readonly TaxonomyDomainSkillRecord[];
  /** Candidate ids that produced each skill record, in the same order. The audit link. */
  readonly provenance: readonly { readonly skill_id: string; readonly candidate_ids: readonly string[] }[];
  readonly refusals: readonly ExportRefusal[];
  readonly counts: {
    readonly approved_create: number;
    readonly approved_map: number;
    readonly approved_merge: number;
    readonly rejected: number;
    readonly deferred: number;
    readonly exported_skills: number;
    readonly exported_aliases: number;
    readonly exported_edges: number;
    readonly refused: number;
  };
}

const MSKILL = /^mskill_/;

/**
 * Display ordering for a freshly discovered edge, 0..100, higher first.
 *
 * The schema's own default is 50 and this matches it deliberately. `relevance` answers "how
 * central is this skill to this trade", and a discovery run has measured nothing about that — it
 * measured that a phrase was OBSERVED under an occupation, which is a different question. Taking
 * the neutral middle is the only value that claims nothing; ops re-orders a picker later with
 * evidence a reviewer does not have at approval time.
 */
export const DISCOVERED_EDGE_RELEVANCE = 50;

/**
 * Alias records for a skill: the canonical label FIRST, then every distinct source phrase.
 *
 * ── WHY THE LABEL IS IN ITS OWN ALIAS LIST ──
 *
 * It looks redundant and it is load-bearing. `validateTaxonomyCorpus` refuses a skill with zero
 * aliases — `ALIAS_LIST_EMPTY`, whose message ends *"List at least the label itself"* — because
 * ADR-0030 embeds the ALIASES and not the canonical label. A skill whose only surface form is a
 * label nothing embeds seeds fine and can never be canonicalized to: unreachable forever.
 *
 * The first draft excluded the label to avoid a duplicate, and a single-source candidate whose
 * one phrase WAS the label therefore produced an empty alias list and a blocked batch. Passing
 * `includeLabel` and deduping on the normalized-ish key gives both properties at once: the label
 * is always present, and it is never present twice.
 *
 * `lang` is inferred from the SCRIPT, never from the source row. `job_domain_alias.lang` exists
 * but the candidate does not carry it, and a Devanagari surface form declared `en` would be a
 * lie that outlives this run.
 */
function aliasesFrom(
  candidate: SkillCandidateRecord,
  includeLabel: string | null,
): TaxonomySkillAliasRecord[] {
  const seen = new Set<string>();
  const out: TaxonomySkillAliasRecord[] = [];
  const push = (raw: string): void => {
    const text = raw.trim();
    const key = text.toLowerCase();
    if (text === "" || seen.has(key)) return;
    seen.add(key);
    out.push({ text, lang: /[ऀ-ॿ]/.test(text) ? "hi" : "en" });
  };
  if (includeLabel !== null) push(includeLabel);
  for (const source of candidate.sources) {
    push(source.original_text);
  }
  return out;
}

/** Is this decision complete enough to be acted on? Mirrors `skill_candidate_reviewed_chk`. */
function decisionIsComplete(c: SkillCandidateRecord): boolean {
  return (
    (c.reviewer_admin_id ?? "").trim() !== "" &&
    c.reviewed_at !== null &&
    (c.review_reason ?? "").trim() !== ""
  );
}

/**
 * Turn a set of reviewed candidates into corpus records.
 *
 * ACCEPTS THE WHOLE SET, including the ones it will not export. That is deliberate: the counts
 * a reviewer needs ("you approved 12, 9 became records, 3 were refused and here is why") cannot
 * be produced by a function that was only handed the exportable ones.
 */
export interface ExportOptions {
  /**
   * `jd_* -> label_en` for every trade a reviewer may name.
   *
   * REQUIRED IN PRACTICE and typed optional only so a caller with no catalogue can still get
   * the counts. Two things depend on it:
   *   * `UNKNOWN_APPROVED_DOMAIN` — an id the catalogue does not hold would fail the edge FK
   *     mid-seed, leaving a half-written taxonomy and an error naming a constraint.
   *   * `SKILL_LABEL_IS_DOMAIN_NAME` — the gate that refuses a job title restated as a skill
   *     compares against DOMAIN LABELS. Passing ids as labels would make that check pass
   *     vacuously, which is a silently weakened gate and worse than a missing one. When this map
   *     is absent the runner records the limitation explicitly rather than pretending.
   */
  readonly domainLabels?: ReadonlyMap<string, string>;
}

export function exportApprovedCandidates(
  candidates: readonly SkillCandidateRecord[],
  options: ExportOptions = {},
): ExportedBatch {
  const domainLabels = options.domainLabels ?? new Map<string, string>();
  const knownDomains: ReadonlySet<string> =
    domainLabels.size > 0
      ? new Set(domainLabels.keys())
      : // No catalogue supplied: every named id passes the membership test, and the runner says
        // so in the manifest. Refusing outright would make the pure function unusable for the
        // counts-only case the API layer needs.
        new Set(candidates.flatMap((c) => c.approved_job_domain_ids));
  const skills: TaxonomySkillRecord[] = [];
  const edges: TaxonomyDomainSkillRecord[] = [];
  const provenance: { skill_id: string; candidate_ids: string[] }[] = [];
  const refusals: ExportRefusal[] = [];
  const byMintedId = new Map<string, string>();

  const counts = {
    approved_create: 0,
    approved_map: 0,
    approved_merge: 0,
    rejected: 0,
    deferred: 0,
    exported_skills: 0,
    exported_aliases: 0,
    exported_edges: 0,
    refused: 0,
  };

  const refuse = (c: SkillCandidateRecord, code: ExportRefusalCode, detail: string): void => {
    refusals.push({ candidate_id: c.candidate_id, cluster_key: c.cluster_key, code, detail });
  };

  for (const c of candidates) {
    switch (c.status) {
      case "approved_create":
        counts.approved_create += 1;
        break;
      case "approved_map":
        counts.approved_map += 1;
        break;
      case "approved_merge":
        counts.approved_merge += 1;
        continue; // See the header: a merge names no surviving concept on its own.
      case "rejected":
        counts.rejected += 1;
        continue;
      case "deferred":
        counts.deferred += 1;
        continue;
      default:
        // `pending` / `needs_review`. Not a refusal worth a code — nobody decided yet.
        continue;
    }

    if (!decisionIsComplete(c)) {
      refuse(
        c,
        "INCOMPLETE_DECISION",
        "the decision names no reviewer, no moment, or no reason — the database CHECK that " +
          "normally guarantees all three cannot have been in force when this row was written",
      );
      continue;
    }
    if (c.sources.length === 0) {
      refuse(c, "NO_SOURCES", "no source phrase, so there is nothing to become an alias");
      continue;
    }

    if (c.status === "approved_map") {
      const target = c.resulting_skill_id;
      if (target === null || target.trim() === "") {
        refuse(c, "NO_TARGET_SKILL", "approved as an alias of nothing");
        continue;
      }
      if (MSKILL.test(target)) {
        refuse(
          c,
          "MATCH_SKILL_TARGET",
          `${target} is in the closed mskill_* vocabulary — discovery never resolves onto the ` +
            "match engine's ranking vocabulary (CLAUDE.md §3)",
        );
        continue;
      }
      const aliases = aliasesFrom(c, null);
      if (aliases.length === 0) {
        refuse(c, "NO_SOURCES", "every source phrase was empty after trimming");
        continue;
      }
      skills.push({
        kind: "skill",
        skill_id: target,
        // The SHIPPED row stays authoritative for its labels. These two fields are required by
        // the record type and are ignored by the seeder for a `reuses_existing` record; they
        // are filled from the target id rather than invented so a reader of the file is not
        // misled into thinking the label is being changed.
        label_en: target,
        label_hi: null,
        aliases,
        reuses_existing: true,
      });
      provenance.push({ skill_id: target, candidate_ids: [c.candidate_id] });
      counts.exported_aliases += aliases.length;
      continue;
    }

    // approved_create
    const label = (c.proposed_skill_name ?? "").trim();
    if (label === "") {
      refuse(c, "NO_LABEL", "approved as a new skill with no label to mint an id from");
      continue;
    }
    const skillId = taxonomySkillIdFor(label);
    if (MSKILL.test(skillId) || skillId.startsWith("skill_mskill_")) {
      refuse(c, "MATCH_SKILL_TARGET", `${JSON.stringify(label)} mints ${skillId}, which collides with mskill_*`);
      continue;
    }
    const previous = byMintedId.get(skillId);
    if (previous !== undefined) {
      refuse(
        c,
        "ID_COLLISION_WITHIN_BATCH",
        `${JSON.stringify(label)} mints ${skillId}, already minted by candidate ${previous} in this ` +
          "batch. A `skill_id` is immutable and never reused (ADR-0030 SG-5), so two approvals " +
          "claiming one id is a decision a human has to resolve, not a duplicate to drop",
      );
      continue;
    }
    byMintedId.set(skillId, c.candidate_id);

    // THE TRADES THE REVIEWER NAMED. Without at least one, the skill seeds, embeds, and is
    // invisible — `validateTaxonomyCorpus` refuses it as SKILL_ORPHAN and `db:promote:skills`
    // C3 would refuse to promote it. Caught here so the reviewer hears it while the decision is
    // still theirs to revise, rather than at apply time three weeks later.
    const namedDomains = [...new Set(c.approved_job_domain_ids)].filter((d) => d.trim() !== "");
    if (namedDomains.length === 0) {
      refuse(
        c,
        "NO_APPROVED_DOMAIN",
        "approved as a new skill without naming a single trade. Nothing would reach it: not a " +
          "picker, not a posting, not the promotion gate",
      );
      continue;
    }
    const unknown = namedDomains.filter((d) => !knownDomains.has(d));
    if (unknown.length > 0) {
      refuse(
        c,
        "UNKNOWN_APPROVED_DOMAIN",
        `named trade(s) ${unknown.join(", ")} are not in the occupation catalogue. The edge FK ` +
          "would fail mid-seed, leaving a half-written taxonomy and an error naming a constraint",
      );
      continue;
    }

    const aliases = aliasesFrom(c, label);
    skills.push({ kind: "skill", skill_id: skillId, label_en: label, label_hi: null, aliases });
    for (const jobDomainId of namedDomains) {
      edges.push({
        kind: "domain_skill",
        job_domain_id: jobDomainId,
        skill_id: skillId,
        default_requirement: c.approved_requirement,
        relevance: DISCOVERED_EDGE_RELEVANCE,
        confidence: null,
        source: "curated",
      });
    }
    provenance.push({ skill_id: skillId, candidate_ids: [c.candidate_id] });
    counts.exported_skills += 1;
    counts.exported_aliases += aliases.length;
    counts.exported_edges += namedDomains.length;
  }

  counts.refused = refusals.length;
  return { skills, edges, provenance, refusals, counts };
}

/**
 * The convergence groups this batch can honestly be asked about.
 *
 * ── THE PROBLEM, AND WHY IT IS NOT A REASON TO DISABLE A GATE ──
 *
 * `TAXONOMY_CONVERGENCE_GROUPS` names 13 specific `jd_*` domains, and the quality gate refuses
 * a group whose domains are not in the corpus — `CONVERGENCE_GROUP_UNKNOWN_DOMAIN`, whose own
 * message is the argument: *"A vacuous assertion is worse than no assertion: it reads as a
 * passing check."* That is exactly right for the two callers it was written for, which seed a
 * corpus that INCLUDES `sample-domains.jsonl` and therefore every group domain.
 *
 * An export batch is a handful of approvals in whatever trades a reviewer happened to work.
 * Under the default groups it BLOCKS every time, for all five groups, forever — not because the
 * approvals are bad but because the question does not apply.
 *
 * Two wrong fixes were available. Passing `groups: []` disables a gate. Padding the corpus with
 * the 13 group domains makes them `DOMAIN_ORPHAN` instead (a domain with no edges renders that
 * trade's picker empty), so it trades one blocking finding for another and lies about scope.
 *
 * This is the third option and it is what the gate is actually asking for: run every group whose
 * domains are ALL present, skip the ones that cannot apply, and NAME THE SKIPPED ONES so the
 * narrowing is visible in the manifest rather than implied by a green run.
 */
export function applicableConvergenceGroups(
  corpus: TaxonomyCorpus,
  groups: readonly ConvergenceGroup[] = TAXONOMY_CONVERGENCE_GROUPS,
): { readonly applied: readonly ConvergenceGroup[]; readonly skipped: readonly string[] } {
  const present = new Set(corpus.domains.map((d) => d.job_domain_id));
  const applied: ConvergenceGroup[] = [];
  const skipped: string[] = [];
  for (const g of groups) {
    if (g.job_domain_ids.every((id: string) => present.has(id))) applied.push(g);
    else skipped.push(g.group);
  }
  return { applied, skipped };
}

/**
 * Fold the exported records into a corpus shape the two gates accept.
 *
 * DOMAIN RECORDS ARE THIN POINTERS, not copies of `job_domain`. The occupation catalogue is
 * 4,071 rows with its own scrape and its own validator; duplicating level/parent/ISCO fields
 * here would create a second, drifting answer to "what is this trade". The gates need three
 * things from a domain — that it exists, what a human calls it, and how it clusters — which is
 * exactly what `TaxonomyDomainRecord` carries.
 *
 * `trade_group` is the ISCO family the discovery run already resolved for its report, passed
 * through so a batch stays reviewable trade by trade. It is free text and an id in no table.
 */
export function toCorpus(
  batch: ExportedBatch,
  domainLabels: ReadonlyMap<string, string> = new Map(),
  tradeGroups: ReadonlyMap<string, string> = new Map(),
): TaxonomyCorpus {
  const referenced = [...new Set(batch.edges.map((e) => e.job_domain_id))].sort();
  const domains: TaxonomyDomainRecord[] = referenced.map((id) => ({
    kind: "domain",
    job_domain_id: id,
    // The id is a LAST RESORT and the caller is told so (see `ExportOptions.domainLabels`): with
    // an id standing in for a label, `SKILL_LABEL_IS_DOMAIN_NAME` cannot fire.
    label_en: domainLabels.get(id) ?? id,
    trade_group: tradeGroups.get(id) ?? "discovered",
  }));
  return { domains, skills: [...batch.skills], edges: [...batch.edges] };
}
