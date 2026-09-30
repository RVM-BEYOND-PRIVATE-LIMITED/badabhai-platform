import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import type { Job, Queue } from "bullmq";
import type { ServerConfig } from "@badabhai/config";
import {
  createDbClient,
  events,
  generatedResumes,
  workerConsents,
  workerProfiles,
  workers,
  type DbClient,
} from "@badabhai/db";

import { fakeAiTraceRecorder } from "../ai/ai-trace-recorder.fake";
import type { AiCostRecorder } from "../ai/ai-cost-recorder.service";
import type { AiService } from "../ai/ai.service";
import type { PiiCryptoService } from "../common/pii-crypto.service";
import { ConsentRepository } from "../consent/consent.repository";
import { EventsRepository } from "../events/events.repository";
import { EventsService } from "../events/events.service";
import { ProfilesRepository } from "../profiles/profiles.repository";
import type { ResumeGenerateJobData, ResumeRenderJobData } from "../queue/queue.constants";
import type { StorageService } from "../storage/storage.service";
import { WorkersRepository } from "../workers/workers.repository";
import { ResumeGenerateProcessor } from "./resume-generate.processor";
import type { ResumeRateLimit } from "./resume-rate-limit.service";
import { ResumeRepository } from "./resume.repository";
import { ResumeService } from "./resume.service";

/**
 * A CONFIRMED COMPANION EDIT MAKES A REAL NEW RÉSUMÉ (ADR-0046 O6) — against a real Postgres,
 * through the SHIPPED ResumeService, ResumeRepository and ResumeGenerateProcessor.
 *
 * WHY A DATABASE. The defect this pins lived entirely in SQL semantics a stubbed repository
 * hides: the edit was sent down the profile's insert-if-absent INITIAL-row path, whose
 * `ON CONFLICT (profile_id) WHERE version = 1 DO NOTHING` handed back the résumé the worker
 * already had. Every unit suite mocked `createInitial`, so each asserted the label it was CALLED
 * with and never the row it RETURNED. Here the profile starts exactly as a companion worker's
 * does — confirmed, with its rendered v1 from the profile.confirmed auto-generate — and the
 * claims are read back off `generated_resumes`:
 *
 *   1. the Haan charges the cap on the request and queues a job; the job writes a NEW row labelled
 *      `chat_edit`, carrying the edited profile, and leaves v1 exactly as it was;
 *   2. a second edit is a second new row, and the history's newest-first window shows all three;
 *   3. a queue retry of a job that already wrote its row converges onto it — no duplicate entry;
 *   4. the `resume.regenerated` event is VALID and stored, labelled `chat_edit`.
 *
 * Only the model, the cap counter, the queues and the name crypto are faked — none of them is a
 * property under test, and none may be real here (a paid call, Redis, a key).
 *
 * Run it (against a MIGRATED database — 0130 must be applied):
 *   RUN_DB_TESTS=1 DATABASE_URL=postgres://… pnpm --filter @badabhai/api run test resume-chat-edit.db
 */

const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

const WORKER = uuid(0x4601);
const PROFILE = uuid(0x4611);
const INITIAL = uuid(0x4621);
// `events.correlation_id` is a uuid; this one keys the suite's own events for cleanup.
const CORRELATION = uuid(0x4631);
const CTX = { correlationId: CORRELATION, requestId: uuid(0x4632) };

// IN THE PAST, so every row this suite generates (stamped with the database's now()) is newer.
const CONFIRMED_AT = new Date(Date.UTC(2026, 0, 15, 10, 0, 0));

describe.skipIf(!RUN)(
  "a companion edit's regeneration against a real Postgres (ADR-0046 O6)",
  () => {
    let client: DbClient;
    let resumes: ResumeRepository;
    let profiles: ProfilesRepository;
    let service: ResumeService;
    let processor: ResumeGenerateProcessor;
    const queued: ResumeGenerateJobData[] = [];
    const rendered: ResumeRenderJobData[] = [];
    const cap = {
      assertWithinDailyCap: vi.fn(async () => undefined),
      releaseDailyCapSlot: vi.fn(async () => undefined),
    };
    // The model ECHOES the skills it was sent, so a row's text proves which profile it was made from.
    const ai = {
      generateResume: vi.fn(async (input: { profile: { skill_labels: string[] } }) => ({
        resume_text: `SKILLS: ${input.profile.skill_labels.join(", ")}`,
        resume_json: { skills: input.profile.skill_labels },
        format: "text",
        is_mock: true,
        ai_metadata: null,
      })),
    };

    const rowsForProfile = () =>
      client.db
        .select()
        .from(generatedResumes)
        .where(eq(generatedResumes.profileId, PROFILE))
        .orderBy(asc(generatedResumes.version));

    /** The Haan, then the job it queued, run through the shipped processor. */
    async function haan(attemptsMade = 0): Promise<void> {
      queued.length = 0;
      expect(await service.queueChatEditRegeneration(WORKER, PROFILE, CTX)).toBe("queued");
      expect(queued).toHaveLength(1);
      const job = { data: queued[0]!, attemptsMade } as unknown as Job<ResumeGenerateJobData>;
      expect(await processor.process(job)).toEqual({ skipped: false });
    }

    async function cleanup(): Promise<void> {
      // The worker row cascades to its profile, consent and résumé rows; events are keyed apart.
      await client.db.delete(workers).where(eq(workers.id, WORKER));
      await client.db.delete(events).where(eq(events.correlationId, CORRELATION));
    }

    beforeAll(async () => {
      client = createDbClient(DATABASE_URL, { max: 1 });
      const db = client.db;
      await cleanup();
      await db.insert(workers).values({
        id: WORKER,
        phoneE164: "v1.chat-edit-db-test",
        phoneHash: `chat-edit-db-test-${WORKER}`,
        status: "active" as const,
      });
      await db.insert(workerConsents).values({
        workerId: WORKER,
        consentVersion: "test",
        purposes: ["profiling", "resume_generation"],
        acceptedAt: CONFIRMED_AT,
      });
      await db.insert(workerProfiles).values({
        id: PROFILE,
        workerId: WORKER,
        profileStatus: "confirmed",
        source: "chat",
        rawProfile: { skill_labels: ["MIG welding"] },
      });
      // What every companion worker has: the confirmed profile's v1, rendered.
      await db.insert(generatedResumes).values({
        id: INITIAL,
        workerId: WORKER,
        profileId: PROFILE,
        resumeText: "SKILLS: MIG welding",
        version: 1,
        generatedAt: CONFIRMED_AT,
        renderStatus: "rendered",
        pdfStorageKey: "resumes/initial.pdf",
        generationTrigger: "profile_confirmed",
        generationSource: "chat",
      });

      resumes = new ResumeRepository(db);
      profiles = new ProfilesRepository(db);
      const workersRepo = new WorkersRepository(db);
      service = new ResumeService(
        resumes,
        profiles,
        workersRepo,
        { loadTradeSheet: async () => ({ packId: null, attributes: [] }) } as never,
        { listAnswers: async () => [] } as never,
        new EventsService(new EventsRepository(db), { NODE_ENV: "test" } as never),
        ai as unknown as AiService,
        { record: async () => undefined } as unknown as AiCostRecorder,
        fakeAiTraceRecorder().recorder,
        { decrypt: () => "" } as unknown as PiiCryptoService,
        cap as unknown as ResumeRateLimit,
        {} as StorageService,
        {} as ServerConfig,
        {
          add: async (_name: string, data: ResumeRenderJobData) => {
            rendered.push(data);
          },
        } as unknown as Queue<ResumeRenderJobData>,
        {
          add: async (_name: string, data: ResumeGenerateJobData) => {
            queued.push(data);
          },
        } as unknown as Queue<ResumeGenerateJobData>,
      );
      processor = new ResumeGenerateProcessor(
        service,
        workersRepo,
        profiles,
        resumes,
        new ConsentRepository(db),
        cap as unknown as ResumeRateLimit,
      );
    }, 60_000);

    afterAll(async () => {
      if (client !== undefined) {
        await cleanup();
        await client.sql.end();
      }
    });

    it("the Haan writes a NEW chat_edit entry from the EDITED profile, and leaves v1 untouched", async () => {
      // The companion's skills writer, exactly as a confirmed card runs it (outside its tx here).
      await profiles.setResumeSkillLabels(PROFILE, { skillLabels: ["MIG welding", "Welding"] });

      await haan();

      // Charged once, on the request — the job's own generate never charged again.
      expect(cap.assertWithinDailyCap).toHaveBeenCalledTimes(1);
      expect(cap.assertWithinDailyCap).toHaveBeenCalledWith(WORKER, { perWorker: true });
      expect(queued[0]).toMatchObject({
        workerId: WORKER,
        profileId: PROFILE,
        trigger: "chat_edit",
      });

      const rows = await rowsForProfile();
      expect(rows).toHaveLength(2);
      const [initial, edit] = rows;
      expect(initial).toMatchObject({
        id: INITIAL,
        version: 1,
        resumeText: "SKILLS: MIG welding",
        renderStatus: "rendered",
        pdfStorageKey: "resumes/initial.pdf",
        generationTrigger: "profile_confirmed",
      });
      expect(edit).toMatchObject({
        version: 2,
        generationTrigger: "chat_edit",
        generationSource: "chat",
        renderStatus: "pending",
        resumeText: "SKILLS: MIG welding, Welding",
      });
      expect((edit!.sourceProfileSnapshot as { skill_labels: string[] }).skill_labels).toEqual([
        "MIG welding",
        "Welding",
      ]);
      // It is the row the render job was queued for — a plain render of a brand-new row.
      expect(rendered.at(-1)).toMatchObject({ resumeId: edit!.id, workerId: WORKER });
      expect(rendered.at(-1)).not.toHaveProperty("force");

      // The event validated against the registry and was stored, labelled off the saved row.
      const stored = await client.db
        .select()
        .from(events)
        .where(
          and(eq(events.correlationId, CORRELATION), eq(events.eventName, "resume.regenerated")),
        );
      expect(stored).toHaveLength(1);
      expect(stored[0]!.payload).toMatchObject({
        resume_id: edit!.id,
        version: 2,
        previous_version: 1,
        trigger: "chat_edit",
      });
    });

    it("a SECOND edit is another new entry; the newest-three history shows every one", async () => {
      const before = await rowsForProfile();
      await resumes.markRendered(before[1]!.id, "resumes/edit-1.pdf");
      await profiles.setResumeSkillLabels(PROFILE, {
        skillLabels: ["MIG welding", "Welding", "Grinding"],
      });

      await haan();

      const rows = await rowsForProfile();
      expect(rows.map((r) => [r.version, r.generationTrigger])).toEqual([
        [1, "profile_confirmed"],
        [2, "chat_edit"],
        [3, "chat_edit"],
      ]);
      expect(rows[2]!.resumeText).toBe("SKILLS: MIG welding, Welding, Grinding");
      // The first edit's entry is a finished history card: not rewritten by the second.
      expect(rows[1]).toMatchObject({
        resumeText: "SKILLS: MIG welding, Welding",
        renderStatus: "rendered",
      });
      expect((await resumes.listHistory(WORKER, 3)).map((r) => r.id)).toEqual([
        rows[2]!.id,
        rows[1]!.id,
        INITIAL,
      ]);
    });

    it("a queue RETRY of a job whose row is written converges onto it — never a duplicate entry", async () => {
      const before = await rowsForProfile();
      const pending = before.at(-1)!;
      expect(pending.renderStatus).toBe("pending");

      // The same job delivered again (e.g. its event write failed after the insert).
      const job = {
        data: { workerId: WORKER, profileId: PROFILE, trigger: "chat_edit", ...CTX },
        attemptsMade: 1,
      } as unknown as Job<ResumeGenerateJobData>;
      expect(await processor.process(job)).toEqual({ skipped: false });

      const after = await rowsForProfile();
      expect(after).toHaveLength(before.length);
      expect(after.at(-1)!.id).toBe(pending.id);
      expect(after.at(-1)!.generationTrigger).toBe("chat_edit");
      // Forced, so a render already in flight for the previous content cannot win.
      expect(rendered.at(-1)).toMatchObject({ resumeId: pending.id, force: true });
    });
  },
);
