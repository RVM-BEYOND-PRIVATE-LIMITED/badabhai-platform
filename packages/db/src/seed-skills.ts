/**
 * Skill-vocabulary seed (ADR-0030 / TAX-2) — loads the canonical `@badabhai/taxonomy`
 * SKILL_CORPUS into `skill` (+ its source aliases into `skill_alias`, embedding = NULL).
 *
 * GUARDED by `opsGuard`, which classifies the TARGET rather than the process: a write to a
 * production-like database needs the `--i-am-authorised-to-write-to-production` flag AND
 * `OPS_ALLOW_PRODUCTION=seed:skills`.
 *
 * `--plan` previews the run and writes nothing. It exists because this is the MANDATORY FIRST
 * step of the D2 sequence — `seed:domain-skills` refuses until the shipped skills its corpus
 * references exist — and it was the only step of that sequence that could not be looked at
 * beforehand.
 *   The corpus is reference data, but seeding is an ops action — kept off prod by default.
 * IDEMPOTENT: skills upsert on the immutable `skill_id` (labels/domain propagate; the id
 *   never changes); aliases use a DETERMINISTIC id derived from (skill_id, text, lang) with
 *   ON CONFLICT DO NOTHING — so a re-run is a no-op at the row level AND never clobbers an
 *   embedding a later phase (TAX-4) may have written. Double-run → identical row counts.
 * PRIVACY (ADR-0030 SG-1): the corpus is reference vocabulary — no worker PII anywhere.
 * NOT embeddings: `skill_alias.embedding` stays NULL here; embedding is TAX-3/4 (a gated
 *   real provider call). The RVM Hinglish wedge + its aliases are TAX-5, not this seed.
 *
 *   pnpm db:seed:skills
 *   pnpm db:seed:skills --preserve-existing-status
 *   (DATABASE_URL is read from the environment / repo-root .env, like the other seeds.
 *    Build @badabhai/taxonomy first — `pnpm build` — so the corpus resolves.)
 *
 * ===========================================================================
 * `--preserve-existing-status` — the S3-A flag
 * ===========================================================================
 * The stock seeder writes `status: s.status` on conflict, so re-seeding an existing row APPLIES
 * whatever the corpus now says. That is correct for a fresh environment and wrong for S3-A,
 * whose entire premise is landing the corpus WITHOUT changing what production currently serves:
 * four corpus rows are `deprecated`/`provisional` while production has them `active`, and the
 * stock seeder would flip all four in the same run that adds 98 new skills.
 *
 * With the flag, for a row that ALREADY EXISTS the `status` column is omitted from the update
 * and production's value wins. A NEW row still takes the corpus status — there is nothing to
 * preserve. Every held row is reported by id, because a silent divergence between corpus and
 * database is the thing the flag creates and therefore the thing it must make visible.
 *
 * PASS 2 is skipped for held rows too, and that is not an optimisation. The CHECK is
 * `replaced_by IS NULL OR status = 'deprecated'`; writing a pointer onto a row whose status was
 * preserved as `active` violates it, which would turn a safety flag into a failed migration.
 *
 * Default OFF: without it this file behaves exactly as it did before the flag existed.
 */
import {
  SKILL_CORPUS,
  ratifiedWedgeAliases,
  validateSkillCorpus,
  validateWedgeAliases,
  type SkillSeed,
} from "@badabhai/taxonomy";
import { config } from "dotenv";
import { and, eq, sql as dsql } from "drizzle-orm";

import { createDbClient } from "./client";
import { enforceOpsGuard } from "./ops-guard";
import { skillAliases, skills } from "./schema";
import { deterministicAliasId as aliasId } from "./skill-alias-id";

// Load the repo-root .env (CWD is packages/db when run via the package script).
config({ path: "../../.env" });

/**
 * Which existing rows must keep the status they already have.
 *
 * Pure and exported so the rule is testable without a database — the flag's whole job is to NOT
 * write something, and "we ran it and nothing happened" is indistinguishable from a no-op bug.
 *
 * Only rows that ALREADY EXIST are held. A corpus row absent from the database has no status to
 * preserve, so it takes the corpus's.
 */
export function heldSkillIds(
  corpus: readonly { skillId: string; status: string }[],
  existing: ReadonlyMap<string, string>,
): { skillId: string; corpusStatus: string; dbStatus: string }[] {
  const out: { skillId: string; corpusStatus: string; dbStatus: string }[] = [];
  for (const s of corpus) {
    const dbStatus = existing.get(s.skillId);
    if (dbStatus === undefined) continue;
    if (dbStatus === s.status) continue; // nothing to hold — they already agree
    out.push({ skillId: s.skillId, corpusStatus: s.status, dbStatus });
  }
  return out.sort((a, b) => a.skillId.localeCompare(b.skillId));
}

/** Short name for `OPS_ALLOW_PRODUCTION`. Must match what an operator exports. */
const SCRIPT = "seed:skills";

/**
 * What a seed would do, computed without writing anything.
 *
 * WHY THIS EXISTS. Every other step of the D2 sequence can be previewed —
 * `db:seed:domain-skills`, `db:embed:skills` and `db:promote:skills` are all dry-run-by-default.
 * This one could not be, and it is the step that must run FIRST: `seed:domain-skills` refuses
 * until the shipped skills its corpus references exist, and on production 16 of them do not.
 * So the mandatory first step of the phase's largest irreversible write was also the only one
 * nobody could look at beforehand.
 *
 * PURE, so the interesting cases are unit tests rather than a rehearsal against a real database.
 * It takes the corpus and a snapshot of what the database currently holds, and returns the diff.
 */
export interface SeedSkillsPlan {
  /** Corpus rows with no matching `skill_id` — these are INSERTs. */
  readonly newSkills: readonly string[];
  /** Existing rows where at least one written column differs, with the fields that differ. */
  readonly changedSkills: readonly { readonly skillId: string; readonly fields: readonly string[] }[];
  /** Existing rows whose status the corpus would change but `--preserve-existing-status` holds. */
  readonly heldSkills: readonly { readonly skillId: string; readonly dbStatus: string; readonly corpusStatus: string }[];
  /** Alias ids the corpus + ratified wedge would insert that are not present. */
  readonly newAliases: readonly string[];
  /** Alias ids already present — `ON CONFLICT DO NOTHING`, so untouched (vectors safe). */
  readonly unchangedAliases: number;
  /** `replaced_by` pointers PASS 2 would write. */
  readonly crosswalkWrites: readonly string[];
}

/** A row of `skill` as the seeder writes it, for comparison. */
export interface LiveSkillRow {
  readonly skillId: string;
  readonly labelEn: string;
  readonly labelHi: string;
  readonly domainId: string;
  readonly source: string;
  readonly status: string;
  readonly replacedBy: string | null;
}

export function planSeedSkills(
  corpus: readonly SkillSeed[],
  live: readonly LiveSkillRow[],
  liveAliasIds: ReadonlySet<string>,
  wedge: readonly { skillId: string; alias: { text: string; lang: string } }[],
  preserveStatus: boolean,
): SeedSkillsPlan {
  const byId = new Map(live.map((r) => [r.skillId, r]));
  const existingStatus = new Map(live.map((r) => [r.skillId, r.status]));
  const heldIds = new Set(
    preserveStatus ? heldSkillIds(corpus, existingStatus).map((h) => h.skillId) : [],
  );

  const newSkills: string[] = [];
  const changedSkills: { skillId: string; fields: string[] }[] = [];
  const heldSkills: { skillId: string; dbStatus: string; corpusStatus: string }[] = [];
  const crosswalkWrites: string[] = [];
  const plannedAliasIds = new Set<string>();

  for (const s of corpus) {
    const row = byId.get(s.skillId);
    if (row === undefined) {
      newSkills.push(s.skillId);
    } else {
      const fields: string[] = [];
      if (row.labelEn !== s.labelEn) fields.push("label_en");
      if (row.labelHi !== s.labelHi) fields.push("label_hi");
      if (row.domainId !== s.domainId) fields.push("domain_id");
      if (row.source !== s.source) fields.push("source");
      if (heldIds.has(s.skillId)) {
        heldSkills.push({ skillId: s.skillId, dbStatus: row.status, corpusStatus: s.status });
      } else if (row.status !== s.status) {
        fields.push(`status (${row.status} -> ${s.status})`);
      }
      if (fields.length > 0) changedSkills.push({ skillId: s.skillId, fields });
    }

    for (const a of s.aliases) plannedAliasIds.add(aliasId(s.skillId, a.text, a.lang));

    // PASS 2 writes a pointer only when the corpus carries one, the row is not held, and the
    // value actually differs — the same three conditions the writer applies.
    if (s.replacedBy !== undefined && !heldIds.has(s.skillId)) {
      const row2 = byId.get(s.skillId);
      if (row2 === undefined || row2.replacedBy !== s.replacedBy) crosswalkWrites.push(s.skillId);
    }
  }

  for (const w of wedge) plannedAliasIds.add(aliasId(w.skillId, w.alias.text, w.alias.lang));

  const newAliases = [...plannedAliasIds].filter((id) => !liveAliasIds.has(id)).sort();

  return {
    newSkills: newSkills.sort(),
    changedSkills: changedSkills.sort((a, b) => a.skillId.localeCompare(b.skillId)),
    heldSkills: heldSkills.sort((a, b) => a.skillId.localeCompare(b.skillId)),
    newAliases,
    unchangedAliases: plannedAliasIds.size - newAliases.length,
    crosswalkWrites: crosswalkWrites.sort(),
  };
}

/** The plan as an operator reads it. Ids and counts only — no PII is reachable here anyway. */
export function renderSeedSkillsPlan(plan: SeedSkillsPlan, preserveStatus: boolean): string[] {
  const L: string[] = [
    "[seed:skills] PLAN — nothing was written.",
    "",
    `  new skills            = ${plan.newSkills.length}`,
    `  changed skills        = ${plan.changedSkills.length}`,
    `  held statuses         = ${plan.heldSkills.length}${preserveStatus ? "" : "   (--preserve-existing-status NOT set)"}`,
    `  new aliases           = ${plan.newAliases.length}  (embedding NULL — run db:embed:skills after)`,
    `  aliases already there = ${plan.unchangedAliases}  (DO NOTHING; existing vectors untouched)`,
    `  crosswalk pointers    = ${plan.crosswalkWrites.length}`,
    "",
  ];
  if (plan.newSkills.length > 0) {
    L.push("  NEW — these do not exist on the target:");
    for (const s of plan.newSkills) L.push(`    + ${s}`);
    L.push("");
  }
  if (plan.changedSkills.length > 0) {
    L.push("  CHANGED — existing rows the corpus would overwrite:");
    for (const c of plan.changedSkills) L.push(`    ~ ${c.skillId.padEnd(38)} ${c.fields.join(", ")}`);
    L.push("");
  }
  if (plan.heldSkills.length > 0) {
    L.push("  HELD — the corpus would change these statuses and --preserve-existing-status will not:");
    for (const h of plan.heldSkills) {
      L.push(`    = ${h.skillId.padEnd(38)} db=${h.dbStatus.padEnd(12)} corpus=${h.corpusStatus}`);
    }
    L.push("");
  }
  if (!preserveStatus && plan.changedSkills.some((c) => c.fields.some((f) => f.startsWith("status")))) {
    L.push("  WARNING: a status change is planned and --preserve-existing-status is NOT set.");
    L.push("  On production that flag is mandatory — the corpus deprecates rows production has active.");
    L.push("");
  }
  L.push("  Re-run without --plan to apply. A production write also needs the two ops-guard signals.");
  return L;
}

async function main(): Promise<void> {
  // THE TARGET DECIDES, NOT `NODE_ENV`. Stated precisely, because the old line was NOT simply
  // inert here: this repository's `.env` sets `NODE_ENV=production`, dotenv loads it above, and
  // the old guard therefore refused — every run, including a read-only one this seeder does not
  // have. What it was, was protection that lived in one line of a GITIGNORED file. A fresh
  // clone, CI, or a teammate whose `.env` omits that line points at the same production
  // database with nothing in the way, and the obvious cure for the over-refusal — delete the
  // line — removes the write protection in the same gesture. This is the D2 seed, the largest
  // irreversible write in the taxonomy phase, so where the protection lives matters.
  //
  // `--plan` is the only non-mutating invocation, and the expression asks whether it is PRESENT
  // so that any flag combination this file does not know about is treated as MUTATING. It was
  // added with the guard: this is the mandatory FIRST step of D2 and it was previously the only
  // step of that sequence nobody could preview.
  const { connectionString: url } = enforceOpsGuard({
    script: SCRIPT,
    connectionString: process.env.DATABASE_URL,
    mutating: !process.argv.slice(2).includes("--plan"),
  });

  // Never seed an invalid corpus (unknown domain / bad source / dup id).
  const problems = validateSkillCorpus();
  if (problems.length > 0) {
    throw new Error(`[seed:skills] corpus invalid:\n  - ${problems.join("\n  - ")}`);
  }
  // TAX-5 wedge aliases must target existing corpus ids (additive, SG-5).
  const wedgeProblems = validateWedgeAliases(new Set(SKILL_CORPUS.map((c) => c.skillId)));
  if (wedgeProblems.length > 0) {
    throw new Error(`[seed:skills] wedge aliases invalid:\n  - ${wedgeProblems.join("\n  - ")}`);
  }

  const preserveStatus = process.argv.slice(2).some((a) => a === "--preserve-existing-status");
  const planOnly = process.argv.slice(2).some((a) => a === "--plan");

  const now = new Date();
  const { db, sql } = createDbClient(url, { max: 1 });
  try {
    if (planOnly) {
      // READ, COMPARE, PRINT, STOP. Deliberately before any counter is touched, so there is no
      // path from here into the write passes below.
      const liveRows = (await db.execute(
        dsql`SELECT skill_id, label_en, label_hi, domain_id, source, status, replaced_by FROM skill`,
      )) as unknown as {
        skill_id: string;
        label_en: string;
        label_hi: string;
        domain_id: string;
        source: string;
        status: string;
        replaced_by: string | null;
      }[];
      const liveAliases = (await db.execute(
        dsql`SELECT id FROM skill_alias`,
      )) as unknown as { id: string }[];
      const plan = planSeedSkills(
        SKILL_CORPUS as readonly SkillSeed[],
        liveRows.map((r) => ({
          skillId: r.skill_id,
          labelEn: r.label_en,
          labelHi: r.label_hi,
          domainId: r.domain_id,
          source: r.source,
          status: r.status,
          replacedBy: r.replaced_by,
        })),
        new Set(liveAliases.map((a) => a.id)),
        ratifiedWedgeAliases(),
        preserveStatus,
      );
      for (const line of renderSeedSkillsPlan(plan, preserveStatus)) console.log(line);
      return;
    }

    let skillCount = 0;
    let aliasCount = 0;

    // Read BEFORE writing anything: once PASS 1 has run, "what did production have" is gone.
    const held = new Map<string, { corpusStatus: string; dbStatus: string }>();
    if (preserveStatus) {
      const rows = (await db.execute(
        dsql`SELECT skill_id, status FROM skill`,
      )) as unknown as { skill_id: string; status: string }[];
      const existing = new Map(rows.map((r) => [r.skill_id, r.status]));
      for (const h of heldSkillIds(SKILL_CORPUS as readonly SkillSeed[], existing)) {
        held.set(h.skillId, { corpusStatus: h.corpusStatus, dbStatus: h.dbStatus });
      }
      console.log(
        `[seed:skills] --preserve-existing-status: ${existing.size} row(s) already in the ` +
          `database; ${held.size} would have had their status changed and will be HELD.`,
      );
      for (const [id, h] of [...held].sort()) {
        console.log(`  HOLD ${id.padEnd(34)} db=${h.dbStatus.padEnd(12)} corpus=${h.corpusStatus} (not written)`);
      }
    }

    for (const s of SKILL_CORPUS as readonly SkillSeed[]) {
      const isHeld = held.has(s.skillId);
      // 1) The canonical skill — upsert on the immutable skill_id (id never changes).
      //    replaced_by handling is SPLIT across the two passes to satisfy both the
      //    self-FK and the CHECK (`replaced_by IS NULL OR status='deprecated'`):
      //    - corpus carries NO pointer → clear it HERE, in the SAME update as the
      //      status write. Without this, REACTIVATING a deprecated skill deadlocks:
      //      PASS 1's status:='active' with the old pointer still set violates the
      //      CHECK (it evaluates the full new tuple) before PASS 2 could clear it.
      //      Clearing to NULL is always FK-safe.
      //    - corpus carries a pointer → left untouched here (the successor row may
      //      not exist yet); PASS 2 sets it after every skill row exists.
      const clearsPointer = s.replacedBy === undefined;
      await db
        .insert(skills)
        .values({
          skillId: s.skillId,
          labelEn: s.labelEn,
          labelHi: s.labelHi,
          domainId: s.domainId,
          source: s.source,
          status: s.status,
          replacedBy: null, // PASS 2 sets pointers once all rows exist
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: skills.skillId,
          set: {
            labelEn: s.labelEn,
            labelHi: s.labelHi,
            domainId: s.domainId,
            source: s.source,
            // HELD: omit `status` entirely so the existing value survives the update. Labels,
            // domain and source still propagate — the flag preserves the LIFECYCLE decision,
            // not the whole row, and holding metadata too would make the corpus unlandable.
            ...(isHeld ? {} : { status: s.status }),
            // A held row also keeps its pointer. `clearsPointer` would write NULL, which is
            // harmless on its own, but pairing "status preserved as active" with a pointer
            // rewrite is the exact combination the CHECK rejects.
            ...(clearsPointer && !isHeld ? { replacedBy: null } : {}),
            updatedAt: now,
          },
        });
      skillCount += 1;

      // 2) Source aliases — deterministic id + DO NOTHING (idempotent, embedding-safe).
      //    domain_id is denormalized from the skill (ADR-0030 domain-scoped filter).
      for (const a of s.aliases) {
        await db
          .insert(skillAliases)
          .values({
            id: aliasId(s.skillId, a.text, a.lang),
            skillId: s.skillId,
            text: a.text,
            lang: a.lang,
            source: a.source,
            domainId: s.domainId,
            // embedding stays NULL — TAX-3/4 populates it via a gated real call.
          })
          .onConflictDoNothing({ target: skillAliases.id });
        aliasCount += 1;
      }
    }

    // 3) TAX-5 wedge aliases — RATIFIED ONLY (TAX-0 gate d: the RVM human flips
    //    `ratified` in packages/taxonomy/src/wedge-aliases.ts; proposed rows never seed).
    //    Same deterministic-id + DO NOTHING idempotency; domain denormalized from the skill.
    let wedgeCount = 0;
    const domainBySkill = new Map(SKILL_CORPUS.map((c) => [c.skillId, c.domainId]));
    for (const w of ratifiedWedgeAliases()) {
      await db
        .insert(skillAliases)
        .values({
          id: aliasId(w.skillId, w.alias.text, w.alias.lang),
          skillId: w.skillId,
          text: w.alias.text,
          lang: w.alias.lang,
          source: w.alias.source,
          domainId: domainBySkill.get(w.skillId)!,
          // embedding stays NULL — run `pnpm db:embed:skills` after seeding.
        })
        .onConflictDoNothing({ target: skillAliases.id });
      wedgeCount += 1;
    }

    // 4) PASS 2 — TAX-9 crosswalk sync: SET pointers only (clearing happened in PASS 1
    //    alongside the status write — see the CHECK note there). Runs after every skill
    //    row exists, so the self-FK always resolves on a fresh DB. IS DISTINCT FROM
    //    keeps the re-run a no-op. Corpus validation already guaranteed the target
    //    exists and status is 'deprecated' (the DB CHECK backstops it by name).
    let crosswalkCount = 0;
    let crosswalkHeld = 0;
    for (const s of SKILL_CORPUS as readonly SkillSeed[]) {
      if (s.replacedBy === undefined) continue;
      // A HELD row kept production's status, which is `active`. The CHECK is
      // `replaced_by IS NULL OR status = 'deprecated'`, so writing the corpus's pointer here
      // would fail the constraint and take the whole seed down. Skipping is not a compromise:
      // the pointer belongs with the deprecation, and S3-D applies both together.
      if (held.has(s.skillId)) {
        crosswalkHeld += 1;
        continue;
      }
      const updated = await db
        .update(skills)
        .set({ replacedBy: s.replacedBy, updatedAt: now })
        .where(
          and(
            eq(skills.skillId, s.skillId),
            dsql`${skills.replacedBy} IS DISTINCT FROM ${s.replacedBy}`,
          ),
        )
        .returning({ id: skills.skillId });
      if (updated.length > 0) crosswalkCount += 1;
    }

    console.log("[seed:skills] skill vocabulary seeded (embeddings NULL — TAX-3/4 populates):");
    console.log(`  skills  = ${skillCount}`);
    console.log(`  aliases = ${aliasCount} (deterministic ids; re-run is a no-op)`);
    console.log(`  wedge   = ${wedgeCount} ratified vernacular aliases (proposed ones stay out)`);
    console.log(`  crosswalk = ${crosswalkCount} replaced_by pointer(s) synced (TAX-9)`);
    if (preserveStatus) {
      console.log(
        `  HELD    = ${held.size} row(s) kept the status production already had; ` +
          `${crosswalkHeld} replaced_by pointer(s) deliberately NOT written for them.`,
      );
      if (held.size > 0) {
        console.log(
          `            The corpus and the database now disagree about those ids ON PURPOSE. ` +
            `S3-D is the stage that reconciles them.`,
        );
      }
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

// GUARDED: this module now exports `heldSkillIds`, so importing it must not run the seed.
if (require.main === module) {
  main().catch((err) => {
    console.error("[seed:skills] failed:", err);
    process.exit(1);
  });
}
