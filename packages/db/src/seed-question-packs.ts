/**
 * Question-pack seed (migration 0069) — loads packages/db/data/question-packs into
 * `profiling_family`, `profiling_family_binding`, `question_pack`, `question_pack_item`
 * and `question_pack_option`.
 *
 *   pnpm db:seed:packs              # DRY RUN — plans and prints, writes nothing
 *   pnpm db:seed:packs --apply      # writes
 *
 * GUARDS come from the shared `match-v1-cli` harness rather than being re-implemented:
 * dry-run is the DEFAULT, production needs the explicit confirm token, and DATABASE_URL
 * must be set with NO localhost fallback. Same reasoning as `seed-job-domains.ts` — a
 * seed of reference rows pointed at the wrong database is what that harness exists to
 * prevent.
 *
 * NEVER SEEDS AN INVALID CORPUS. `resolveQuestionPackCorpus` throws with every problem
 * listed, because the failure modes here are silent once written: a dangling ask_if key
 * makes a question never appear, and nothing at run time reports it.
 *
 * IDEMPOTENT, and the shape of that idempotency is deliberate per table:
 *   - FAMILIES upsert on `family_id`, so re-running propagates a label edit without
 *     minting a second row;
 *   - BINDINGS are replaced wholesale — deleted, then re-inserted from the corpus. They
 *     have no stable surrogate key to upsert against, and the six partial unique indexes
 *     mean a re-run with a MOVED target would collide with the very row it is replacing.
 *     The cost is that this table is empty for the width of the transaction, which is
 *     precisely why the transaction below is not optional;
 *   - a pack's ITEMS and OPTIONS are DELETED and re-inserted for that (pack_id, version).
 *     That looks heavier than an upsert and is the right call: item_id is a surrogate, so
 *     an upsert key would have to be (pack, version, question_key), and a question REMOVED
 *     from the corpus would then linger in the database forever. Delete-then-insert makes
 *     the committed file the whole truth for a pack version.
 *
 * WHY DELETING ITEMS IS SAFE. `question_pack_item.item_id` is referenced only by
 * `question_pack_option` (ON DELETE CASCADE). Worker answers live in `worker_pack_answer`
 * keyed by (worker, pack_id, question_key) — NOT by item_id — precisely so that
 * re-seeding a pack cannot orphan an answer. That is the payoff for `question_key` being
 * stable across versions.
 *
 * ONE TRANSACTION OVER THE WHOLE SEED, NOT ONE PER PACK. A production apply died with
 * ECONNRESET while writing an option of the FIFTH of 145 packs. Nothing was wrapped, so
 * every statement had already autocommitted, and the database was left in a state no
 * version of the corpus has ever described: `qp_assembly` holding one of its five
 * questions and one of its five options while still `status = 'active'` — a live trade
 * serving a truncated interview — the bindings table rewritten end to end, and the 140
 * packs after it untouched, so a brand-new family sat live with six bindings and no pack
 * behind it. None of that trips a constraint. A half-written pack is not an error, it is
 * just a shorter conversation, which is exactly why nothing reported it.
 *
 * Per-pack transactions would have made the wreck smaller without making it detectable —
 * the corpus is ONE artefact, and "4 packs of 145 landed" is not a state anyone can reason
 * about. One transaction makes the corpus flip over at COMMIT: readers hold the old
 * snapshot under MVCC until then, so no worker can be handed a pack that is mid-rewrite,
 * and a failed run needs no recovery reasoning at all — re-run it.
 *
 * The transaction is cheap to HOLD because of the batching below (10 statements, not
 * 2,295), so this is not a long-running lock on the profiling tables. `max: 1` is fine
 * for it: drizzle's postgres.js driver runs `db.transaction` on a RESERVED connection
 * (`sql.begin`), so every statement inside must go through `tx` — a stray `db.` call in
 * the callback would wait forever for the one connection its own transaction is holding.
 *
 * BATCHED BY `--batch-size`, WHICH THIS SCRIPT USED TO PRINT AND THEN IGNORE. At today's
 * corpus the old shape was 2,295 sequential single-row round trips to a remote Supabase
 * over one connection (104 + 1 + 115 + 145 + 145 + 665 + 1120), which is not so much slow
 * as LONG: a window minutes wide in which any blip lands mid-corpus, which is how the
 * incident above happened at all. Chunked multi-row statements take it to 10, plus BEGIN
 * and COMMIT. Chunk sizes are DERIVED from each statement's column count via
 * `chunkSizeForColumns` and never taken from the flag directly — `--batch-size` accepts up
 * to 10000, and a 19-column item insert crosses Postgres' 65535-parameter Bind ceiling at
 * 3,450 rows (3,450 x 19 = 65,550). `chunkSizeForColumns` clamps a requested 10000 to
 * 3,445, which is the ceiling less `chunk.ts`'s statement headroom, not the raw ceiling.
 *
 * THE RETURNING ORDER IS NOT THE VALUES ORDER. Options reference `item_id`, a surrogate
 * the database mints, so the item insert has to hand its ids back. Postgres does NOT
 * promise that `RETURNING` rows arrive in the order the `VALUES` list was written; that
 * held by accident while every item was its own statement and stops being safe the moment
 * they are batched. So the insert returns each item's NATURAL key beside its id and
 * options are attached BY THAT KEY. The key is the full triple
 * (pack_id, pack_version, question_key), never `question_key` alone: a question key is
 * unique only WITHIN a pack — the corpus validator says so and `qpi_pack_question_uq`
 * enforces it — while a chunk of 500 items spans packs, and `experience_years` lives in
 * most of them. Matching on the bare key would hang one pack's chips off another pack's
 * question, and nothing downstream would report that either.
 *
 * PRIVACY: reviewed interview copy and occupation references. No worker data, and every
 * log line is ids and counts.
 */
import { sql as dsql } from "drizzle-orm";

import { chunked, chunkSizeForColumns } from "./chunk";
import { createDbClient } from "./client";
import { parseCommonCli, printCounts, printFooter, printHeader } from "./match-v1-cli";
import {
  bindingSpecificity,
  resolveQuestionPackCorpus,
  summariseQuestionPackCorpus,
  type BindingRecord,
  type FamilyRecord,
  type PackItemRecord,
  type PackRecord,
} from "./question-pack-corpus";
import {
  profilingFamilies,
  profilingFamilyBindings,
  questionPackItems,
  questionPackOptions,
  questionPacks,
} from "./schema";

const SCRIPT = "seed:packs";

// ===========================================================================
// Bound-parameter budgets
//
// One per multi-row statement. Each MUST equal the number of fields the matching planner
// puts on a row: a column added to a planner without a bump here quietly eats the margin
// under the 65535-parameter ceiling, and the symptom would be a production apply that
// fails only once the corpus grows. `seed-question-packs.test.ts` asserts the equality
// instead of leaving it to review.
//
// `item_id` and `created_at` are NOT counted: drizzle emits the `DEFAULT` keyword for a
// column no row supplies, which binds nothing.
// ===========================================================================

/** `profiling_family` values bound per row. */
export const FAMILY_INSERT_COLUMNS = 7;
/** `profiling_family_binding` values bound per row. */
export const BINDING_INSERT_COLUMNS = 8;
/** `question_pack` values bound per row. */
export const PACK_INSERT_COLUMNS = 7;
/** `question_pack_item` values bound per row. */
export const ITEM_INSERT_COLUMNS = 19;
/** `question_pack_option` values bound per row. */
export const OPTION_INSERT_COLUMNS = 9;
/** (pack_id, pack_version) — what the item DELETE binds per pack. */
export const PACK_KEY_COLUMNS = 2;

// ===========================================================================
// Pure planners
//
// Everything decidable without a database lives here, so the part that actually goes
// wrong — display ordering, `?? null` coalescing, and above all which item an option
// belongs to — is unit-testable. The SQL half is a handful of statements whose
// correctness is a property of the schema constraints, and proving that needs a real
// Postgres: that is `db:verify:packs`, not a unit test pretending to have one.
// ===========================================================================

/** A `profiling_family` row this seed would upsert. */
export interface PlannedFamilyRow {
  familyId: string;
  labelEn: string;
  labelHi: string | null;
  canonicalRoleId: string | null;
  industryId: string | null;
  status: NonNullable<FamilyRecord["status"]>;
  updatedAt: Date;
}

export function planFamilyRows(families: readonly FamilyRecord[], now: Date): PlannedFamilyRow[] {
  return families.map((f) => ({
    familyId: f.family_id,
    labelEn: f.label_en,
    labelHi: f.label_hi ?? null,
    canonicalRoleId: f.canonical_role_id ?? null,
    industryId: f.industry_id ?? null,
    status: f.status ?? "active",
    updatedAt: now,
  }));
}

/** A `profiling_family_binding` row this seed would insert. */
export interface PlannedBindingRow {
  familyId: string;
  jobDomainId: string | null;
  iscoUnitCode: string | null;
  iscoMinorCode: string | null;
  iscoSubmajorCode: string | null;
  iscoMajorCode: string | null;
  isUniversal: boolean;
  specificity: number;
}

/**
 * A binding with no derivable specificity is DROPPED, which is what the old loop's
 * `continue` did. The branch is unreachable from `resolveQuestionPackCorpus` — the
 * validator rejects a binding with no target — and exists so that a future caller handing
 * this function unvalidated records cannot write a row that violates
 * `pfb_specificity_matches_target_chk`.
 */
export function planBindingRows(bindings: readonly BindingRecord[]): PlannedBindingRow[] {
  const rows: PlannedBindingRow[] = [];
  for (const b of bindings) {
    const spec = bindingSpecificity(b);
    if (spec === null) continue;
    rows.push({
      familyId: b.family_id,
      jobDomainId: b.job_domain_id ?? null,
      iscoUnitCode: b.isco_unit_code ?? null,
      iscoMinorCode: b.isco_minor_code ?? null,
      iscoSubmajorCode: b.isco_submajor_code ?? null,
      iscoMajorCode: b.isco_major_code ?? null,
      isUniversal: b.is_universal ?? false,
      specificity: spec,
    });
  }
  return rows;
}

/** A `question_pack` row this seed would upsert. */
export interface PlannedPackRow {
  packId: string;
  version: number;
  familyId: string;
  locale: string;
  status: NonNullable<PackRecord["status"]>;
  reviewNote: string | null;
  updatedAt: Date;
}

export function planPackRows(packs: readonly PackRecord[], now: Date): PlannedPackRow[] {
  return packs.map((p) => ({
    packId: p.pack_id,
    version: p.version,
    familyId: p.family_id,
    locale: p.locale ?? "hi-IN",
    status: p.status ?? "draft",
    reviewNote: p.review_note ?? null,
    updatedAt: now,
  }));
}

/** A `question_pack_item` row this seed would insert. */
export interface PlannedItemRow {
  packId: string;
  packVersion: number;
  questionKey: string;
  displayOrder: number;
  promptText: string;
  whyText: string | null;
  retryText: string | null;
  targetKind: PackItemRecord["target_kind"];
  targetField: string | null;
  targetSkillId: string | null;
  answerType: PackItemRecord["answer_type"];
  isMandatory: boolean;
  isCore: boolean;
  maxAsks: number;
  minTurn: number | null;
  maxTurn: number | null;
  askIf: unknown;
  skipIf: unknown;
  parentItemKey: string | null;
}

/**
 * `display_order` is the item's index WITHIN ITS PACK and restarts at 0 for every pack,
 * exactly as the old per-pack loop counter did. It is the interview's running order, so a
 * counter carried across packs would not merely renumber rows — it would reorder the
 * conversation for all 144 packs after the first.
 */
export function planItemRows(packs: readonly PackRecord[]): PlannedItemRow[] {
  const rows: PlannedItemRow[] = [];
  for (const p of packs) {
    let order = 0;
    for (const it of p.items) {
      rows.push({
        packId: p.pack_id,
        packVersion: p.version,
        questionKey: it.question_key,
        displayOrder: order++,
        promptText: it.prompt_text,
        whyText: it.why_text ?? null,
        retryText: it.retry_text ?? null,
        targetKind: it.target_kind,
        targetField: it.target_field ?? null,
        targetSkillId: it.target_skill_id ?? null,
        answerType: it.answer_type,
        isMandatory: it.is_mandatory ?? false,
        isCore: it.is_core ?? false,
        maxAsks: it.max_asks ?? 2,
        minTurn: it.min_turn ?? null,
        maxTurn: it.max_turn ?? null,
        askIf: it.ask_if ?? null,
        skipIf: it.skip_if ?? null,
        parentItemKey: it.parent_item_key ?? null,
      });
    }
  }
  return rows;
}

/**
 * The item's NATURAL key — the one `qpi_pack_question_uq` is declared on.
 *
 * The separator is a character no component can contain: `question_pack_id_chk` pins pack
 * ids to `^qp_[a-z0-9_]+$`, `qpi_question_key_chk` pins question keys to `^[a-z_]+$`, and
 * the version is an integer. Nothing can therefore smuggle a separator in and forge a
 * collision with another item's key.
 */
export const ITEM_KEY_SEPARATOR = "|";

export function itemKey(packId: string, packVersion: number, questionKey: string): string {
  return [packId, packVersion, questionKey].join(ITEM_KEY_SEPARATOR);
}

/** What `RETURNING` must hand back for an option to find its item. */
export interface InsertedItemRow {
  itemId: string;
  packId: string;
  packVersion: number;
  questionKey: string;
}

/**
 * Index the inserted items by natural key, in whatever order the server returned them.
 *
 * THROWS on a repeated key. `qpi_pack_question_uq` makes a genuine duplicate impossible,
 * so a collision here means the returned rows are not what this code believes they are —
 * most plausibly because someone narrowed the key. Refusing is the whole point: silently
 * keeping the last writer is how the wrong item_id reaches an option.
 */
export function indexItemIds(rows: readonly InsertedItemRow[]): Map<string, string> {
  const byKey = new Map<string, string>();
  for (const r of rows) {
    const key = itemKey(r.packId, r.packVersion, r.questionKey);
    if (byKey.has(key)) {
      throw new Error(
        `[${SCRIPT}] two inserted items share the key ${r.packId} v${r.packVersion} ` +
          `${r.questionKey} — the item key is not identifying`,
      );
    }
    byKey.set(key, r.itemId);
  }
  return byKey;
}

/** A `question_pack_option` row this seed would insert. */
export interface PlannedOptionRow {
  itemId: string;
  optionKey: string;
  displayOrder: number;
  labelText: string;
  valueText: string | null;
  valueNumber: number | null;
  valueBool: boolean | null;
  impliesSkillId: string | null;
  isNoneOfAbove: boolean;
}

/**
 * Attach every option to its item BY KEY, never by position — see the header.
 *
 * A MISSING ID THROWS. The old code skipped that item's options
 * (`if (itemId === undefined) continue`), which is the same damage the incident produced:
 * a live question whose chips are simply absent, with nothing at run time to notice.
 * Inside the transaction a throw rolls the entire seed back, which is the correct outcome
 * for a state this code cannot explain (CLAUDE.md §3, fail closed).
 */
export function planOptionRows(
  packs: readonly PackRecord[],
  itemIds: ReadonlyMap<string, string>,
): PlannedOptionRow[] {
  const rows: PlannedOptionRow[] = [];
  for (const p of packs) {
    for (const it of p.items) {
      const options = it.options ?? [];
      if (options.length === 0) continue;
      const itemId = itemIds.get(itemKey(p.pack_id, p.version, it.question_key));
      if (itemId === undefined) {
        throw new Error(
          `[${SCRIPT}] no item_id came back for ${p.pack_id} v${p.version} ${it.question_key} — ` +
            `its ${options.length} option(s) would have been dropped silently`,
        );
      }
      let optOrder = 0;
      for (const o of options) {
        rows.push({
          itemId,
          optionKey: o.option_key,
          displayOrder: optOrder++,
          labelText: o.label_text,
          valueText: o.value_text ?? null,
          valueNumber: o.value_number ?? null,
          valueBool: o.value_bool ?? null,
          impliesSkillId: o.implies_skill_id ?? null,
          isNoneOfAbove: o.is_none_of_above ?? false,
        });
      }
    }
  }
  return rows;
}

// ===========================================================================
// The runner
// ===========================================================================

async function main(): Promise<void> {
  const opts = parseCommonCli(SCRIPT);
  printHeader(SCRIPT, opts);

  const corpus = resolveQuestionPackCorpus();
  printCounts(SCRIPT, summariseQuestionPackCorpus(corpus));

  const { db, sql } = createDbClient(opts.databaseUrl, { max: 1 });
  try {
    if (!opts.apply) {
      printFooter(SCRIPT, opts, corpus.families.length + corpus.bindings.length + corpus.packs.length);
      return;
    }

    const now = new Date();
    const familyRows = planFamilyRows(corpus.families, now);
    const bindingRows = planBindingRows(corpus.bindings);
    const packRows = planPackRows(corpus.packs, now);
    const itemRows = planItemRows(corpus.packs);

    const familyChunk = chunkSizeForColumns(opts.batchSize, FAMILY_INSERT_COLUMNS);
    const bindingChunk = chunkSizeForColumns(opts.batchSize, BINDING_INSERT_COLUMNS);
    const packChunk = chunkSizeForColumns(opts.batchSize, PACK_INSERT_COLUMNS);
    const packKeyChunk = chunkSizeForColumns(opts.batchSize, PACK_KEY_COLUMNS);
    const itemChunk = chunkSizeForColumns(opts.batchSize, ITEM_INSERT_COLUMNS);
    const optionChunk = chunkSizeForColumns(opts.batchSize, OPTION_INSERT_COLUMNS);

    let familyWrites = 0;
    let bindingWrites = 0;
    let packWrites = 0;
    let itemWrites = 0;
    let optionWrites = 0;

    await db.transaction(async (tx) => {
      // ── Families ─────────────────────────────────────────────────────────
      // Batching turns a duplicate `family_id` inside one chunk from "the second upsert
      // wins" into `ON CONFLICT DO UPDATE cannot affect row a second time`. That is
      // strictly better and already unreachable: the validator rejects a duplicate
      // family_id, and the same applies to (pack_id, version) below.
      for (const chunk of chunked(familyRows, familyChunk)) {
        await tx
          .insert(profilingFamilies)
          .values(chunk)
          .onConflictDoUpdate({
            target: profilingFamilies.familyId,
            set: {
              labelEn: dsql`excluded.label_en`,
              labelHi: dsql`excluded.label_hi`,
              canonicalRoleId: dsql`excluded.canonical_role_id`,
              industryId: dsql`excluded.industry_id`,
              status: dsql`excluded.status`,
              updatedAt: now,
            },
          });
        familyWrites += chunk.length;
      }

      // ── Bindings ─────────────────────────────────────────────────────────
      // Replaced wholesale: a binding has no stable surrogate key, and the six partial
      // unique indexes mean a re-run with a MOVED target would otherwise collide with the
      // row it is trying to replace.
      //
      // The delete's row locks are now held until COMMIT instead of releasing immediately.
      // That is safe here and nowhere near a hot path: this seeder is the table's only
      // writer, and readers resolve bindings against the pre-commit snapshot.
      await tx.delete(profilingFamilyBindings);
      for (const chunk of chunked(bindingRows, bindingChunk)) {
        await tx.insert(profilingFamilyBindings).values(chunk);
        bindingWrites += chunk.length;
      }

      // ── Packs ────────────────────────────────────────────────────────────
      for (const chunk of chunked(packRows, packChunk)) {
        await tx
          .insert(questionPacks)
          .values(chunk)
          .onConflictDoUpdate({
            target: [questionPacks.packId, questionPacks.version],
            set: {
              familyId: dsql`excluded.family_id`,
              locale: dsql`excluded.locale`,
              status: dsql`excluded.status`,
              reviewNote: dsql`excluded.review_note`,
              updatedAt: now,
            },
          });
        packWrites += chunk.length;
      }

      // ── Items: delete, then insert ───────────────────────────────────────
      // The committed file is the whole truth for this pack version — see the header.
      // Options cascade from the item delete.
      //
      // One statement per CHUNK OF PACKS rather than per pack. The scoping is unchanged —
      // each (pack_id, pack_version) pair still names exactly the rows its own DELETE
      // named — and hoisting every delete ahead of every insert is sound only because the
      // corpus cannot carry the same (pack_id, version) twice, which the validator
      // enforces. Without that, a later pack's delete could eat an earlier one's inserts.
      //
      // EVERY VALUE IS CAST, and that is not decoration. In the old form each parameter
      // was compared straight against a column, so Postgres inferred its type from the
      // column. A VALUES list offers nothing to infer from: a column of all-unknown
      // literals resolves to `text`, `integer = text` has no operator, and the statement
      // dies at parse time with an error naming neither the column nor this line. Same
      // class of trap as the ISO-string cast in `seed-job-domains.ts`.
      for (const chunk of chunked(packRows, packKeyChunk)) {
        const keys = dsql.join(
          chunk.map((p) => dsql`(${p.packId}::text, ${p.version}::int)`),
          dsql`, `,
        );
        await tx.execute(dsql`
          DELETE FROM "question_pack_item" AS i
           USING (VALUES ${keys}) AS v(pack_id, pack_version)
           WHERE i."pack_id" = v.pack_id AND i."pack_version" = v.pack_version`);
      }

      const inserted: InsertedItemRow[] = [];
      for (const chunk of chunked(itemRows, itemChunk)) {
        const back = await tx
          .insert(questionPackItems)
          .values(chunk)
          // The natural key rides back WITH the id — the header says why position cannot.
          .returning({
            itemId: questionPackItems.itemId,
            packId: questionPackItems.packId,
            packVersion: questionPackItems.packVersion,
            questionKey: questionPackItems.questionKey,
          });
        // A short RETURNING means rows this code believes it wrote are not there. Refuse
        // rather than carry on and discover it later as questions missing from a pack.
        if (back.length !== chunk.length) {
          throw new Error(
            `[${SCRIPT}] item insert returned ${back.length} row(s) for a chunk of ${chunk.length}`,
          );
        }
        for (const r of back) inserted.push(r);
        itemWrites += back.length;
      }

      // ── Options ──────────────────────────────────────────────────────────
      const optionRows = planOptionRows(corpus.packs, indexItemIds(inserted));
      for (const chunk of chunked(optionRows, optionChunk)) {
        await tx.insert(questionPackOptions).values(chunk);
        optionWrites += chunk.length;
      }
    });

    // Reported only after COMMIT, so a printed count is a count of rows that actually
    // landed rather than of statements that were sent.
    printCounts(SCRIPT, {
      families_written: familyWrites,
      bindings_written: bindingWrites,
      packs_written: packWrites,
      items_written: itemWrites,
      options_written: optionWrites,
    });
    console.log(`[${SCRIPT}] run 'pnpm db:verify:packs' as the gate.`);
    printFooter(SCRIPT, opts, familyWrites + bindingWrites + packWrites + itemWrites + optionWrites);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (process.argv[1] && /seed-question-packs/.test(process.argv[1])) {
  main().catch((err) => {
    // nosemgrep: javascript.lang.security.audit.unsafe-formatstring.unsafe-formatstring -- `SCRIPT` is a module-level string constant declared in this file, never input. This is the CLI's terminal error line; no user- or worker-supplied value reaches the template.
    console.error(`[${SCRIPT}] failed:`, err);
    process.exit(1);
  });
}
