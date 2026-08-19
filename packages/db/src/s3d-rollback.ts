/**
 * S3-D rollback — capture before, restore after. The stage that changes live retrieval was the
 * one stage with no tested way back.
 *
 * ===========================================================================
 * WHAT S3-D DOES, AND THEREFORE WHAT THIS UNDOES
 * ===========================================================================
 * Per `phase-9-s3-deployment-plan.md`, S3-D is two writes in a fixed order:
 *
 *   1. four `skill.status` -> `deprecated` with `replaced_by` set
 *      (`db:seed:skills` WITHOUT `--preserve-existing-status`)
 *   2. `db:retag:skills --apply`, which re-homes stored references AND moves the deprecated
 *      skills' alias rows onto their terminals
 *
 * Rollback reverses them in the opposite order — aliases home, then statuses back — because the
 * two are coupled through a CHECK, not merely by convention.
 *
 * ===========================================================================
 * THE THREE THINGS THAT MAKE THIS SAFE
 * ===========================================================================
 * 1. IT CANNOT RUN WITHOUT A MANIFEST CAPTURED BEFORE THE STAGE. There is no "infer the
 *    previous state" mode, because the previous state is exactly what S3-D destroys: after the
 *    flip, nothing in the database records that `skill_cad_interpretation` used to be `active`.
 *    A rollback that guesses is a second incident.
 *
 * 2. IT NEVER DELETES A ROW THAT EXISTED BEFORE. The manifest lists every alias id present at
 *    capture time. Rollback may delete an alias only if its id is ABSENT from that list — i.e.
 *    only rows the retag created. Anything else is left alone and reported. This is the
 *    property that stops a rollback from becoming a data-loss event of its own, and it is the
 *    one an operator cannot check by eye at 2am.
 *
 * 3. VECTORS ARE RESTORED, NOT RE-FETCHED. The manifest does not carry 768 floats per row —
 *    that would make it megabytes and invite someone to treat it as a backup. It does not need
 *    to: `retag-skills` copies the embedding onto the terminal before deleting the predecessor,
 *    so the vector is still in the database and rollback copies it back. (Before that fix the
 *    vector was destroyed outright, and a lossless rollback was impossible — which is part of
 *    why this script could not have been written first.)
 *
 * IDEMPOTENT: every restore is conditional on the row currently differing from the manifest, so
 * a second run reports "already restored" and writes nothing.
 *
 * PRE/POST ASSERTIONS: the target is checked against the manifest before anything is written,
 * and the restored state is re-read and compared afterwards. A rollback that cannot prove it
 * worked has not finished.
 *
 * OUT OF SCOPE, deliberately: the `cnc-programming` compatibility row (S3-D step 3) is an
 * undecided taxonomy option, so there is nothing to capture yet. When it is decided it needs
 * its own line in the manifest — additive, one id.
 *
 *   pnpm db:rollback:s3d --capture=<manifest.json>   # BEFORE S3-D. Read-only.
 *   pnpm db:rollback:s3d --from=<manifest.json>      # plan the rollback. Read-only.
 *   pnpm db:rollback:s3d --from=<manifest.json> --apply
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { config } from "dotenv";
import { eq, inArray, sql as dsql } from "drizzle-orm";

import { createDbClient } from "./client";
import { opsGuard, hostClass, PRODUCTION_WRITE_ENV } from "./ops-guard";
import { skillAliases, skills } from "./schema";
import { deterministicAliasId } from "./skill-alias-id";

config({ path: "../../.env" });

const SCRIPT = "rollback:s3d";

export interface SkillSnapshot {
  readonly skillId: string;
  readonly status: string;
  readonly replacedBy: string | null;
}

export interface AliasSnapshot {
  readonly id: string;
  readonly skillId: string;
  readonly text: string;
  /** Typed loosely here and narrowed at the drizzle boundary — a manifest is JSON off disk,
   *  so it must be validated rather than asserted into an enum on the way in. */
  readonly lang: string | null;
  readonly domainId: string | null;
  readonly embedded: boolean;
}

export interface S3dManifest {
  readonly kind: "s3d-rollback-manifest";
  readonly capturedAt: string;
  readonly target: { readonly hostClass: string; readonly database: string | null };
  /** Every skill the corpus would deprecate — captured whatever its current status. */
  readonly skills: readonly SkillSnapshot[];
  /** EVERY alias id present at capture. The delete-protection list. */
  readonly aliases: readonly AliasSnapshot[];
  readonly digest: string;
}

/** Seals the manifest so a hand-edit that widens the delete-protection list is detectable. */
export function manifestDigest(m: Omit<S3dManifest, "digest">): string {
  const skills = [...m.skills]
    .map((s) => `${s.skillId}\u001f${s.status}\u001f${s.replacedBy ?? ""}`)
    .sort();
  const aliases = [...m.aliases]
    .map((a) => `${a.id}\u001f${a.skillId}\u001f${a.text}\u001f${a.lang ?? ""}\u001f${a.embedded ? "1" : "0"}`)
    .sort();
  return createHash("sha256").update([...skills, "--", ...aliases].join("\u001e"), "utf8").digest("hex");
}

export interface RollbackPlan {
  /** Skills whose (status, replaced_by) differs from the manifest and must be restored. */
  readonly skillsToRestore: readonly SkillSnapshot[];
  /** Manifest aliases that are MISSING now — retag moved them away. Re-home them. */
  readonly aliasesToRestore: readonly AliasSnapshot[];
  /** Alias ids present now, absent from the manifest — created by retag. Safe to delete. */
  readonly aliasesToDelete: readonly string[];
  /** Present now, absent from the manifest, but NOT attributable to the retag. Left alone. */
  readonly unexplainedExtras: readonly string[];
  /** Already matching the manifest — the idempotency evidence. */
  readonly alreadyCorrect: number;
}

/**
 * The whole decision, from two snapshots. Pure, so every rule is testable without a database —
 * and the rule that matters most (never delete a pre-existing row) is a set membership test
 * that must be right the first time.
 *
 * `retagCreatedIds` is derived, not trusted: an id counts as retag-created only if it is the
 * DETERMINISTIC id that moving one of the manifest's own aliases onto its terminal would
 * produce. An extra row nobody can explain that way is reported, never deleted.
 */
export function planRollback(
  manifest: S3dManifest,
  current: { skills: readonly SkillSnapshot[]; aliasIds: ReadonlySet<string> },
  terminalOf: ReadonlyMap<string, string>,
): RollbackPlan {
  const currentSkills = new Map(current.skills.map((s) => [s.skillId, s]));
  const skillsToRestore = manifest.skills.filter((m) => {
    const now = currentSkills.get(m.skillId);
    if (now === undefined) return false; // the row is gone entirely — not ours to recreate
    return now.status !== m.status || (now.replacedBy ?? null) !== (m.replacedBy ?? null);
  });

  const manifestIds = new Set(manifest.aliases.map((a) => a.id));
  const aliasesToRestore = manifest.aliases.filter((a) => !current.aliasIds.has(a.id));

  // Which ids COULD the retag have minted? Exactly: each manifest alias moved to its terminal.
  const explainable = new Set<string>();
  for (const a of manifest.aliases) {
    const terminal = terminalOf.get(a.skillId);
    if (terminal === undefined || terminal === a.skillId) continue;
    explainable.add(deterministicAliasId(terminal, a.text, a.lang));
  }

  const extras = [...current.aliasIds].filter((id) => !manifestIds.has(id));
  const aliasesToDelete = extras.filter((id) => explainable.has(id)).sort();
  const unexplainedExtras = extras.filter((id) => !explainable.has(id)).sort();

  return {
    skillsToRestore,
    aliasesToRestore,
    aliasesToDelete,
    unexplainedExtras,
    alreadyCorrect: manifest.skills.length - skillsToRestore.length,
  };
}

/** `null` when the manifest may be used against this target. */
export function manifestMismatch(m: S3dManifest, target: { hostClass: string; database: string | null }): string | null {
  if (m.kind !== "s3d-rollback-manifest") return `not an S3-D manifest (kind=${String(m.kind)})`;
  if (manifestDigest(m) !== m.digest) {
    return "digest does not match its contents — the manifest was edited after capture, and the delete-protection list can no longer be trusted";
  }
  if (m.target.hostClass !== target.hostClass || m.target.database !== target.database) {
    return `captured against ${m.target.hostClass}/${m.target.database ?? "?"} but DATABASE_URL points at ${target.hostClass}/${target.database ?? "?"}`;
  }
  return null;
}

// ===========================================================================
// IO
// ===========================================================================

async function readState(db: ReturnType<typeof createDbClient>["db"]) {
  const skillRows = (await db.execute(
    dsql`SELECT skill_id, status, replaced_by FROM skill`,
  )) as unknown as { skill_id: string; status: string; replaced_by: string | null }[];
  const aliasRows = (await db.execute(
    dsql`SELECT id::text AS id, skill_id, text, lang, domain_id, (embedding IS NOT NULL) AS embedded
         FROM skill_alias`,
  )) as unknown as {
    id: string;
    skill_id: string;
    text: string;
    lang: string | null;
    domain_id: string | null;
    embedded: boolean;
  }[];
  return {
    skills: skillRows.map((r) => ({ skillId: r.skill_id, status: r.status, replacedBy: r.replaced_by })),
    aliases: aliasRows.map((r) => ({
      id: r.id,
      skillId: r.skill_id,
      text: r.text,
      lang: r.lang,
      domainId: r.domain_id,
      embedded: r.embedded === true,
    })),
  };
}

/** The crosswalk, read from the database exactly as `retag-skills` derives it. */
function terminalMap(skillRows: readonly SkillSnapshot[]): Map<string, string> {
  const successor = new Map(skillRows.filter((s) => s.replacedBy !== null).map((s) => [s.skillId, s.replacedBy as string]));
  const byId = new Map(skillRows.map((s) => [s.skillId, s]));
  const out = new Map<string, string>();
  for (const s of skillRows) {
    const seen = new Set<string>([s.skillId]);
    let at = s.skillId;
    let ok = true;
    for (;;) {
      const next = successor.get(at);
      if (next === undefined) break;
      if (seen.has(next)) {
        ok = false;
        break;
      }
      seen.add(next);
      at = next;
    }
    if (!ok || at === s.skillId) continue;
    if (byId.get(at)?.status === "deprecated") continue; // dead end — retag holds these too
    out.set(s.skillId, at);
  }
  return out;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const captureArg = argv.find((a) => a.startsWith("--capture="));
  const fromArg = argv.find((a) => a.startsWith("--from="));
  const apply = argv.includes("--apply");

  if (captureArg === undefined && fromArg === undefined) {
    throw new Error(`[${SCRIPT}] one of --capture=<path> or --from=<path> is required.`);
  }

  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error(`[${SCRIPT}] DATABASE_URL is not set`);

  const verdict = opsGuard({
    script: "rollback-s3d",
    connectionString: url,
    nodeEnv: process.env["NODE_ENV"],
    allowEnv: process.env[PRODUCTION_WRITE_ENV],
    argv,
    mutating: apply,
  });
  if (verdict.warning !== null) console.log(verdict.warning);
  if (!verdict.allowed) throw new Error(verdict.refusal ?? `[${SCRIPT}] refused`);

  const { db, sql } = createDbClient(url, { max: 1 });
  try {
    const [where] = (await db.execute(dsql`SELECT current_database() AS db`)) as unknown as { db: string }[];
    const target = { hostClass: hostClass(url), database: where?.db ?? null };
    const state = await readState(db);

    if (captureArg !== undefined) {
      const path = captureArg.slice("--capture=".length);
      if (existsSync(path)) {
        console.error(`[${SCRIPT}] refusing to overwrite ${path} — a rollback manifest is never replaced.`);
        process.exitCode = 1;
        return;
      }
      const body: Omit<S3dManifest, "digest"> = {
        kind: "s3d-rollback-manifest",
        capturedAt: new Date().toISOString(),
        target,
        skills: state.skills,
        aliases: state.aliases,
      };
      const manifest: S3dManifest = { ...body, digest: manifestDigest(body) };
      writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      console.log(`[${SCRIPT}] CAPTURED — read-only.`);
      console.log(`  target   = ${target.hostClass} db=${target.database ?? "?"}`);
      console.log(`  skills   = ${manifest.skills.length}`);
      console.log(`  aliases  = ${manifest.aliases.length}  (this is the delete-protection list)`);
      console.log(`  digest   = ${manifest.digest.slice(0, 16)}…`);
      console.log(`  written to ${path}`);
      return;
    }

    const path = (fromArg as string).slice("--from=".length);
    if (!existsSync(path)) throw new Error(`[${SCRIPT}] manifest not found: ${path}`);
    const manifest = JSON.parse(readFileSync(path, "utf8")) as S3dManifest;

    // ── PRE-ASSERTION ────────────────────────────────────────────────────────────────────
    const mismatch = manifestMismatch(manifest, target);
    if (mismatch !== null) {
      console.error(`[${SCRIPT}] REFUSING — ${mismatch}.`);
      process.exitCode = 1;
      return;
    }

    const plan = planRollback(
      manifest,
      { skills: state.skills, aliasIds: new Set(state.aliases.map((a) => a.id)) },
      terminalMap(state.skills),
    );

    console.log(`[${SCRIPT}] ${apply ? "APPLY" : "PLAN — nothing will be written"}`);
    console.log(`  manifest captured  = ${manifest.capturedAt}`);
    console.log(`  skills to restore  = ${plan.skillsToRestore.length}  (already correct: ${plan.alreadyCorrect})`);
    for (const s of plan.skillsToRestore) console.log(`     ${s.skillId.padEnd(32)} -> status=${s.status} replaced_by=${s.replacedBy ?? "NULL"}`);
    console.log(`  aliases to re-home = ${plan.aliasesToRestore.length}`);
    console.log(`  aliases to delete  = ${plan.aliasesToDelete.length}  (retag-created only)`);
    console.log(`  UNEXPLAINED extras = ${plan.unexplainedExtras.length}  (present now, not in the manifest, NOT attributable to the retag — left alone)`);
    for (const id of plan.unexplainedExtras.slice(0, 10)) console.log(`     KEEP ${id}`);

    if (!apply) {
      const nothing =
        plan.skillsToRestore.length === 0 && plan.aliasesToRestore.length === 0 && plan.aliasesToDelete.length === 0;
      console.log(`\n  ${nothing ? "NOTHING TO DO — the database already matches the manifest." : "Re-run with --apply to restore."}`);
      return;
    }

    // ── PHASE 1: aliases home, BEFORE the statuses ───────────────────────────────────────
    // Order is load-bearing. Restoring `status='active'` while `replaced_by` is still set
    // violates `replaced_by IS NULL OR status = 'deprecated'`, so the status restore below
    // writes both columns in ONE update. Aliases move first so that, if the run is
    // interrupted between the phases, the corpus is left in the pre-retag shape rather than
    // with active skills whose vocabulary lives on their successors.
    const terminals = terminalMap(state.skills);
    let rehomed = 0;
    let rehomedWithVector = 0;
    for (const a of plan.aliasesToRestore) {
      // Copy the vector back OFF the terminal row rather than carrying 768 floats per row in
      // the manifest. `retag-skills` copied it there on the way out (that is the fix that made
      // a lossless rollback possible at all); this takes it back. Read per row, so the manifest
      // stays small and no vector is ever held in memory longer than one iteration.
      const terminal = terminals.get(a.skillId);
      let vector: { embedding: unknown; embedding_model: string | null; embedded_at: Date | null } | undefined;
      if (terminal !== undefined) {
        const [row] = (await db.execute(
          dsql`SELECT embedding, embedding_model, embedded_at FROM skill_alias
               WHERE id = ${deterministicAliasId(terminal, a.text, a.lang)}::uuid`,
        )) as unknown as { embedding: unknown; embedding_model: string | null; embedded_at: Date | null }[];
        vector = row;
      }
      if (a.embedded && vector?.embedding == null) {
        // The manifest says this row HAD a vector and the terminal does not have one to give
        // back. Restoring it unembedded would silently produce a row both retrieval paths
        // filter out — a rollback that looks complete and is not.
        console.error(
          `  CANNOT RESTORE ${a.id} (${JSON.stringify(a.text)}) — it was embedded at capture and ` +
            `no vector survives on its terminal. Re-embed after the rollback; do not treat this as done.`,
        );
        process.exitCode = 1;
        continue;
      }
      await db
        .insert(skillAliases)
        .values({
          id: a.id,
          skillId: a.skillId,
          text: a.text,
          lang: (a.lang ?? null) as never,
          source: "rvm",
          domainId: a.domainId,
          embedding: (vector?.embedding ?? null) as never,
          embeddingModel: vector?.embedding_model ?? null,
          embeddedAt: vector?.embedded_at ?? null,
          // Arrives unelected, exactly as `retag-skills` does it: a move changes the election
          // group, and claiming an occupied one violates skill_alias_skill_norm_lang_uq.
          isSearchable: false,
        })
        .onConflictDoNothing({ target: skillAliases.id });
      rehomed += 1;
      if (vector?.embedding != null) rehomedWithVector += 1;
    }

    let deleted = 0;
    if (plan.aliasesToDelete.length > 0) {
      // `inArray` on the EXPLAINABLE ids only — never a blanket "delete what is not in the
      // manifest". That distinction is the delete-protection property.
      await db.delete(skillAliases).where(inArray(skillAliases.id, plan.aliasesToDelete as string[]));
      deleted = plan.aliasesToDelete.length;
    }

    // ── PHASE 2: statuses, both columns in one write ─────────────────────────────────────
    let restored = 0;
    for (const s of plan.skillsToRestore) {
      await db
        .update(skills)
        .set({ status: s.status as never, replacedBy: s.replacedBy, updatedAt: new Date() })
        .where(eq(skills.skillId, s.skillId));
      restored += 1;
    }

    // ── POST-ASSERTION ───────────────────────────────────────────────────────────────────
    const after = await readState(db);
    const stillWrong = planRollback(
      manifest,
      { skills: after.skills, aliasIds: new Set(after.aliases.map((a) => a.id)) },
      terminalMap(after.skills),
    );
    console.log(`\n[${SCRIPT}] restored ${restored} skill(s), re-homed ${rehomed} alias(es) (${rehomedWithVector} with their vector), deleted ${deleted} retag-created alias(es).`);
    if (stillWrong.skillsToRestore.length === 0 && stillWrong.aliasesToRestore.length === 0) {
      console.log(`  POST-ASSERTION PASS — the database matches the manifest.`);
    } else {
      console.error(
        `  POST-ASSERTION FAIL — ${stillWrong.skillsToRestore.length} skill(s) and ` +
          `${stillWrong.aliasesToRestore.length} alias(es) still differ. The rollback did NOT complete.`,
      );
      process.exitCode = 1;
    }
  } finally {
    await sql.end();
  }
}

if (require.main === module) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
