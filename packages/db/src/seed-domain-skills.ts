/**
 * Canonical Domain -> Skill taxonomy seed (migration 0076) — loads
 * `packages/db/data/taxonomy/*.jsonl` into `skill` + `skill_alias` + `job_domain_skill`.
 *
 *   pnpm db:seed:domain-skills              # DRY RUN — plans and prints, writes nothing
 *   pnpm db:seed:domain-skills --apply      # writes
 *
 * GUARDS come from the shared `match-v1-cli` harness rather than being re-implemented
 * here, which is the point of that file: dry-run is the DEFAULT, production needs the
 * explicit confirm token, and DATABASE_URL must be set with NO localhost fallback. A seed
 * of thousands of reference rows pointed at the wrong database is exactly the failure that
 * harness exists to prevent.
 *
 * REFUSES AN INVALID CORPUS. The validator is the gate; this file is only the hands.
 *
 * It calls `loadTaxonomyCorpus` + `validateTaxonomyCorpus` INLINE rather than the
 * convenience wrapper `resolveTaxonomyCorpus`, and that is deliberate rather than an
 * oversight: the seeder prefixes every problem with `[seed:domain-skills]` and adds its own
 * zero-edge precondition on top. Behaviourally the two paths are identical today — if you
 * tighten the gate, tighten it inside `validateTaxonomyCorpus`, which BOTH paths call, and
 * never only inside the wrapper.
 *
 * ---------------------------------------------------------------------------
 * IDEMPOTENT, AND SPECIFICALLY EMBEDDING-SAFE
 * ---------------------------------------------------------------------------
 * All three writes are `ON CONFLICT ... DO UPDATE` on the row's natural key, each with a
 * `WHERE` that fires only when something actually differs. A second run therefore reports
 * zero changes rather than rewriting every row with a fresh `updated_at` — the same
 * IS DISTINCT FROM discipline `seed-job-domains.ts` uses for its parent-link pass.
 *
 *   `skill`             ON CONFLICT (skill_id) — the immutable PK. Only the labels
 *                       propagate; `kind`, `status`, `source`, `domain_id` and
 *                       `industry_id` are INSERT-ONLY, so re-seeding can never re-domain
 *                       or reactivate a row (ADR-0030 SG-5: a re-domain is deprecate +
 *                       recreate, never an UPDATE).
 *   `skill_alias`       ON CONFLICT (id), where the id is DETERMINISTIC in
 *                       (skill_id, text, lang) — `deterministicAliasId`, the same function
 *                       `seed-skills.ts` uses. `embedding`, `embedding_model` and
 *                       `embedded_at` are NEVER in the SET clause, so a re-run cannot
 *                       clobber a vector a real provider call was paid for.
 *   `job_domain_skill`  ON CONFLICT (job_domain_id, skill_id) — the composite PK — and
 *                       ONLY when the existing row is not `curated`. A hand-authored edge
 *                       always wins a materialization conflict; that is what `curated`
 *                       means (see schema/taxonomy.ts), and a bootstrap that silently
 *                       overwrote ops' corrections would make the flag a lie.
 *
 * ---------------------------------------------------------------------------
 * PRECONDITIONS ARE CHECKED BEFORE ANYTHING IS WRITTEN
 * ---------------------------------------------------------------------------
 * `job_domain_skill` has FKs to both `job_domain` and `skill`. Discovering a missing
 * parent as an FK violation halfway through an apply leaves a half-seeded taxonomy and an
 * error message that names a constraint, not a fix. So the run asks first: are all the
 * corpus's domains in the catalogue, and do all the SHIPPED skills it references exist?
 * If not it refuses and names the seed to run first.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ---------------------------------------------------------------------------
 * NOT embeddings. `skill_alias.embedding` stays NULL. Embedding is a separate, gated,
 * resumable runner (`pnpm db:embed:skills`) that makes real provider calls; folding it in
 * here would make a reference-data seed cost money and stop being re-runnable.
 *
 * NOT inheritance. Every edge is written exactly as authored (`source='llm_bootstrap'` or
 * `'curated'`). Resolving the ISCO ladder into `source='inherited'` rows is the
 * materializer's job and needs `inherited_from_job_domain_id`, which a corpus file does
 * not carry.
 *
 * NOT matchable. Every skill is written `kind='attribute'`. The `mskill_*` vocabulary is
 * closed at 18 members and changing that needs an ADR and an `engine_version` bump
 * (invariant #4); the corpus validator rejects the prefix outright.
 *
 * PRIVACY: trade reference vocabulary and published occupation ids. No worker PII
 * anywhere, and every log line is ids + counts (`printCounts` is the only logging helper
 * for that reason).
 */
import { normalizeOccupationText } from "@badabhai/profiling-lexicon";
import { and, eq, inArray, isNotNull, sql as dsql } from "drizzle-orm";

import { createDbClient } from "./client";
import { parseCommonCli, printCounts, printFooter, printHeader } from "./match-v1-cli";
import { jobDomains, jobDomainSkills, skillAliases, skills } from "./schema";
import { deterministicAliasId } from "./skill-alias-id";
import {
  loadTaxonomyCorpus,
  shippedSkillIds,
  summariseTaxonomyCorpus,
  validateTaxonomyCorpus,
  type TaxonomyCorpus,
  type TaxonomyDomainSkillRecord,
  type TaxonomyLang,
  type TaxonomySkillRecord,
} from "./taxonomy-corpus";

const SCRIPT = "seed:domain-skills";

/** Multi-row inserts. One statement per row is minutes of round-trips at corpus scale. */
const CHUNK = 500;

function chunked<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

// ===========================================================================
// Pure planners — everything decidable without a database lives here, so it is
// unit-testable without one. (The DB half is covered by `db:verify:taxonomy` and
// by QA's cross-cutting suite, not by a unit test pretending to have Postgres.)
// ===========================================================================

/** A `skill` row this seed would insert. */
export interface PlannedSkillRow {
  skillId: string;
  labelEn: string;
  labelHi: string | null;
}

/** A `skill_alias` row this seed would insert. */
export interface PlannedAliasRow {
  id: string;
  skillId: string;
  text: string;
  textNorm: string;
  lang: TaxonomyLang;
  isSearchable: boolean;
}

/**
 * Which corpus skills get a `skill` row.
 *
 * A `reuses_existing` record is EXCLUDED. Its id already belongs to `SKILL_CORPUS`, which
 * `seed-skills.ts` owns: that row's labels, `kind`, `status`, `source` and legacy
 * `domain_id` are authoritative, and this seed has no business restating them. The record
 * exists purely to hang extra aliases on, and those still seed.
 */
export function planSkillRows(corpus: readonly TaxonomySkillRecord[]): PlannedSkillRow[] {
  return corpus
    .filter((s) => s.reuses_existing !== true)
    .map((s) => ({ skillId: s.skill_id, labelEn: s.label_en, labelHi: s.label_hi }));
}

/**
 * Build every `skill_alias` row, with `text_norm` computed and `is_searchable` elected.
 *
 * `text_norm` COMES FROM `normalizeOccupationText`, the SAME function the retrieval path
 * calls and the same one `job_domain_alias.text_norm` is built with. That shared call is
 * the whole design and is stated at length in `normalize-job-domain-aliases.ts`: a second
 * normalizer written here (or in SQL) would drift, and drift is SILENT — L0 exact match
 * simply stops hitting and every profiling turn falls through to a paid embedding.
 *
 * ELECTION. `skill_alias_skill_norm_lang_uq` is UNIQUE on (skill_id, text_norm, lang)
 * WHERE is_searchable, with NULLS NOT DISTINCT. Exactly one row per group may therefore be
 * retrievable. The corpus validator already rejects two aliases of one skill that
 * normalize alike, so within a clean corpus every group has one member — but this function
 * must still elect, because:
 *   - `claimed` carries groups an ALREADY-SEEDED row holds (a shipped alias of a skill
 *     this corpus reuses). Electing a second winner there is not a soft failure, it is a
 *     unique-violation that aborts the whole apply.
 *   - a loser KEEPS its row, its stable id and any paid embedding, and simply stops being
 *     retrievable. Nothing is deleted (CLAUDE.md §10).
 *
 * Tie-break is deterministic — shortest text, then lowest id — so a re-run elects the same
 * winner and the idempotent upsert stays a no-op. The domain-side normalizer prefers a row
 * that already carries an embedding; that tier is absent here because the alias id is a
 * hash of the raw text, so an existing embedded row IS this row, not a rival.
 */
/** One `skill_alias` row as the runner reads it back when looking for existing claims. */
export interface ClaimedAliasRow {
  id: string;
  skillId: string;
  textNorm: string | null;
  lang: string | null;
}

/**
 * Which `(skill, text_norm, lang)` groups are ALREADY held by an alias THIS SEEDER DOES NOT OWN.
 *
 * Extracted from the runner so it is testable without a database, because the bug it fixes
 * is invisible in `planAliasRows` — that function is correct in isolation, and the defect was
 * entirely in what the runner FED it.
 *
 * The subtraction is the whole point. `claimedRows` comes from
 * `skill_alias WHERE is_searchable`, which on any run after the first includes the winners
 * this seeder itself elected. Counting those as foreign claims makes the runner skip every
 * group, emit `is_searchable: false` for all of them, and — because the upsert guard is
 * `IS DISTINCT FROM` — actually WRITE that. The next run finds nothing claimed and flips them
 * back. The state oscillates forever, silently, while the runner reports work done.
 *
 * Sound because `deterministicAliasId(skill_id, text, lang)` is independent of election: a
 * row's identity is stable across runs even when its `is_searchable` value is not, so "mine"
 * can be decided by id before any election happens.
 */
export function buildClaimedSet(
  claimedRows: readonly ClaimedAliasRow[],
  plannedRows: readonly PlannedAliasRow[],
): Set<string> {
  const mine = new Set(plannedRows.map((r) => r.id));
  return new Set(
    claimedRows
      .filter((r) => !mine.has(r.id))
      .map((r) => `${r.skillId}|${r.textNorm}|${r.lang ?? ""}`),
  );
}

export function planAliasRows(
  corpus: readonly TaxonomySkillRecord[],
  opts: { claimed?: ReadonlySet<string> } = {},
): PlannedAliasRow[] {
  const claimed = opts.claimed ?? new Set<string>();
  const rows: PlannedAliasRow[] = [];
  for (const s of corpus) {
    for (const a of s.aliases) {
      const norm = normalizeOccupationText(a.text);
      // A corpus that reached this function has passed the validator, which rejects an
      // alias normalizing to empty. Skipping rather than throwing keeps the seeder honest
      // if someone ever calls it with unvalidated input: an unwritable text_norm would
      // collide with every other empty one under NULLS NOT DISTINCT.
      if (norm.length === 0) continue;
      rows.push({
        id: deterministicAliasId(s.skill_id, a.text, a.lang),
        skillId: s.skill_id,
        text: a.text,
        textNorm: norm,
        lang: a.lang,
        isSearchable: false,
      });
    }
  }

  const winner = new Map<string, PlannedAliasRow>();
  for (const r of rows) {
    const key = `${r.skillId}|${r.textNorm}|${r.lang}`;
    if (claimed.has(key)) continue; // a seeded row already owns this group
    const held = winner.get(key);
    if (
      held === undefined ||
      r.text.length < held.text.length ||
      (r.text.length === held.text.length && r.id < held.id)
    ) {
      winner.set(key, r);
    }
  }
  for (const r of winner.values()) r.isSearchable = true;
  return rows;
}

/** The `job_domain_skill` rows, one per corpus edge. A straight projection — the
 *  interesting decisions were all made by the validator. */
export function planEdgeRows(
  corpus: readonly TaxonomyDomainSkillRecord[],
  now: Date,
): {
  jobDomainId: string;
  skillId: string;
  defaultRequirement: TaxonomyDomainSkillRecord["default_requirement"];
  relevance: number;
  confidence: number | null;
  source: TaxonomyDomainSkillRecord["source"];
  computedAt: Date;
  updatedAt: Date;
}[] {
  return corpus.map((e) => ({
    jobDomainId: e.job_domain_id,
    skillId: e.skill_id,
    defaultRequirement: e.default_requirement,
    relevance: e.relevance,
    confidence: e.confidence,
    source: e.source,
    computedAt: now,
    updatedAt: now,
  }));
}

/**
 * Every SHIPPED skill id the corpus depends on being already seeded — the ids it
 * references but does not create. Split out so the precondition message can name them.
 */
export function shippedDependencies(corpus: TaxonomyCorpus): string[] {
  const shipped = shippedSkillIds();
  const created = new Set(
    corpus.skills.filter((s) => s.reuses_existing !== true).map((s) => s.skill_id),
  );
  const needed = new Set<string>();
  for (const s of corpus.skills) if (s.reuses_existing === true) needed.add(s.skill_id);
  for (const e of corpus.edges) if (!created.has(e.skill_id) && shipped.has(e.skill_id)) needed.add(e.skill_id);
  return [...needed].sort();
}

// ===========================================================================
// Runner
// ===========================================================================

async function main(): Promise<void> {
  const opts = parseCommonCli(SCRIPT);
  printHeader(SCRIPT, opts);

  // THE GATE. Load and validate before touching a connection — an invalid corpus should
  // cost nothing and should never open a transaction.
  const corpus = loadTaxonomyCorpus();
  const problems = validateTaxonomyCorpus(corpus.skills, corpus.edges, { domains: corpus.domains });
  if (problems.length > 0) {
    throw new Error(
      `[${SCRIPT}] taxonomy corpus invalid — refusing to seed. Run 'pnpm db:verify:taxonomy'.\n  - ` +
        problems.join("\n  - "),
    );
  }
  if (corpus.edges.length === 0) {
    throw new Error(
      `[${SCRIPT}] corpus has zero domain_skill edges — nothing to seed. An empty corpus reported ` +
        `as a successful seed is how a taxonomy silently never ships.`,
    );
  }
  printCounts(SCRIPT, summariseTaxonomyCorpus(corpus));

  const { db, sql } = createDbClient(opts.databaseUrl, { max: 1 });
  try {
    // ── Preconditions ───────────────────────────────────────────────────────
    const domainIds = corpus.domains.map((d) => d.job_domain_id);
    const presentDomains = new Set(
      (
        await db
          .select({ id: jobDomains.jobDomainId })
          .from(jobDomains)
          .where(inArray(jobDomains.jobDomainId, domainIds))
      ).map((r) => r.id),
    );
    const missingDomains = domainIds.filter((id) => !presentDomains.has(id));
    if (missingDomains.length > 0) {
      throw new Error(
        `[${SCRIPT}] ${missingDomains.length} domain(s) in sample-domains.jsonl are not in ` +
          `\`job_domain\` — the FK would fail mid-seed. Run 'pnpm db:seed:domains' first.\n  ` +
          `missing: ${missingDomains.slice(0, 10).join(", ")}${missingDomains.length > 10 ? " …" : ""}`,
      );
    }

    const dependencies = shippedDependencies(corpus);
    const existingSkills =
      dependencies.length === 0
        ? []
        : await db
            .select({ id: skills.skillId, domainId: skills.domainId })
            .from(skills)
            .where(inArray(skills.skillId, dependencies));
    const presentSkills = new Map(existingSkills.map((r) => [r.id, r.domainId]));
    const missingSkills = dependencies.filter((id) => !presentSkills.has(id));
    if (missingSkills.length > 0) {
      throw new Error(
        `[${SCRIPT}] ${missingSkills.length} SHIPPED skill(s) this corpus references are not in ` +
          `\`skill\`. Run 'pnpm db:seed:skills' first.\n  missing: ${missingSkills.join(", ")}`,
      );
    }

    // Groups an already-seeded alias holds `is_searchable` on. Electing a second winner
    // for one of these is a unique-index violation, not a soft conflict — see
    // `planAliasRows`.
    //
    // ── THE SEEDER MUST NOT SEE ITS OWN PREVIOUS RUN AS A RIVAL CLAIMANT ──
    //
    // This is the bug that made the runner non-idempotent, and it is worth spelling out
    // because the failure is silent and self-reversing. `claimed` is "groups somebody ELSE
    // already won". Without the `plannedIds` filter below, run 2 reads the winners run 1
    // wrote, treats them as foreign claims, skips those groups during election, and emits
    // every alias with `is_searchable: false` — and because the upsert's `setWhere` is
    // `IS DISTINCT FROM`, true-vs-false is a real change, so it UPDATES. Run 3 then finds
    // nothing claimed and flips them all back to true. The state OSCILLATES instead of
    // converging, and nothing errors or logs.
    //
    // Blast radius is bounded today only because 0076 deliberately left
    // `skill_alias_embedding_hnsw` non-partial. The moment that index becomes
    // `WHERE is_searchable` — which 0076's own header names as the plan, and which is
    // exactly how the sibling `job_domain_alias` ANN path already gates retrieval — an
    // even-numbered re-seed would unindex the entire seeded vocabulary with no symptom
    // except silence from the canonicalizer.
    //
    // The fix works because `deterministicAliasId(skill_id, text, lang)` does NOT depend on
    // election: the row's identity is stable across runs even when its `is_searchable`
    // value is not. So we can plan first, learn our own ids, and subtract them.
    const allSkillIds = [...new Set([...corpus.skills.map((s) => s.skill_id), ...dependencies])];
    const claimedRows =
      allSkillIds.length === 0
        ? []
        : await db
            .select({
              id: skillAliases.id,
              skillId: skillAliases.skillId,
              textNorm: skillAliases.textNorm,
              lang: skillAliases.lang,
            })
            .from(skillAliases)
            .where(
              and(
                inArray(skillAliases.skillId, allSkillIds),
                eq(skillAliases.isSearchable, true),
                isNotNull(skillAliases.textNorm),
              ),
            );
    const claimed = buildClaimedSet(claimedRows, planAliasRows(corpus.skills));

    // ── Plan ────────────────────────────────────────────────────────────────
    const now = new Date();
    const skillRows = planSkillRows(corpus.skills);
    const aliasRows = planAliasRows(corpus.skills, { claimed });
    const edgeRows = planEdgeRows(corpus.edges, now);

    const existingIds = new Set(
      (
        await db
          .select({ id: skills.skillId })
          .from(skills)
          .where(inArray(skills.skillId, skillRows.length === 0 ? ["__none__"] : skillRows.map((s) => s.skillId)))
      ).map((r) => r.id),
    );

    printCounts(SCRIPT, {
      skills_new: skillRows.filter((s) => !existingIds.has(s.skillId)).length,
      skills_existing: skillRows.filter((s) => existingIds.has(s.skillId)).length,
      skills_shipped_reused: dependencies.length,
      alias_rows_offered: aliasRows.length,
      alias_rows_searchable: aliasRows.filter((a) => a.isSearchable).length,
      alias_groups_already_claimed: claimed.size,
      edge_rows_offered: edgeRows.length,
    });

    if (!opts.apply) {
      printFooter(SCRIPT, opts, skillRows.length + aliasRows.length + edgeRows.length);
      return;
    }

    // ── 1) `skill` — labels only on conflict ────────────────────────────────
    let skillWrites = 0;
    for (const chunk of chunked(skillRows, CHUNK)) {
      const written = await db
        .insert(skills)
        .values(
          chunk.map((s) => ({
            skillId: s.skillId,
            labelEn: s.labelEn,
            labelHi: s.labelHi,
            // DESCRIPTIVE, PROVISIONAL, NO LEGACY DOMAIN, FIRST-PARTY. Each of these is
            // insert-only (see the ON CONFLICT set below) and each is deliberate:
            //   kind      — `attribute`; the matchable vocabulary is closed (invariant #4).
            //   status    — `provisional`; nothing machine-drafted is `active` until a
            //               human promotes it. Same discipline as a promoted unresolved
            //               phrase.
            //   domainId  — NULL; the 11 legacy slugs are a disjoint id space and picking
            //               one would be inventing a fact. The canonical domain lives in
            //               `job_domain_skill`. Nullable since 0076 exactly for this.
            //   source    — `rvm`; first-party. Claiming esco/onet/nco would assert a
            //               provenance we cannot show.
            //   industryId is left to its column DEFAULT: it scopes the MATCHABLE read
            //               (`skill_industry_kind_idx` on (industry_id, kind)), which never
            //               selects an attribute row, so any value here is noise.
            kind: "attribute" as const,
            status: "provisional" as const,
            domainId: null,
            source: "rvm" as const,
            updatedAt: now,
          })),
        )
        .onConflictDoUpdate({
          target: skills.skillId,
          set: { labelEn: dsql`excluded.label_en`, labelHi: dsql`excluded.label_hi`, updatedAt: now },
          // Only when something actually differs, so a re-run is a genuine no-op rather
          // than a rewrite of every row's `updated_at`.
          setWhere: dsql`"skill"."label_en" IS DISTINCT FROM excluded."label_en"
                      OR "skill"."label_hi" IS DISTINCT FROM excluded."label_hi"`,
        })
        .returning({ id: skills.skillId });
      skillWrites += written.length;
    }

    // ── 2) `skill_alias` — deterministic id, embedding untouched ────────────
    let aliasWrites = 0;
    for (const chunk of chunked(aliasRows, CHUNK)) {
      const written = await db
        .insert(skillAliases)
        .values(
          chunk.map((a) => ({
            id: a.id,
            skillId: a.skillId,
            text: a.text,
            textNorm: a.textNorm,
            isSearchable: a.isSearchable,
            lang: a.lang,
            source: "rvm" as const,
            // Denormalized from the skill for the domain-scoped ANN pre-filter. NULL for a
            // skill this corpus mints (it has no legacy slug); the SHIPPED skill's own
            // slug for a `reuses_existing` record, so its aliases stay visible to the
            // filter its siblings already sit behind.
            domainId: presentSkills.get(a.skillId) ?? null,
            // embedding / embedding_model / embedded_at stay NULL — `pnpm db:embed:skills`
            // fills them, and they are never in the SET clause below.
          })),
        )
        .onConflictDoUpdate({
          target: skillAliases.id,
          set: {
            textNorm: dsql`excluded.text_norm`,
            isSearchable: dsql`excluded.is_searchable`,
          },
          setWhere: dsql`"skill_alias"."text_norm"      IS DISTINCT FROM excluded."text_norm"
                      OR "skill_alias"."is_searchable"  IS DISTINCT FROM excluded."is_searchable"`,
        })
        .returning({ id: skillAliases.id });
      aliasWrites += written.length;
    }

    // ── 3) `job_domain_skill` — curated always wins ─────────────────────────
    let edgeWrites = 0;
    for (const chunk of chunked(edgeRows, CHUNK)) {
      const written = await db
        .insert(jobDomainSkills)
        // `status` is INSERT-ONLY, and its absence from both `set` and `setWhere` below is
        // deliberate: a re-seed must never resurrect an edge a human deprecated. New rows
        // arrive 'active'; an existing row keeps whatever lifecycle it was moved to. Same
        // reasoning as the curated-wins rule directly beneath.
        .values(chunk.map((e) => ({ ...e, status: "active" as const })))
        .onConflictDoUpdate({
          target: [jobDomainSkills.jobDomainId, jobDomainSkills.skillId],
          set: {
            defaultRequirement: dsql`excluded.default_requirement`,
            relevance: dsql`excluded.relevance`,
            confidence: dsql`excluded.confidence`,
            source: dsql`excluded.source`,
            computedAt: now,
            updatedAt: now,
          },
          // `curated` is a human's correction and always wins a materialization conflict
          // (schema/taxonomy.ts). The IS DISTINCT FROM tail keeps a re-run from bumping
          // `computed_at` on rows nothing changed for — which matters, because
          // `computed_at` is how a partial or stale rebuild is detected.
          setWhere: dsql`"job_domain_skill"."source" <> 'curated'
                     AND ( "job_domain_skill"."default_requirement" IS DISTINCT FROM excluded."default_requirement"
                        OR "job_domain_skill"."relevance"           IS DISTINCT FROM excluded."relevance"
                        OR "job_domain_skill"."confidence"          IS DISTINCT FROM excluded."confidence"
                        OR "job_domain_skill"."source"              IS DISTINCT FROM excluded."source" )`,
        })
        .returning({ id: jobDomainSkills.skillId });
      edgeWrites += written.length;
    }

    printCounts(SCRIPT, {
      skills_written: skillWrites,
      alias_rows_written: aliasWrites,
      edges_written: edgeWrites,
    });
    console.log(
      `[${SCRIPT}] embeddings are NULL — run 'pnpm db:embed:skills' next. ` +
        `Skills are status='provisional': a human promotes them to 'active'.`,
    );
    printFooter(SCRIPT, opts, skillWrites + aliasWrites + edgeWrites);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

// Only run the writer when invoked directly, so importing the pure planners in a test is
// side-effect-free. Same guard `seed-reach-pool.ts` carries, and for the same reason: the
// alternative is a unit test that opens a database connection on import.
const invokedDirectly = /seed-domain-skills\.ts$/.test(process.argv[1] ?? "");
if (invokedDirectly) {
  main().catch((err) => {
    // nosemgrep: javascript.lang.security.audit.unsafe-formatstring.unsafe-formatstring -- `SCRIPT` is a module-level string constant declared in this file, never input. This is the CLI's terminal error line; no user- or worker-supplied value reaches the template.
    console.error(`[${SCRIPT}] failed:`, err);
    process.exit(1);
  });
}
