import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  aiJobs,
  chatSessions,
  createDbClient,
  generatedResumes,
  workerProfiles,
  workers,
  type DbClient,
} from "@badabhai/db";

import { WorkersRepository } from "../workers/workers.repository";
import { ResumeRepository } from "./resume.repository";

/**
 * Résumé history (ADR-0043), against a REAL Postgres — because every claim here is a property of
 * the query the database actually runs, and a stubbed drizzle handle can only prove the right SQL
 * was ASKED for.
 *
 *   1. "The current résumé" is the NEWEST generation, not the highest version. The version sort it
 *      replaces let an older profile's v2 hide a newer profile's v1.
 *   2. The history window is newest-first and bounded, and nothing outside it is deleted.
 *   3. `maxVersion` numbers across ALL of the worker's profiles.
 *   4. The converge write is GUARDED in SQL: a row that already rendered is never rewritten.
 *   5. `pendingChatUpdate` reads the loose `resume_update` key, the session's extraction job by the
 *      jsonb keys, and the landing by `generated_at` — four tables, one worker.
 *   6. The two vocabularies are enforced by the database, not just by the type system.
 *
 * Run it:
 *   RUN_DB_TESTS=1 DATABASE_URL=postgres://… pnpm --filter @badabhai/api run test resume-history.db
 */

const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

const WORKER = uuid(0x4301);
const OLD_PROFILE = uuid(0x4311);
const NEW_PROFILE = uuid(0x4312);
const SESSION = uuid(0x4321);
const JOB = uuid(0x4331);
const R_OLD_V1 = uuid(0x4341);
const R_OLD_V2 = uuid(0x4342);
const R_NEW_V1 = uuid(0x4343);

// IN THE PAST, deliberately: the landing rule compares against rows the converge write stamps
// with the database's NOW, so a fixture dated later than the run would read every row as newer.
const T = (minutes: number) => new Date(Date.UTC(2026, 0, 15, 10, minutes, 0));
const ACCEPTED_AT = T(30);

describe.skipIf(!RUN)("résumé history against a real Postgres (ADR-0043)", () => {
  let client: DbClient;
  let resumes: ResumeRepository;
  let workersRepo: WorkersRepository;

  beforeAll(async () => {
    client = createDbClient(DATABASE_URL, { max: 1 });
    const db = client.db;
    await db.delete(workers).where(eq(workers.id, WORKER));
    await db.insert(workers).values({
      id: WORKER,
      phoneE164: "v1.resume-history-db-test",
      phoneHash: `resume-history-db-test-${WORKER}`,
      status: "active" as const,
    });
    await db.insert(workerProfiles).values([
      { id: OLD_PROFILE, workerId: WORKER, profileStatus: "confirmed", source: "chat" },
      { id: NEW_PROFILE, workerId: WORKER, profileStatus: "extracted", source: "form" },
    ]);
    const row = (id: string, profileId: string, version: number, at: Date, status: string) => ({
      id,
      workerId: WORKER,
      profileId,
      resumeText: "x",
      version,
      generatedAt: at,
      renderStatus: status,
    });
    await db.insert(generatedResumes).values([
      row(R_OLD_V1, OLD_PROFILE, 1, T(0), "rendered"),
      row(R_OLD_V2, OLD_PROFILE, 2, T(10), "rendered"),
      // NEWER, and v1 of its own profile — the row the version sort used to hide.
      row(R_NEW_V1, NEW_PROFILE, 1, T(20), "pending"),
    ]);
    await db.insert(chatSessions).values({
      id: SESSION,
      workerId: WORKER,
      status: "ended",
      endedAt: T(29),
      conversationState: {
        form_kind: null,
        resume_update: { accepted: true, answered_at: ACCEPTED_AT.toISOString() },
      },
    });
    await db.insert(aiJobs).values({
      id: JOB,
      jobType: "profile_extraction",
      status: "completed",
      inputRef: { worker_id: WORKER, session_id: SESSION },
      outputRef: { profile_id: NEW_PROFILE },
    });
    resumes = new ResumeRepository(db);
    workersRepo = new WorkersRepository(db);
  }, 60_000);

  afterAll(async () => {
    if (client !== undefined) {
      await client.db.delete(aiJobs).where(eq(aiJobs.id, JOB));
      await client.db.delete(workers).where(eq(workers.id, WORKER));
      await client.sql.end();
    }
  });

  it("the CURRENT résumé is the newest generation — a newer profile's v1 beats an older v2", async () => {
    expect((await workersRepo.latestResume(WORKER))?.id).toBe(R_NEW_V1);
  });

  it("the history window is newest-first and bounded; nothing outside it is deleted", async () => {
    expect((await resumes.listHistory(WORKER, 3)).map((r) => r.id)).toEqual([
      R_NEW_V1,
      R_OLD_V2,
      R_OLD_V1,
    ]);
    expect((await resumes.listHistory(WORKER, 2)).map((r) => r.id)).toEqual([R_NEW_V1, R_OLD_V2]);
    const all = await client.db
      .select({ id: generatedResumes.id })
      .from(generatedResumes)
      .where(eq(generatedResumes.workerId, WORKER));
    expect(all).toHaveLength(3);
  });

  it("reads the DATABASE's clock — the one every generated_at is stamped with", async () => {
    const before = Date.now();
    const dbNow = await resumes.now();
    expect(dbNow).toBeInstanceOf(Date);
    // Same machine in this test; the point is the value comes back as a usable Date.
    expect(Math.abs(dbNow.getTime() - before)).toBeLessThan(60_000);
  });

  it("numbers across ALL the worker's profiles, and finds a profile's own newest row", async () => {
    expect(await resumes.maxVersion(WORKER)).toBe(2);
    expect(await resumes.maxVersion(uuid(0x49ff))).toBe(0);
    expect((await resumes.newestForProfile(OLD_PROFILE))?.id).toBe(R_OLD_V2);
  });

  it("lists every résumé that holds a PDF or is about to — rendered AND pending — for the erasure fan-out", async () => {
    expect(await workersRepo.listErasureTargetIds(WORKER)).toEqual([R_NEW_V1, R_OLD_V2, R_OLD_V1]);
  });

  it("the converge write is GUARDED: a rendered row is never rewritten, a pending one is", async () => {
    const content = {
      resumeJson: {},
      resumeText: "rewritten",
      sourceProfileSnapshot: null,
      templateId: "classic",
      generationSource: "form" as const,
    };
    // R_OLD_V2 rendered in January — long before a call starting NOW. A finished entry.
    const now = new Date();
    expect(await resumes.convergeOnto(R_OLD_V2, content, now)).toBeUndefined();
    const untouched = await resumes.findById(R_OLD_V2);
    expect(untouched?.resumeText).toBe("x");
    expect(untouched?.renderStatus).toBe("rendered");

    const converged = await resumes.convergeOnto(R_NEW_V1, content, now);
    expect(converged?.resumeText).toBe("rewritten");
    expect(converged?.generationSource).toBe("form");
    expect(converged!.generatedAt.getTime()).toBeGreaterThan(T(20).getTime());
  });

  it("CONVERGES on a rendered row written after the caller started — the same generation racing", async () => {
    // R_OLD_V1 rendered at T(0); a call that "started" before that sees it as written DURING it.
    const content = {
      resumeJson: {},
      resumeText: "race",
      sourceProfileSnapshot: null,
      templateId: "classic",
      generationSource: "chat" as const,
    };
    const converged = await resumes.convergeOnto(R_OLD_V1, content, new Date(T(0).getTime() - 1));
    expect(converged?.resumeText).toBe("race");
    // Reset to pending with no PDF, so the render queued next draws the converged content.
    expect(converged?.renderStatus).toBe("pending");
    expect(converged?.pdfStorageKey).toBeNull();
  });

  it("pendingChatUpdate reads the acceptance, the session's extraction and its profile", async () => {
    const facts = await resumes.pendingChatUpdate(WORKER);
    expect(facts).toMatchObject({
      sessionId: SESSION,
      extractionStatus: "completed",
      profileStatus: "extracted",
    });
    expect(facts?.requestedAt.toISOString()).toBe(ACCEPTED_AT.toISOString());
    // The converge above moved R_NEW_V1's generated_at to NOW, which is after the Haan — so the
    // update reads as LANDED. That is the landing rule: any résumé generated at or after it.
    expect(facts?.landed).toBe(true);
  });

  it("an update with nothing generated since reads as NOT landed", async () => {
    await client.db
      .update(chatSessions)
      .set({
        conversationState: {
          resume_update: {
            accepted: true,
            answered_at: new Date(Date.now() + 60_000).toISOString(),
          },
        },
      })
      .where(eq(chatSessions.id, SESSION));
    expect((await resumes.pendingChatUpdate(WORKER))?.landed).toBe(false);
  });

  it("an 'Abhi nahi' is not a pending update at all", async () => {
    await client.db
      .update(chatSessions)
      .set({
        conversationState: { resume_update: { accepted: false, answered_at: T(30).toISOString() } },
      })
      .where(eq(chatSessions.id, SESSION));
    expect(await resumes.pendingChatUpdate(WORKER)).toBeNull();
  });

  it("the database refuses a source or trigger outside the closed vocabularies", async () => {
    // drizzle wraps the driver error ("Failed query: …"); the constraint name is on its cause.
    const refusal = async (write: () => Promise<unknown>): Promise<string> => {
      try {
        await write();
        return "accepted";
      } catch (err) {
        const cause = (err as { cause?: { constraint_name?: string; message?: string } }).cause;
        return cause?.constraint_name ?? cause?.message ?? String(err);
      }
    };
    expect(
      await refusal(() =>
        client.db
          .update(generatedResumes)
          .set({ generationSource: "voice" as never })
          .where(eq(generatedResumes.id, R_OLD_V1)),
      ),
    ).toBe("generated_resumes_generation_source_chk");
    expect(
      await refusal(() =>
        client.db
          .update(generatedResumes)
          .set({ generationTrigger: "cron" as never })
          .where(eq(generatedResumes.id, R_OLD_V1)),
      ),
    ).toBe("generated_resumes_generation_trigger_chk");
    // The vacuity check: an in-vocabulary write through the same helper is accepted.
    expect(
      await refusal(() =>
        client.db
          .update(generatedResumes)
          .set({ generationSource: "resume_upload", generationTrigger: "chat_update_accepted" })
          .where(eq(generatedResumes.id, R_OLD_V1)),
      ),
    ).toBe("accepted");
  });
});
