/**
 * REVIEW GROUPS — batching candidates for a human, WITHOUT merging them.
 *
 * ===========================================================================
 * WHY A SECOND GROUPING LAYER, WHEN CLUSTERING ALREADY EXISTS
 * ===========================================================================
 * Clustering and grouping answer different questions, and conflating them is what produced
 * the 8,478-row `"wood"` blob measured on 2026-08-26.
 *
 *   CLUSTERING (`clusterPhrases`)  "are these the SAME concept?" A merge. Destructive: the
 *                                  members stop being separate candidates, and one canonical
 *                                  label has to be right for all of them. Therefore it may
 *                                  only ever fire on an IDENTITY relation.
 *   GROUPING   (this module)       "would a reviewer answer these in one sitting?" A batch.
 *                                  Non-destructive: every candidate stays its own row with its
 *                                  own decision, and the group is only a lens over the queue.
 *
 * Because a group asserts nothing about equivalence, it can be far more generous than a
 * cluster and still be safe. That is the whole point: the measured queue is 6,685 candidates
 * of which 6,048 are occupation-derived, and no amount of *safe* merging will reduce that —
 * they genuinely are different phrases. What makes them reviewable is being able to see all
 * 35 wood-working candidates together and answer the underlying ontology question once.
 *
 * ===========================================================================
 * NON-TRANSITIVE BY CONSTRUCTION — the guardrail that matters here
 * ===========================================================================
 * Every defect the clustering layer suffered came from TRANSITIVITY: union-find made
 * `"wood" ~ "wood metal" ~ "metal"` into one component, and a consonant-skeleton bucket put
 * `pile`, `pool` and `ply` in one place. Both are relations between PAIRS, closed under
 * chaining.
 *
 * This module has no pair relation at all. {@link anchorToken} is a pure function from ONE
 * candidate to ONE string, so a candidate is assigned to exactly one group and can never pull
 * two groups together. There is no union, no find, no threshold, and no way for a chain to
 * form. That is not a mitigation of the earlier bug; it is a shape in which the bug cannot be
 * expressed.
 *
 * It also means grouping is idempotent and order-independent for free: run it on any subset of
 * the queue and every candidate lands in the same group it would have landed in.
 *
 * ===========================================================================
 * WHAT A GROUP DECISION MAY AND MAY NOT DO
 * ===========================================================================
 * A reviewer may act on a whole group — the brief's `[REVIEW CLUSTER]` action. What that
 * produces is N INDIVIDUAL decisions, each with its own audit row, each recording the same
 * reviewer and reason. It does NOT produce one decision over a synthetic parent, because there
 * is no parent row and inventing one would make the audit trail lie about what was inspected.
 *
 * A group is therefore never a taxonomy object. It has no id in any table, it is recomputed
 * from the candidates on every read, and nothing persists it. If the anchor rule changes, the
 * groups change and no stored data is wrong — which is exactly the property a merge could
 * never have.
 *
 * PURE. Candidates in, groups out. No database, no clock, no I/O.
 */
import type { SkillCandidateRecord } from "./skill-discovery-candidate";
import { reviewTierFrom, type ReviewTier } from "./skill-discovery-plan";

// ===========================================================================
// The anchor
// ===========================================================================

/**
 * Tokens too broad to make a useful batch axis, even though they are legitimate evidence.
 *
 * MEASURED, not guessed. These are the evidence tokens whose candidate counts in the
 * 2026-08-26 run were high enough that anchoring on them would produce a group nobody can
 * review in one sitting AND that says nothing coherent — `"general"` batches a manager with a
 * machinist. They are skipped when choosing an anchor; a candidate whose ONLY evidence is one
 * of these falls back to its trade family, which is the honest answer for it.
 *
 * Note what is NOT here: `wood`, `metal`, `glass`, `electrical`. Those are broad too — 34, 24,
 * 21 and 10 domains respectively — but a batch of "everything wood" is exactly the batch a
 * reviewer wants, because the ontology question ("is a material-plus-verb pairing a skill?")
 * is the same for all of them. Breadth is only a problem when the members have nothing in
 * common.
 */
export const NON_ANCHOR_TOKENS: readonly string[] = [
  "general",
  "senior",
  "junior",
  "chief",
  "head",
  "assistant",
  "trainee",
  "apprentice",
  "other",
  "misc",
];

const NON_ANCHOR: ReadonlySet<string> = new Set(NON_ANCHOR_TOKENS);

/**
 * A token's batching weight across the whole candidate set.
 *
 * Built once per grouping pass so {@link anchorToken} is a pure function of (candidate, table).
 * Counting CANDIDATES rather than source rows is deliberate: the number that matters is how
 * many DECISIONS a group saves, and a candidate attested by 40 aliases is still one decision.
 */
export function evidenceTokenCounts(
  candidates: readonly SkillCandidateRecord[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const c of candidates) {
    for (const token of new Set(c.evidence_tokens)) {
      if (NON_ANCHOR.has(token)) continue;
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * The one token this candidate is batched on, or `null` when it has none.
 *
 * HIGHEST GLOBAL COUNT WINS, ties broken alphabetically. Highest-count is what maximizes batch
 * size, which is the only thing a review batch is for. The alphabetical tie-break is what
 * makes the assignment a total function — without it two runs over the same data could group
 * differently, and a reviewer returning to "the wood batch" would find a different batch.
 *
 * A candidate with no usable evidence token returns `null` and is grouped by trade family
 * alone. That is the correct answer rather than a gap: an `AMBIGUOUS` candidate like `"riksha"`
 * has no shared axis with anything, and pretending otherwise would bury it.
 */
export function anchorToken(
  candidate: SkillCandidateRecord,
  counts: ReadonlyMap<string, number>,
): string | null {
  return anchorFor(candidate.evidence_tokens, counts);
}

/** The same choice over the tokens alone, for callers holding facts rather than a record. */
export function anchorFor(
  evidenceTokens: readonly string[],
  counts: ReadonlyMap<string, number>,
): string | null {
  let best: string | null = null;
  let bestCount = 0;
  for (const token of new Set(evidenceTokens)) {
    if (NON_ANCHOR.has(token)) continue;
    const count = counts.get(token) ?? 0;
    if (count > bestCount || (count === bestCount && best !== null && token < best)) {
      best = token;
      bestCount = count;
    }
  }
  return best;
}

// ===========================================================================
// Groups
// ===========================================================================

/**
 * A batch of candidates a reviewer can work through together.
 *
 * NOT A TAXONOMY OBJECT. No id in any table, recomputed on every read, persisted nowhere. See
 * the module header for why that is load-bearing rather than lazy.
 */
export interface ReviewGroup {
  /** `<tier>|<family>|<anchor>` — stable, readable, and derivable from the members. */
  readonly key: string;
  readonly tier: ReviewTier;
  readonly trade_family: string | null;
  /** The shared evidence token, or `null` for a family-only group. */
  readonly anchor: string | null;
  /** A short human label for the batch header. */
  readonly label: string;
  readonly candidate_ids: readonly string[];
  /** Decisions this batch represents — i.e. how many rows a reviewer resolves by working it. */
  readonly candidates: number;
  /** Source rows behind the batch, summed. Evidence weight, never a threshold. */
  readonly source_rows: number;
  /** Distinct job domains behind the batch. The "how widely attested" signal. */
  readonly source_domains: number;
  /**
   * Members still awaiting a human — `pending` + `needs_review`.
   *
   * THE NUMBER A REVIEWER PICKS A BATCH BY. `candidates` is how big the batch is; this is how
   * much of it is still work. A group whose members are all decided is history, and a console
   * that could not tell the two apart would keep offering finished batches at the top of the
   * queue forever, because {@link groupCandidates} sorts by size.
   *
   * `deferred` counts as DECIDED here, deliberately: somebody looked and could not settle it,
   * which is a different fact from nobody having looked, and folding it in would make "this batch
   * has 12 left" mean two incompatible things.
   */
  readonly undecided: number;
  /** The pipeline's suggestion, when every member agrees. `null` when they do not. */
  readonly unanimous_action: string | null;
}

/**
 * THE MINIMUM GROUPING NEEDS — the shape a caller that cannot build whole records must supply.
 *
 * ── WHY THIS EXISTS, WHICH IS THE SAME REASON `reviewTierFrom` DOES ────────────────────
 * {@link groupCandidates} takes `SkillCandidateRecord[]`, and a record carries its `sources` and
 * `matches` arrays. The pipeline holds those because it just built them. THE ADMIN QUEUE DOES
 * NOT: a queue read is stored columns plus two aggregates, and materialising 6,673 records to
 * group them would mean fetching every source row and every match row in the table — tens of
 * thousands of rows, to compute a handful of counts.
 *
 * So the rule is exposed over the facts it actually reads, and `groupCandidates` delegates to it.
 * Without this the admin side had two options, and the console picked the honest one: it
 * DEGRADED to grouping by `trade_family` alone, within a single page, and said so in its header
 * — *"reimplementing that algorithm client-side is 'server authority' CLAUDE.md invariant #9
 * forbids"*. It was right, and this is the endpoint it was waiting for.
 *
 * Every field here is read by the grouping rule and nothing else is:
 *   `evidence_tokens`      the anchor
 *   `trade_family`         the family half of the key
 *   `phrase_class` + `has_strong_match`   the tier, via `reviewTierFrom`
 *   `source_alias_count`   summed into `source_rows`
 *   `job_domain_ids`       UNIONED into `source_domains` — see below
 *   `proposed_action`      the unanimity check
 *   `status`               the undecided count
 *
 * ⚠ `job_domain_ids` IS THE ONE FIELD THAT CANNOT BE A COUNT. `skill_candidate` stores
 * `source_domain_count` per candidate, and summing that across a group DOUBLE-COUNTS every domain
 * two members share — which is most of them, since a batch is by construction candidates from
 * related trades. The group's figure is a UNION, so the ids have to travel.
 */
export interface GroupingFacts {
  readonly candidate_id: string;
  readonly evidence_tokens: readonly string[];
  readonly trade_family: string | null;
  readonly phrase_class: string;
  readonly has_strong_match: boolean;
  readonly source_alias_count: number;
  readonly job_domain_ids: readonly string[];
  readonly proposed_action: string;
  readonly status: string;
}

/** The two statuses that mean "still work". Mirrors `MACHINE_WRITABLE_STATUSES`. */
const UNDECIDED_STATUSES: ReadonlySet<string> = new Set(["pending", "needs_review"]);

/**
 * Group the queue.
 *
 * TIER LEADS THE KEY, and that is not cosmetic. The brief's rule is that the `direct` tier is
 * validated FIRST and the `derived` tail is reviewed in batches only afterwards; a group that
 * mixed the two would make that impossible to honour, because a reviewer working the "wood"
 * batch would be silently deciding derived candidates while the direct queue was still open.
 */
export function groupCandidates(candidates: readonly SkillCandidateRecord[]): ReviewGroup[] {
  return groupFacts(
    candidates.map((c) => ({
      candidate_id: c.candidate_id,
      evidence_tokens: c.evidence_tokens,
      trade_family: c.trade_family,
      phrase_class: c.phrase_class,
      has_strong_match: c.matches.some((m) => m.strength === "strong"),
      source_alias_count: c.source_alias_count,
      job_domain_ids: c.sources
        .map((s) => s.job_domain_id)
        .filter((d): d is string => d !== null),
      proposed_action: c.proposed_action,
      status: c.status,
    })),
  );
}

/**
 * THE GROUPING RULE, over {@link GroupingFacts}. The only implementation;
 * {@link groupCandidates} projects records into facts and calls this.
 *
 * TIER LEADS THE KEY, and that is not cosmetic. The rule is that the `direct` tier is validated
 * FIRST and the `derived` tail is reviewed in batches only afterwards; a group that mixed the two
 * would make that impossible to honour, because a reviewer working the "wood" batch would be
 * silently deciding derived candidates while the direct queue was still open.
 *
 * DETERMINISTIC, and it has to be: `anchorToken` breaks count ties alphabetically, the buckets
 * are keyed by a string derived from the members, and the sort's tie-break is a CODE-UNIT
 * comparison — total, and independent of the host's ICU locale, which `localeCompare` is neither
 * (see the sort itself). Two calls over the same input produce byte-identical output, so a
 * reviewer returning to "the wood batch" finds the same batch. There is no id in any table and
 * nothing is persisted — a group is a LENS, recomputed on every read.
 *
 * ⚠ THE ANCHOR IS GLOBAL TO THE INPUT SET, which is what makes this an endpoint rather than a
 * page transform. `evidenceTokenCounts` counts across everything passed in, so grouping one page
 * of 50 and grouping the whole filtered set give DIFFERENT anchors for the same candidate — the
 * top token within 50 rows is rarely the top token within 6,673. Callers must pass the whole
 * filtered set, never a page.
 */
export function groupFacts(facts: readonly GroupingFacts[]): ReviewGroup[] {
  const counts = new Map<string, number>();
  for (const f of facts) {
    for (const token of new Set(f.evidence_tokens)) {
      if (NON_ANCHOR.has(token)) continue;
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }

  const buckets = new Map<string, GroupingFacts[]>();
  for (const f of facts) {
    const tier = reviewTierFrom(f.phrase_class, f.has_strong_match);
    const anchor = anchorFor(f.evidence_tokens, counts);
    const key = `${tier}|${f.trade_family ?? "-"}|${anchor ?? "-"}`;
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [f]);
    else bucket.push(f);
  }

  const groups: ReviewGroup[] = [];
  for (const [key, members] of buckets) {
    const [tier, family, anchor] = key.split("|") as [ReviewTier, string, string];
    const domains = new Set<string>();
    let sourceRows = 0;
    let undecided = 0;
    for (const m of members) {
      sourceRows += m.source_alias_count;
      for (const d of m.job_domain_ids) domains.add(d);
      if (UNDECIDED_STATUSES.has(m.status)) undecided += 1;
    }
    const actions = new Set(members.map((m) => m.proposed_action));
    groups.push({
      key,
      tier,
      trade_family: family === "-" ? null : family,
      anchor: anchor === "-" ? null : anchor,
      label: groupLabel(anchor === "-" ? null : anchor, family === "-" ? null : family, tier),
      // SORTED, not input order. Everything else about a group is already order-independent —
      // the key is derived from the members, the anchor from a global count — and this was the
      // one field that was not: the members array is filled in arrival order, so the same batch
      // rendered its rows differently depending on how the rows happened to arrive. The endpoint
      // that feeds this reads SQL with no ORDER BY on the grouping query, so "how they happened
      // to arrive" is not stable, and a reviewer would see a batch reshuffle between two
      // identical requests. A test caught it; the fix belongs here rather than in the test.
      candidate_ids: members.map((m) => m.candidate_id).sort(),
      candidates: members.length,
      undecided,
      source_rows: sourceRows,
      source_domains: domains.size,
      unanimous_action: actions.size === 1 ? [...actions][0] ?? null : null,
    });
  }

  // Biggest batches first — a group of 35 saves 35 decisions, and that is the whole ordering
  // criterion. Tier is NOT re-applied here: it is already in the key, and the caller filters by
  // tier before rendering (the direct-then-derived sequencing).
  //
  // THE TIE-BREAK IS A CODE-UNIT COMPARISON, not `localeCompare`, and the difference is the
  // determinism this module promises. `localeCompare` fails both halves of that promise, measured
  // rather than assumed:
  //
  //   "direct|craft|weld".localeCompare("direct|craft|बढ़ई")  ->  -1 under en-US/en-IN/de/sv
  //                                                          ->  +1 under hi/hi-IN
  //   "direct|Craft|co\u200Bop".localeCompare("direct|Craft|coop")  ->  0   (U+200B, shown escaped
  //                                                                    because it is invisible)
  //
  // The first makes group order depend on the HOST's ICU default locale, and Devanagari anchors
  // are a supported case with a test of their own. The second is worse: a 0 for two distinct keys
  // means the comparator has abstained, and `Array.prototype.sort` is stable, so the order falls
  // back to arrival order — which is the grouping query's row order, and that query deliberately
  // has no ORDER BY. Exactly the reshuffle-between-identical-requests bug the `candidate_ids`
  // line above was already fixed for; the same defect survived one line further down, where the
  // default comparator was replaced by a locale-sensitive one.
  //
  // `<`/`>` on strings is UTF-16 code-unit order: total, host-independent, and the same
  // comparator `candidate_ids` uses.
  groups.sort((a, b) => b.candidates - a.candidates || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return groups;
}

/** A batch header a reviewer can read. Display only; never parsed. */
export function groupLabel(anchor: string | null, family: string | null, tier: ReviewTier): string {
  if (anchor !== null && family !== null) return `${anchor} — ${family}`;
  if (anchor !== null) return anchor;
  if (family !== null) return `${family} (no shared term)`;
  return `${tier} (ungrouped)`;
}

// ===========================================================================
// What grouping actually buys — reported, never assumed
// ===========================================================================

export interface GroupingReduction {
  readonly candidates: number;
  readonly groups: number;
  /** Groups holding exactly one candidate — grouping bought nothing for these. */
  readonly singleton_groups: number;
  /** Candidates sitting in a group of 2 or more, i.e. the population batching helps. */
  readonly batchable_candidates: number;
  readonly largest_group: number;
  /**
   * SCREENS a reviewer opens: one per group.
   *
   * The honest headline. It is not a claim that a group takes one decision — every member still
   * gets its own decision and its own audit row — only that a reviewer forms the JUDGEMENT once
   * per group instead of once per candidate, which is where the time actually goes.
   */
  readonly review_screens: number;
  readonly by_tier: Readonly<Record<string, { groups: number; candidates: number }>>;
}

export function groupingReduction(
  candidates: readonly SkillCandidateRecord[],
  groups: readonly ReviewGroup[],
): GroupingReduction {
  const byTier: Record<string, { groups: number; candidates: number }> = {};
  for (const g of groups) {
    const row = byTier[g.tier] ?? { groups: 0, candidates: 0 };
    row.groups += 1;
    row.candidates += g.candidates;
    byTier[g.tier] = row;
  }
  const singletons = groups.filter((g) => g.candidates === 1).length;
  return {
    candidates: candidates.length,
    groups: groups.length,
    singleton_groups: singletons,
    batchable_candidates: groups
      .filter((g) => g.candidates > 1)
      .reduce((sum, g) => sum + g.candidates, 0),
    largest_group: groups.reduce((max, g) => Math.max(max, g.candidates), 0),
    review_screens: groups.length,
    by_tier: byTier,
  };
}
