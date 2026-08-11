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
 *   - families and bindings UPSERT on their natural key, so re-running propagates a label
 *     edit without minting a second row;
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
 * PRIVACY: reviewed interview copy and occupation references. No worker data, and every
 * log line is ids and counts.
 */
import { sql as dsql } from "drizzle-orm";

import { createDbClient } from "./client";
import { parseCommonCli, printCounts, printFooter, printHeader } from "./match-v1-cli";
import {
  bindingSpecificity,
  resolveQuestionPackCorpus,
  summariseQuestionPackCorpus,
} from "./question-pack-corpus";
import {
  profilingFamilies,
  profilingFamilyBindings,
  questionPackItems,
  questionPackOptions,
  questionPacks,
} from "./schema";

const SCRIPT = "seed:packs";

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
    let familyWrites = 0;
    let bindingWrites = 0;
    let packWrites = 0;
    let itemWrites = 0;
    let optionWrites = 0;

    // ── Families ───────────────────────────────────────────────────────────
    for (const f of corpus.families) {
      await db
        .insert(profilingFamilies)
        .values({
          familyId: f.family_id,
          labelEn: f.label_en,
          labelHi: f.label_hi ?? null,
          canonicalRoleId: f.canonical_role_id ?? null,
          industryId: f.industry_id ?? null,
          status: f.status ?? "active",
          updatedAt: now,
        })
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
      familyWrites++;
    }

    // ── Bindings ───────────────────────────────────────────────────────────
    // Replaced wholesale: a binding has no stable surrogate key, and the six partial
    // unique indexes mean a re-run with a MOVED target would otherwise collide with the
    // row it is trying to replace.
    await db.delete(profilingFamilyBindings);
    for (const b of corpus.bindings) {
      const spec = bindingSpecificity(b);
      if (spec === null) continue; // unreachable — the validator rejected it already
      await db.insert(profilingFamilyBindings).values({
        familyId: b.family_id,
        jobDomainId: b.job_domain_id ?? null,
        iscoUnitCode: b.isco_unit_code ?? null,
        iscoMinorCode: b.isco_minor_code ?? null,
        iscoSubmajorCode: b.isco_submajor_code ?? null,
        iscoMajorCode: b.isco_major_code ?? null,
        isUniversal: b.is_universal ?? false,
        specificity: spec,
      });
      bindingWrites++;
    }

    // ── Packs, items, options ──────────────────────────────────────────────
    for (const p of corpus.packs) {
      await db
        .insert(questionPacks)
        .values({
          packId: p.pack_id,
          version: p.version,
          familyId: p.family_id,
          locale: p.locale ?? "hi-IN",
          status: p.status ?? "draft",
          reviewNote: p.review_note ?? null,
          updatedAt: now,
        })
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
      packWrites++;

      // The committed file is the whole truth for this pack version — see the header.
      // Options cascade from the item delete.
      await db.execute(dsql`
        DELETE FROM "question_pack_item"
         WHERE "pack_id" = ${p.pack_id} AND "pack_version" = ${p.version}`);

      let order = 0;
      for (const it of p.items) {
        const inserted = await db
          .insert(questionPackItems)
          .values({
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
          })
          .returning({ itemId: questionPackItems.itemId });
        itemWrites++;

        const itemId = inserted[0]?.itemId;
        if (itemId === undefined) continue;
        let optOrder = 0;
        for (const o of it.options ?? []) {
          await db.insert(questionPackOptions).values({
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
          optionWrites++;
        }
      }
    }

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
