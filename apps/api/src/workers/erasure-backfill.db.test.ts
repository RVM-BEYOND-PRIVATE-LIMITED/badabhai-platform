import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import {
  createDbClient,
  events,
  generatedResumes,
  workerProfiles,
  workers,
  type DbClient,
} from "@badabhai/db";

import { WorkersRepository } from "./workers.repository";

/**
 * The erasure backfill's target rule (ADR-0043 launch gate), against a REAL Postgres. The rule
 * lives entirely in SQL (window functions over the audit spine, a join onto `generated_resumes`),
 * so a stubbed drizzle handle could only prove the SQL was sent, never that it selects the right
 * PDFs.
 *
 * A PDF is stale when it was rendered BEFORE its worker's latest erasure. Each worker below is
 * one case of what an erasure is, and of what is not one.
 *
 * Run it:
 *   RUN_DB_TESTS=1 DATABASE_URL=postgres://… pnpm --filter @badabhai/api run test erasure-backfill.db
 *
 * `count` is compared as a DELTA over this file's own fixtures; like every DB suite here, it
 * assumes no other suite writes erasure events to the same database while it runs.
 */

const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

// In the past, and in minutes, so every ordering below is readable at a glance.
const T = (minutes: number) => new Date(Date.UTC(2026, 0, 20, 10, minutes, 0));

/** One worker per case. Résumé ids are numbered so their sort order is the order listed. */
const CASES = {
  photoRemoved: uuid(0xeb01),
  whatsappCleared: uuid(0xeb02),
  whatsappSet: uuid(0xeb03),
  photoHidden: uuid(0xeb04),
  hiddenWithNoPhoto: uuid(0xeb05),
  hiddenAgain: uuid(0xeb06),
  noErasure: uuid(0xeb07),
  neverStamped: uuid(0xeb08),
} as const;
const WORKER_IDS = Object.values(CASES);

const R = {
  photoRemovedBefore: uuid(0xeb11), // rendered before the removal → STALE
  photoRemovedAfter: uuid(0xeb12), // re-rendered after it → clean
  photoRemovedPending: uuid(0xeb13), // no PDF yet → not a target
  photoRemovedFailed: uuid(0xeb14), // already out of service → not a target
  whatsappCleared: uuid(0xeb21), // STALE
  whatsappSet: uuid(0xeb31), // a number ADDED is not an erasure
  photoHidden: uuid(0xeb41), // STALE
  hiddenWithNoPhoto: uuid(0xeb51), // hiding a photo that never existed erased nothing
  hiddenAgain: uuid(0xeb61), // drawn after the real flip; a later no-flip prefs write is not one
  noErasure: uuid(0xeb71),
  neverStamped: uuid(0xeb81), // rendered, no rendered_at → STALE (cannot prove it is clean)
} as const;
const RESUME_IDS = Object.values(R);
const STALE = [R.photoRemovedBefore, R.whatsappCleared, R.photoHidden, R.neverStamped];

describe.skipIf(!RUN)("erasure backfill targets against a real Postgres (ADR-0043)", () => {
  let client: DbClient;
  let repo: WorkersRepository;
  let countBefore = 0;

  const event = (workerId: string, name: string, at: Date, payload: Record<string, unknown>) => ({
    eventName: name,
    eventVersion: 1,
    occurredAt: at,
    actorType: "worker",
    actorId: workerId,
    subjectType: "worker",
    subjectId: workerId,
    correlationId: randomUUID(),
    payload: { worker_id: workerId, ...payload },
  });

  async function cleanup(): Promise<void> {
    await client.db.delete(events).where(inArray(events.subjectId, WORKER_IDS));
    await client.db.delete(workers).where(inArray(workers.id, WORKER_IDS));
  }

  beforeAll(async () => {
    client = createDbClient(DATABASE_URL, { max: 1 });
    repo = new WorkersRepository(client.db);
    await cleanup();
    countBefore = await repo.countErasureBackfillTargets();

    await client.db.insert(workers).values(
      WORKER_IDS.map((id) => ({
        id,
        phoneE164: "v1.erasure-backfill-db-test",
        phoneHash: `erasure-backfill-db-test-${id}`,
        status: "active" as const,
      })),
    );
    await client.db.insert(workerProfiles).values(
      WORKER_IDS.map((workerId, i) => ({
        id: uuid(0xeba0 + i),
        workerId,
        profileStatus: "confirmed" as const,
        source: "chat" as const,
      })),
    );
    const profileOf = (workerId: string) => uuid(0xeba0 + WORKER_IDS.indexOf(workerId));
    // One profile per worker, so each of its résumés needs its own version (v1 is unique per
    // profile).
    const versions = new Map<string, number>();
    const resume = (id: string, workerId: string, status: string, renderedAt: Date | null) => ({
      id,
      workerId,
      profileId: profileOf(workerId),
      resumeText: "x",
      version: versions.set(workerId, (versions.get(workerId) ?? 0) + 1).get(workerId)!,
      generatedAt: T(0),
      renderStatus: status,
      renderedAt,
    });
    await client.db
      .insert(generatedResumes)
      .values([
        resume(R.photoRemovedBefore, CASES.photoRemoved, "rendered", T(10)),
        resume(R.photoRemovedAfter, CASES.photoRemoved, "rendered", T(40)),
        resume(R.photoRemovedPending, CASES.photoRemoved, "pending", null),
        resume(R.photoRemovedFailed, CASES.photoRemoved, "failed", T(5)),
        resume(R.whatsappCleared, CASES.whatsappCleared, "rendered", T(10)),
        resume(R.whatsappSet, CASES.whatsappSet, "rendered", T(10)),
        resume(R.photoHidden, CASES.photoHidden, "rendered", T(10)),
        resume(R.hiddenWithNoPhoto, CASES.hiddenWithNoPhoto, "rendered", T(10)),
        resume(R.hiddenAgain, CASES.hiddenAgain, "rendered", T(10)),
        resume(R.noErasure, CASES.noErasure, "rendered", T(10)),
        resume(R.neverStamped, CASES.neverStamped, "rendered", null),
      ]);

    const prefs = (showPhoto: boolean) => ({ show_photo: showPhoto, night_shift_ready: false });
    await client.db.insert(events).values([
      event(CASES.photoRemoved, "worker.photo_removed", T(30), {}),
      event(CASES.whatsappCleared, "worker.whatsapp_recorded", T(30), { has_whatsapp: false }),
      event(CASES.whatsappSet, "worker.whatsapp_recorded", T(30), { has_whatsapp: true }),
      // The first prefs write turning the photo OFF is a flip: the column defaults to on.
      event(CASES.photoHidden, "worker.photo_uploaded", T(5), {}),
      event(CASES.photoHidden, "worker.resume_prefs_updated", T(20), prefs(false)),
      // A flip with no photo ever uploaded: no face was ever on a PDF.
      event(CASES.hiddenWithNoPhoto, "worker.resume_prefs_updated", T(20), prefs(false)),
      // The real flip at T(5); the PDF was drawn at T(10), after it; the T(20) write (say, the
      // night-shift toggle) re-states "off" and is not an erasure.
      event(CASES.hiddenAgain, "worker.photo_uploaded", T(1), {}),
      event(CASES.hiddenAgain, "worker.resume_prefs_updated", T(5), prefs(false)),
      event(CASES.hiddenAgain, "worker.resume_prefs_updated", T(20), prefs(false)),
      event(CASES.neverStamped, "worker.photo_removed", T(30), {}),
    ]);
  }, 60_000);

  afterAll(async () => {
    if (client !== undefined) {
      await cleanup();
      await client.sql.end();
    }
  });

  const ours = (rows: { resumeId: string }[]) =>
    rows.map((row) => row.resumeId).filter((id) => (RESUME_IDS as string[]).includes(id));

  it("targets exactly the PDFs drawn before their worker's latest erasure", async () => {
    // Vacuity guard: the fixture really does hold rows the rule must refuse.
    expect(RESUME_IDS.length).toBeGreaterThan(STALE.length);
    expect(ours(await repo.listErasureBackfillTargets(1000, null))).toEqual(STALE);
  });

  it("counts the same set", async () => {
    expect((await repo.countErasureBackfillTargets()) - countBefore).toBe(STALE.length);
  });

  it("pages by résumé id: a bounded page, then everything after the cursor", async () => {
    const all = ours(await repo.listErasureBackfillTargets(1000, null));
    const afterFirst = ours(await repo.listErasureBackfillTargets(1000, all[0]!));
    expect(afterFirst).toEqual(all.slice(1));
    const page = await repo.listErasureBackfillTargets(1, null);
    expect(page).toHaveLength(1);
  });

  it("carries each résumé's worker, for the render job", async () => {
    const rows = await repo.listErasureBackfillTargets(1000, null);
    expect(rows.find((row) => row.resumeId === R.whatsappCleared)?.workerId).toBe(
      CASES.whatsappCleared,
    );
  });

  it("drains: a PDF re-rendered after the erasure leaves the set", async () => {
    await client.db
      .update(generatedResumes)
      .set({ renderedAt: T(50) })
      .where(inArray(generatedResumes.id, [R.photoRemovedBefore]));
    expect(ours(await repo.listErasureBackfillTargets(1000, null))).toEqual(
      STALE.filter((id) => id !== R.photoRemovedBefore),
    );
  });
});
