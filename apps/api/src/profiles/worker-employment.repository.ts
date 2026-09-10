import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, inArray } from "drizzle-orm";
import { type Database, voiceNotes, workerEmployment, workerEmploymentRole } from "@badabhai/db";

import { DATABASE } from "../database/database.module";
import { PiiCryptoService } from "../common/pii-crypto.service";
import type { WorkerEmploymentRecord } from "../resume/resume-employment-rows";

/**
 * READS AND WRITES `worker_employment` for the résumé's Zone 4.
 *
 * The reader shipped first, deliberately, while the capture surface was an open owner ruling.
 * That ruling landed (R4 Q1: a post-interview form, four employers, one role each), so the
 * writer is here now — and the staged order paid off exactly as intended: workers flip over one
 * at a time as they fill the form, with no cutover, no backfill and no migration.
 *
 * ONE ROUND TRIP PER LEVEL, NOT ONE PER EMPLOYER. Two statements — the employments, then every
 * role for all of them via `IN (...)` — rather than an N+1 over at most five employers. Not a
 * join, because a join would multiply the encrypted employer name across its role rows and this
 * decrypts once per employment.
 *
 * DEGRADES TO ABSENCE, NEVER TO A FAILED RENDER: an employer name whose token will not decrypt
 * drops THAT employment and keeps the rest. A rotated key must cost a line, never the PDF.
 */
@Injectable()
export class WorkerEmploymentRepository {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly pii: PiiCryptoService,
  ) {}

  /**
   * REPLACE this worker's whole history, in one transaction.
   *
   * DELETE-ALL-THEN-INSERT, NOT AN UPSERT, and the schema forces it: `we_worker_sort_uq` is
   * UNIQUE on `(worker_id, sort_order)`, so re-submitting a form where the worker deleted the
   * second of three employers collides on every position after it. Positional upserts would
   * need a two-phase shuffle to stay legal; a replace is one statement and cannot leave the
   * table half-updated.
   *
   * ROLES CASCADE. `worker_employment_role.employment_id` is ON DELETE CASCADE, so the roles go
   * with their employment and there is no orphan sweep to forget.
   *
   * TAKES CIPHERTEXT, NEVER PLAINTEXT. `employerNameEnc` arrives already encrypted — the same
   * split as `updateFullName`. A repository that could encrypt is a repository that could
   * forget to.
   *
   * Returns whether it replaced an existing history, which the event needs and only the
   * transaction can know.
   */
  async replaceForWorker(
    workerId: string,
    rows: readonly {
      employerNameEnc: string;
      employerCity: string | null;
      employerState: string | null;
      startYm: string | null;
      endYm: string | null;
      durationStated: boolean;
      /**
       * One or more stints, in DISPLAY order (most recent first) — see `sortOrder` below.
       * A single-role employment is a one-element array and writes the identical row it did
       * when this took one `role`.
       */
      roles: readonly {
        roleLabel: string;
        startYm: string | null;
        endYm: string | null;
        workDone: string | null;
        workDoneVoiceNoteId: string | null;
      }[];
    }[],
  ): Promise<{ replacedExisting: boolean }> {
    return this.db.transaction(async (tx) => {
      const existing = await tx
        .select({ id: workerEmployment.id })
        .from(workerEmployment)
        .where(eq(workerEmployment.workerId, workerId));

      // ── WHAT THE DELETE WOULD OTHERWISE TAKE WITH IT ────────────────────────────────────
      //
      // This endpoint has REPLACE semantics over the whole history, and the roles cascade — so
      // every save re-created every stint with a fresh id, `work_done_polished` NULL and
      // `work_done_polish_declined` back at its default. Two things were being destroyed by a
      // worker doing nothing worse than adding a second employer:
      //
      //   1. THE POLISH. Every stint's rewrite was thrown away and had to be bought again on the
      //      next render — N model calls to restore text that had not changed, and, until that
      //      render lands, a sheet that prints Hinglish where it printed English yesterday.
      //   2. THE WORKER'S REFUSAL (#1354), which is worse, because it is not merely re-earned.
      //      A cleared decline is EXACTLY the state the polisher reads as "not done yet", so the
      //      next render silently rewrote a description the worker had explicitly chosen to keep
      //      in his own words. That is the defect `work-history-own-words.test.ts` exists to
      //      prevent, arriving through a door that test does not watch.
      //
      // KEYED ON THE TEXT, NEVER ON POSITION. `sort_order` shifts the moment an employer is
      // added, removed or reordered — and adding a most-recent employer at slot 0, which pushes
      // everything down, is the ordinary case — so a slot match would carry nothing in exactly
      // the situation this exists for, and could migrate one employer's refusal onto another's
      // sentence. The description IS the identity here: the rewrite is a presentation of that
      // text, so an unchanged description keeps its rewrite and an EDITED one arrives with a null
      // polish and is re-polished for free, which is the behaviour `WorkHistoryPolishService`
      // already documents.
      const carried = new Map<string, { polished: string | null; declined: boolean }>();
      for (const row of await tx
        .select({
          workDone: workerEmploymentRole.workDone,
          workDonePolished: workerEmploymentRole.workDonePolished,
          workDonePolishDeclined: workerEmploymentRole.workDonePolishDeclined,
        })
        .from(workerEmploymentRole)
        .innerJoin(workerEmployment, eq(workerEmploymentRole.employmentId, workerEmployment.id))
        .where(eq(workerEmployment.workerId, workerId))) {
        const key = row.workDone?.trim();
        if (!key) continue;
        if (row.workDonePolished === null && !row.workDonePolishDeclined) continue;
        // FIRST WRITER WINS on a duplicate description, and the tie cannot matter: the two rows
        // carry the same text, so they would have earned the same rewrite.
        if (!carried.has(key)) {
          carried.set(key, {
            polished: row.workDonePolished,
            declined: row.workDonePolishDeclined,
          });
        }
      }

      await tx.delete(workerEmployment).where(eq(workerEmployment.workerId, workerId));
      if (rows.length === 0) return { replacedExisting: existing.length > 0 };

      const inserted = await tx
        .insert(workerEmployment)
        .values(
          rows.map((r, index) => ({
            workerId,
            employerNameEnc: r.employerNameEnc,
            employerCity: r.employerCity,
            employerState: r.employerState,
            startYm: r.startYm,
            endYm: r.endYm,
            durationStated: r.durationStated,
            // The FORM's order is the display order, most recent first. Never derived from the
            // dates: two jobs can start in the same month, and a worker whose dates are unstated
            // still described them in an order.
            sortOrder: index,
          })),
        )
        .returning({ id: workerEmployment.id });

      await tx.insert(workerEmploymentRole).values(
        inserted.flatMap((employment, index) =>
          rows[index]!.roles.map((role, roleIndex) => {
            // See the read above the delete. An unchanged description keeps the rewrite it
            // already earned AND the worker's decision about it; a changed one matches nothing
            // and is re-polished on the next render, which is the documented behaviour.
            const kept = carried.get(role.workDone?.trim() ?? "");
            return {
              employmentId: employment.id,
              roleLabel: role.roleLabel,
              startYm: role.startYm,
              endYm: role.endYm,
              workDone: role.workDone,
              workDoneVoiceNoteId: role.workDoneVoiceNoteId,
              workDonePolished: kept?.polished ?? null,
              workDonePolishDeclined: kept?.declined ?? false,
              // THE SUBMITTED ORDER, never derived from the dates — the same rule the employment
              // `sortOrder` follows one statement up, and for the same reason: a promotion in the
              // same month as its predecessor has no date to sort by, and re-deriving would
              // reshuffle stints between renders and make every regenerated PDF a false diff.
              sortOrder: roleIndex,
            };
          }),
        ),
      );

      return { replacedExisting: existing.length > 0 };
    });
  }

  /**
   * Of `ids`, which voice notes actually belong to THIS worker.
   *
   * THE FOREIGN KEY IS NOT THE CHECK. `work_done_voice_note_id` references `voice_notes(id)`, so
   * the database proves the clip EXISTS and nothing more — a worker who guessed or replayed
   * another worker's note id would write a row whose provenance points at audio that is not
   * theirs. The FK cannot express ownership because `voice_notes.worker_id` is on the other row.
   *
   * A SCOPED READ, NOT A JOIN ON THE WRITE. Returning the owned subset lets the SERVICE decide
   * what an unowned id means (it fails the request closed) rather than this method silently
   * dropping one, which would store a description whose recording quietly vanished.
   *
   * `voice_notes` is read here rather than through `VoiceService` on purpose: `ProfilesModule`
   * importing `VoiceModule` would close a cycle (`VoiceModule` -> `ChatModule` -> `ProfilesModule`),
   * and this is one scoped SELECT of two columns, not a reach into the voice layer's writes.
   */
  async findOwnedVoiceNoteIds(workerId: string, ids: readonly string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await this.db
      .select({ id: voiceNotes.id })
      .from(voiceNotes)
      .where(and(eq(voiceNotes.workerId, workerId), inArray(voiceNotes.id, [...new Set(ids)])));
    return new Set(rows.map((r) => r.id));
  }

  /**
   * Store the model's rephrasing of one or more stints (#1350).
   *
   * WRITES ONLY `work_done_polished`. The worker's own `work_done` is never touched — it is the
   * system of record, the fallback whenever this column is null, and what makes the section-8
   * override reversible by changing which column the renderer reads.
   *
   * ONE STATEMENT PER STINT rather than a CASE expression: the set is at most a handful of rows
   * (four employers, a stint or two each), and a readable loop beats a clever update nobody can
   * check. Runs in a transaction so a partial write cannot leave half a history polished.
   */
  async savePolishedDescriptions(byRoleId: ReadonlyMap<string, string>): Promise<void> {
    if (byRoleId.size === 0) return;
    await this.db.transaction(async (tx) => {
      for (const [id, polished] of byRoleId) {
        await tx
          .update(workerEmploymentRole)
          .set({ workDonePolished: polished })
          .where(eq(workerEmploymentRole.id, id));
      }
    });
  }

  /**
   * Record the worker's choice of description source for ONE employment (#1354).
   *
   * OWNERSHIP IS PROVED IN THE STATEMENT, not checked before it. The employment id comes from
   * the client, so the UPDATE joins back to `worker_employment` and filters on `worker_id`:
   * a worker passing somebody else's employment id updates zero rows and is told nothing about
   * whether it exists. A read-then-write would be the same query twice with a race between
   * them, and a `WHERE id = ?` alone is the IDOR this codebase's authz review exists to catch.
   *
   * PER EMPLOYMENT, THOUGH THE COLUMN IS PER ROLE. The sheet prints ONE work line per employer
   * — `workLine` joins the distinct descriptions across that employer's stints — so one line is
   * what a worker sees and one decision is what they can meaningfully make. Setting the flag on
   * every stint of the employment keeps the data model honest (the text lives on the stint)
   * without inventing a choice the UI cannot present.
   *
   * Returns how many stints were updated: zero means not this worker's employment, and the
   * caller turns that into a 404 rather than a 403 — no existence oracle.
   */
  async setPolishDeclined(
    workerId: string,
    employmentId: string,
    declined: boolean,
  ): Promise<number> {
    const updated = await this.db
      .update(workerEmploymentRole)
      .set({ workDonePolishDeclined: declined })
      .where(
        and(
          eq(workerEmploymentRole.employmentId, employmentId),
          // The join that proves ownership. `inArray` over a subquery rather than a SQL join,
          // because Drizzle's update builder takes a WHERE and not a FROM.
          inArray(
            workerEmploymentRole.employmentId,
            this.db
              .select({ id: workerEmployment.id })
              .from(workerEmployment)
              .where(eq(workerEmployment.workerId, workerId)),
          ),
        ),
      )
      .returning({ id: workerEmploymentRole.id });
    return updated.length;
  }

  /**
   * One worker's history in DISPLAY ORDER (most recent first).
   *
   * ORDERED BY `sort_order`, NEVER BY DATE, and that is the schema's decision restated here so a
   * future reader does not "fix" it: two jobs can start in the same month, and a worker whose
   * dates are unstated still described them in an order. Sorting by date would reshuffle rows
   * between renders and make every regenerated PDF a false diff.
   */
  async loadForResume(workerId: string): Promise<WorkerEmploymentRecord[]> {
    const employments = await this.db
      .select({
        id: workerEmployment.id,
        employerNameEnc: workerEmployment.employerNameEnc,
        employerCity: workerEmployment.employerCity,
        employerState: workerEmployment.employerState,
        startYm: workerEmployment.startYm,
        endYm: workerEmployment.endYm,
        durationStated: workerEmployment.durationStated,
      })
      .from(workerEmployment)
      .where(eq(workerEmployment.workerId, workerId))
      .orderBy(asc(workerEmployment.sortOrder));

    if (employments.length === 0) return [];

    const roles = await this.db
      .select({
        employmentId: workerEmploymentRole.employmentId,
        roleLabel: workerEmploymentRole.roleLabel,
        startYm: workerEmploymentRole.startYm,
        endYm: workerEmploymentRole.endYm,
        workDone: workerEmploymentRole.workDone,
        workDonePolished: workerEmploymentRole.workDonePolished,
        workDonePolishDeclined: workerEmploymentRole.workDonePolishDeclined,
        id: workerEmploymentRole.id,
      })
      .from(workerEmploymentRole)
      .where(
        inArray(
          workerEmploymentRole.employmentId,
          employments.map((e) => e.id),
        ),
      )
      .orderBy(asc(workerEmploymentRole.sortOrder));

    const byEmployment = new Map<string, WorkerEmploymentRecord["roles"][number][]>();
    for (const role of roles) {
      const bucket = byEmployment.get(role.employmentId) ?? [];
      bucket.push({
        id: role.id,
        roleLabel: role.roleLabel,
        startYm: role.startYm,
        endYm: role.endYm,
        workDone: role.workDone,
        workDonePolished: role.workDonePolished,
        workDonePolishDeclined: role.workDonePolishDeclined,
      });
      byEmployment.set(role.employmentId, bucket);
    }

    const out: WorkerEmploymentRecord[] = [];
    for (const e of employments) {
      let employer: string;
      try {
        employer = this.pii.decrypt(e.employerNameEnc);
      } catch {
        // NEVER LOG THE TOKEN OR THE ERROR DETAIL — the same contract the name and the phone
        // already have. The employment is dropped rather than printed with a placeholder: an
        // employer field is never blank and is never invented (§11 #4), so a name we cannot
        // read is a row we cannot honestly render.
        continue;
      }
      if (!employer.trim()) continue;
      out.push({
        // #1353/#1354 — already selected above (`id: workerEmployment.id`); just
        // wasn't threaded into the render-input record until now.
        id: e.id,
        employer,
        employerCity: e.employerCity,
        employerState: e.employerState,
        startYm: e.startYm,
        endYm: e.endYm,
        durationStated: e.durationStated,
        roles: byEmployment.get(e.id) ?? [],
      });
    }
    return out;
  }
}
