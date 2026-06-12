import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDbClient,
  events,
  workers,
  workerConsents,
  workerProfiles,
  chatSessions,
  chatMessages,
  aiJobs,
  generatedResumes,
  type DbClient,
  type EventRow,
} from "@badabhai/db";

/**
 * Phase 1 worker onboarding — ONE comprehensive happy-path test.
 *
 * Executes the complete flow in a single ordered test and fails if ANY stage
 * breaks:
 *
 *   Mock OTP Login → DPDP Consent → Chat Profiling → Profile Extraction
 *     → Profile Confirmation → Resume Generation
 *
 * Unlike `phase1-flow.e2e.test.ts` (which splits the flow across several `it`s
 * and focuses on events + interview state), this test asserts ALL of:
 *   - HTTP status codes (the controller @HttpCode contract per stage),
 *   - state transitions (worker absent→active, ai_job queued→completed,
 *     profile extracted→confirmed),
 *   - database writes (workers / worker_consents / chat_sessions / chat_messages
 *     / ai_jobs / worker_profiles / generated_resumes rows + their fields),
 *   - emitted events (exact names AND per-stage counts, all version 1),
 *   - generated outputs (a non-empty resume persisted at version 1),
 *   - the privacy invariant (no raw phone, and no raw message text, in events
 *     or conversation_state).
 *
 * Opt-in (requires a running API + Postgres + Redis):
 *   1. docker compose up -d postgres redis
 *   2. pnpm db:migrate
 *   3. pnpm --filter @badabhai/api start        # (or `dev`) in another terminal
 *   4. RUN_E2E=1 pnpm --filter @badabhai/e2e test
 *      (PowerShell:  $env:RUN_E2E=1; pnpm --filter @badabhai/e2e test)
 *
 * The FastAPI AI service is NOT required: the API falls back to safe mocks, so
 * the flow (status transitions, events, persisted outputs) completes either way.
 * This test therefore asserts structure/transitions, never AI-generated content.
 */

const RUN = process.env.RUN_E2E === "1";
const API_URL = process.env.E2E_API_URL ?? "http://localhost:3001";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";
// The ops/backend-only resume routes (e.g. GET /resume/:id) are guarded by
// InternalServiceGuard. Send the same secret the API was started with. If unset
// here AND on the API, those routes deny (fail closed) and the round-trip 401s.
const SERVICE_TOKEN = process.env.INTERNAL_SERVICE_TOKEN ?? "";

// Unique phone per run so we always exercise the new-worker path in isolation.
const PHONE = `+9194${String(Date.now()).slice(-8)}`;
const NATIONAL = PHONE.slice(1); // digits only, no leading "+"
const CONSENT_VERSION = "2026-06-01";
const PURPOSES = ["profiling", "resume_generation"] as const;

interface Resp {
  status: number;
  body: any;
}

/** Call the API; throw loudly (with body) on any non-2xx so a broken stage fails. */
async function call(method: string, path: string, body?: unknown): Promise<Resp> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  // Harmless on open routes; required by the guarded resume routes.
  if (SERVICE_TOKEN) headers["x-internal-service-token"] = SERVICE_TOKEN;
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
  return { status: res.status, body: parsed };
}

/**
 * Poll until the AUTO-triggered extraction job for this worker completes.
 * Extraction is fired by the chat service on the readiness flip — there is no
 * manual POST /profile/extract — so we discover the job from the DB by worker.
 */
async function pollAutoExtraction(
  client: DbClient,
  workerId: string,
  attempts = 60,
  delayMs = 250,
): Promise<{ aiJobId: string; profileId: string }> {
  for (let i = 0; i < attempts; i++) {
    const jobs = (await client.db.select().from(aiJobs)).filter(
      (j) =>
        j.jobType === "profile_extraction" &&
        (j.inputRef as { worker_id?: string } | null)?.worker_id === workerId,
    );
    const done = jobs.find((j) => j.status === "completed");
    const profileId = (done?.outputRef as { profile_id?: string } | null)?.profile_id;
    if (done && profileId) return { aiJobId: done.id, profileId };
    const failed = jobs.find((j) => j.status === "failed");
    if (failed) throw new Error(`auto extraction failed: ${failed.errorMessage}`);
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(`auto extraction did not complete for worker ${workerId} in time`);
}

describe.skipIf(!RUN)("Phase 1 worker onboarding — complete happy path (e2e)", () => {
  let client!: DbClient;

  beforeAll(() => {
    client = createDbClient(DATABASE_URL);
  });

  afterAll(async () => {
    await client?.sql.end({ timeout: 5 });
  });

  it("logs in → consents → chats → extracts → confirms → generates a resume, asserting every stage", async () => {
    // ───────────────────────── STAGE 1 — Mock OTP login ─────────────────────────
    const reqOtp = await call("POST", "/auth/otp/request", { phone: PHONE });
    expect(reqOtp.status).toBe(200);
    expect(reqOtp.body).toMatchObject({ success: true, channel: "sms" });

    const verify = await call("POST", "/auth/otp/verify", { phone: PHONE, otp: "123456" });
    expect(verify.status).toBe(200);
    expect(verify.body.worker_id).toBeTruthy();
    expect(verify.body.is_new_worker).toBe(true); // state transition: worker absent → created
    expect(verify.body.status).toBe("active");
    const workerId = verify.body.worker_id as string;

    // DB: the worker row exists; PII (the phone) lives ONLY in this table, and
    // even here it is hardened at rest — phone_e164 is AES-256-GCM ciphertext (an
    // `encryptPii` token, NOT the raw number) and phone_hash is a keyed HMAC.
    const workerRow = (await client.db.select().from(workers)).find((w) => w.id === workerId);
    expect(workerRow).toBeTruthy();
    expect(workerRow!.status).toBe("active");
    expect(workerRow!.phoneE164).not.toBe(PHONE); // encrypted, not plaintext
    expect(workerRow!.phoneE164).not.toContain(NATIONAL);
    expect(workerRow!.phoneE164.startsWith("v1.")).toBe(true); // encryptPii token
    expect(workerRow!.phoneHash).toBeTruthy();
    expect(workerRow!.phoneHash).not.toBe(PHONE);
    expect(workerRow!.phoneHash).not.toContain(NATIONAL); // HMAC, not reversible

    // ───────────────────────── STAGE 2 — DPDP consent ─────────────────────────
    const consent = await call("POST", "/consent/accept", {
      worker_id: workerId,
      consent_version: CONSENT_VERSION,
      purposes: PURPOSES,
    });
    expect(consent.status).toBe(201);
    expect(consent.body.consent_id).toBeTruthy();
    expect(consent.body.accepted_at).toBeTruthy();
    const consentId = consent.body.consent_id as string;

    const consentRows = (await client.db.select().from(workerConsents)).filter(
      (c) => c.workerId === workerId,
    );
    expect(consentRows).toHaveLength(1);
    expect(consentRows[0]!.id).toBe(consentId);
    expect(consentRows[0]!.consentVersion).toBe(CONSENT_VERSION);
    expect(consentRows[0]!.purposes).toEqual([...PURPOSES]);
    expect(consentRows[0]!.acceptedAt).toBeTruthy();

    // ───────────────────────── STAGE 3 — Chat profiling ─────────────────────────
    const session = await call("POST", "/chat/session", { worker_id: workerId });
    expect(session.status).toBe(201);
    expect(session.body.session_id).toBeTruthy();
    expect(session.body.status).toBe("active");
    const sessionId = session.body.session_id as string;

    // Drive the interview until the engine reports it has enough to extract.
    // Messages cover role/machines/controllers/experience/skills/location so the
    // real Python engine progresses too; the mock advances regardless. Bounded so
    // a stuck engine fails loudly rather than hanging.
    const scriptedMessages = [
      "Namaste bhai",
      "Main VMC aur CNC lathe operator hoon",
      "Fanuc aur Siemens dono controller chalaye hain",
      "Lagbhag 5 saal ka experience hai is line me",
      "Setting aur operation dono karta hoon, program edit bhi aata hai",
      "Abhi Pune me hoon, Pune ya Mumbai me kaam ke liye ready hoon",
    ];
    const sentTexts: string[] = [];
    const askedIds: (string | null)[] = [];
    let ready = false;
    for (let i = 0; i < 12 && !ready; i++) {
      const text = scriptedMessages[i] ?? "haan bhai, theek hai";
      const msg = await call("POST", "/chat/message", {
        session_id: sessionId,
        worker_id: workerId,
        text,
      });
      expect(msg.status).toBe(201);
      expect(typeof msg.body.reply).toBe("string");
      expect(msg.body.reply.length).toBeGreaterThan(0); // an assistant reply each turn
      sentTexts.push(text);
      askedIds.push(msg.body.asked_question_id ?? null);
      ready = msg.body.extraction_ready === true;
    }
    const turns = sentTexts.length;
    expect(ready).toBe(true); // interview reached extraction-ready

    // Interview advanced and never repeated Q1.
    expect(askedIds[0]).toBe("role"); // both engines open with the role question
    const nonNullAsked = askedIds.filter((a): a is string => a !== null);
    expect(new Set(nonNullAsked).size).toBe(nonNullAsked.length); // no topic re-asked

    // DB: session is active and carries the advanced interview state.
    const sessionRow = (await client.db.select().from(chatSessions)).find((s) => s.id === sessionId);
    expect(sessionRow).toBeTruthy();
    expect(sessionRow!.status).toBe("active");
    const convState = sessionRow!.conversationState as
      | { turn_count?: number; asked_question_ids?: string[] }
      | null;
    expect(convState?.turn_count).toBe(turns); // one engine turn per message
    expect(convState?.asked_question_ids?.[0]).toBe("role");

    // DB: every turn persisted one inbound + one outbound message, bodies intact.
    const msgRows = (await client.db.select().from(chatMessages))
      .filter((m) => m.sessionId === sessionId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    expect(msgRows).toHaveLength(turns * 2);
    const inbound = msgRows.filter((m) => m.direction === "inbound");
    const outbound = msgRows.filter((m) => m.direction === "outbound");
    expect(inbound).toHaveLength(turns);
    expect(outbound).toHaveLength(turns);
    expect(inbound.map((m) => m.bodyText)).toEqual(sentTexts); // worker text stored verbatim (in chat_messages only)
    expect(outbound.every((m) => (m.bodyText ?? "").length > 0)).toBe(true);

    // ──────────── STAGE 4 — Profile extraction (AUTOMATIC, no manual call) ────────────
    // Reaching extraction_ready above auto-triggered extraction from the chat
    // service — there is NO POST /profile/extract. Poll the auto-created job to done.
    const { aiJobId, profileId } = await pollAutoExtraction(client, workerId);
    expect(aiJobId).toBeTruthy();
    expect(profileId).toBeTruthy();

    // DB: ai_jobs row reflects the completed async work, refs only (no PII).
    const jobRow = (await client.db.select().from(aiJobs)).find((j) => j.id === aiJobId);
    expect(jobRow).toBeTruthy();
    expect(jobRow!.jobType).toBe("profile_extraction");
    expect(jobRow!.status).toBe("completed");
    expect((jobRow!.outputRef as { profile_id?: string } | null)?.profile_id).toBe(profileId);
    expect((jobRow!.inputRef as { worker_id?: string }).worker_id).toBe(workerId);
    expect((jobRow!.inputRef as { session_id?: string }).session_id).toBe(sessionId);

    // DB: profile created from the extraction, owned by the worker, status "extracted".
    const profileAfterExtract = (await client.db.select().from(workerProfiles)).find(
      (p) => p.id === profileId,
    );
    expect(profileAfterExtract).toBeTruthy();
    expect(profileAfterExtract!.workerId).toBe(workerId);
    expect(profileAfterExtract!.profileStatus).toBe("extracted"); // happy path: not blocked
    expect(profileAfterExtract!.confirmedAt).toBeNull();
    expect(profileAfterExtract!.rawProfile).toBeTruthy();

    // ──────────────────────── STAGE 5 — Profile confirmation ────────────────────────
    const confirm = await call("POST", "/profile/confirm", {
      worker_id: workerId,
      profile_id: profileId,
    });
    expect(confirm.status).toBe(200);
    expect(confirm.body.profile_status).toBe("confirmed");
    expect(confirm.body.confirmed_at).toBeTruthy();

    // DB: state transition extracted → confirmed, with a confirmed_at timestamp.
    const profileAfterConfirm = (await client.db.select().from(workerProfiles)).find(
      (p) => p.id === profileId,
    );
    expect(profileAfterConfirm!.profileStatus).toBe("confirmed");
    expect(profileAfterConfirm!.confirmedAt).toBeTruthy();

    // ──────────────── STAGE 5.5 — Record the worker's real name (TD21) ────────────────
    const WORKER_NAME = "Asha Kumari";
    const setName = await call("PUT", `/workers/${workerId}/name`, { full_name: WORKER_NAME });
    expect(setName.status).toBe(200);
    expect(setName.body).toEqual({ worker_id: workerId }); // response carries ONLY the id

    // DB: full_name is stored ENCRYPTED at rest (an encryptPii `v1.` token), never plaintext.
    const workerAfterName = (await client.db.select().from(workers)).find((w) => w.id === workerId);
    expect(workerAfterName!.fullName).toBeTruthy();
    expect(workerAfterName!.fullName!.startsWith("v1.")).toBe(true); // ciphertext, not the name
    expect(workerAfterName!.fullName).not.toContain(WORKER_NAME);

    // ──────────────────────── STAGE 6 — Resume generation ────────────────────────
    const resume = await call("POST", "/resume/generate", {
      worker_id: workerId,
      profile_id: profileId,
    });
    expect(resume.status).toBe(201);
    expect(resume.body.resume_id).toBeTruthy();
    expect(resume.body.version).toBe(1); // first resume for this worker
    expect(typeof resume.body.resume_text).toBe("string");
    expect(resume.body.resume_text.length).toBeGreaterThan(0); // a real output was produced
    const resumeId = resume.body.resume_id as string;

    // DB: resume persisted, linked to worker+profile, version 1, text matches output.
    const resumeRow = (await client.db.select().from(generatedResumes)).find(
      (r) => r.id === resumeId,
    );
    expect(resumeRow).toBeTruthy();
    expect(resumeRow!.workerId).toBe(workerId);
    expect(resumeRow!.profileId).toBe(profileId);
    expect(resumeRow!.version).toBe(1);
    expect(resumeRow!.resumeText).toBe(resume.body.resume_text);
    expect(resumeRow!.resumeText.length).toBeGreaterThan(0);

    // TD21: the worker's real name is on their OWN resume — decrypted server-side and
    // injected AFTER the AI call, so it was never sent to the AI service / LLM.
    expect(resume.body.resume_text).toContain(WORKER_NAME);
    expect(resumeRow!.resumeText).toContain(WORKER_NAME);

    // ──────────── Ops read view: GET /resume/:id round-trips the stored resume ────────────
    // The last read endpoint the ops console needs (resume; workers/events/ai-jobs already
    // have one). The resume legitimately carries the worker's OWN name (TD21) — it is their
    // document — but the phone never appears, and the table is RLS-locked (TD20).
    const fetched = await call("GET", `/resume/${resumeId}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body.resume_id).toBe(resumeId);
    expect(fetched.body.worker_id).toBe(workerId);
    expect(fetched.body.profile_id).toBe(profileId);
    expect(fetched.body.version).toBe(1);
    expect(fetched.body.resume_text).toBe(resume.body.resume_text); // text round-trips
    expect(fetched.body.generated_at).toBeTruthy();
    // The raw phone never appears in the ops payload (PII stays in the workers table only).
    expect(JSON.stringify(fetched.body)).not.toContain(PHONE);

    // Unknown id → 404 (raw fetch: the `call` helper throws on non-2xx).
    const missing = await fetch(`${API_URL}/resume/00000000-0000-0000-0000-000000000000`, {
      headers: SERVICE_TOKEN ? { "x-internal-service-token": SERVICE_TOKEN } : undefined,
    });
    expect(missing.status).toBe(404);

    // ──────────────────── Emitted events: names, counts, integrity ────────────────────
    // Every event this worker produced is attributable via payload.worker_id.
    const allEvents = await client.db.select().from(events);
    const mine: EventRow[] = allEvents.filter(
      (e) => (e.payload as { worker_id?: string } | null)?.worker_id === workerId,
    );
    const count = (name: string) => mine.filter((e) => e.eventName === name).length;

    // TD21 privacy guarantee: the raw name lives ONLY in workers.full_name (encrypted)
    // and on the worker's resume — it must appear in NO event and NO ai_job.
    expect(JSON.stringify(allEvents)).not.toContain(WORKER_NAME);
    expect(JSON.stringify(await client.db.select().from(aiJobs))).not.toContain(WORKER_NAME);

    expect(count("worker.created")).toBe(1);
    expect(count("worker.otp_verified")).toBe(1);
    expect(count("worker.name_recorded")).toBe(1); // emitted once on the name write
    expect(count("consent.accepted")).toBe(1);
    expect(count("chat.session_started")).toBe(1);
    expect(count("chat.message_received")).toBe(turns);
    expect(count("chat.message_sent")).toBe(turns);
    expect(count("profile.extraction_ready")).toBe(1); // emitted once on the flip
    expect(count("profile.extraction_requested")).toBe(1);
    expect(count("profile.extraction_completed")).toBe(1);
    expect(count("profile.confirmed")).toBe(1);
    expect(count("resume.generated")).toBe(1);

    // Spine integrity: every event is v1 with a correlation id and an occurred_at.
    for (const e of mine) {
      expect(e.eventVersion).toBe(1);
      expect(e.correlationId).toBeTruthy();
      expect(e.occurredAt).toBeTruthy();
    }

    // Key payloads point back at the right entities.
    const completed = mine.find((e) => e.eventName === "profile.extraction_completed")!;
    expect((completed.payload as { profile_id?: string }).profile_id).toBe(profileId);
    expect((completed.payload as { ai_job_id?: string }).ai_job_id).toBe(aiJobId);
    const resumeEvent = mine.find((e) => e.eventName === "resume.generated")!;
    expect((resumeEvent.payload as { resume_id?: string }).resume_id).toBe(resumeId);
    expect((resumeEvent.payload as { version?: number }).version).toBe(1);

    // ──────────────────────────── Privacy invariant ────────────────────────────
    // No raw phone (E.164 or national) anywhere in this worker's events...
    const eventsJson = JSON.stringify(mine);
    expect(eventsJson).not.toContain(PHONE);
    expect(eventsJson).not.toContain(NATIONAL);
    // ...and the persisted interview state holds topic ids/counts only — never the
    // raw worker message text, and never the phone.
    const stateJson = JSON.stringify(sessionRow!.conversationState ?? {});
    expect(stateJson).not.toContain(PHONE);
    expect(stateJson).not.toContain(NATIONAL);
    for (const text of sentTexts) {
      expect(stateJson).not.toContain(text);
    }
    // ...and the async job refs carry ids only, no phone.
    const jobJson = JSON.stringify({ in: jobRow!.inputRef, out: jobRow!.outputRef });
    expect(jobJson).not.toContain(PHONE);
    expect(jobJson).not.toContain(NATIONAL);
  });

  it("RLS: workers is locked to the backend role — anon/authenticated/service_role denied", async () => {
    // The backend connection (postgres / BYPASSRLS) reads fine...
    const ok = await client.sql`select count(*)::int as n from workers`;
    expect(ok[0]!.n).toBeGreaterThanOrEqual(0);

    // ...but every Supabase client-facing role (incl. the Data-API service_role)
    // is denied. Each runs in its own transaction so the role resets on rollback.
    for (const role of ["anon", "authenticated", "service_role"]) {
      let denied = false;
      try {
        await client.sql.begin(async (tx) => {
          await tx`set local role ${client.sql(role)}`;
          await tx`select 1 from workers limit 1`;
        });
      } catch (err) {
        const e = err as { code?: string; message?: string };
        denied = e.code === "42501" || /permission denied/i.test(e.message ?? "");
      }
      expect(denied, `role ${role} must be denied on workers`).toBe(true);
    }
  });
});
