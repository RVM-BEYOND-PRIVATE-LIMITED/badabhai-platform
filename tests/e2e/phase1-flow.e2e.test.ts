import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient, events, chatSessions, type DbClient, type EventRow } from "@badabhai/db";

/**
 * Phase 1 end-to-end flow: login (mock OTP) -> consent -> chat -> profile
 * extract -> confirm -> resume generate, asserting the expected events were
 * emitted and that NO PII (raw phone) ever lands in the events table.
 *
 * Opt-in (requires a running API + Postgres):
 *   1. docker compose up -d postgres        # or point at Supabase
 *   2. pnpm db:migrate
 *   3. pnpm --filter @badabhai/api start    # (or `dev`) in another terminal
 *   4. RUN_E2E=1 pnpm --filter @badabhai/e2e test
 *      (PowerShell:  $env:RUN_E2E=1; pnpm --filter @badabhai/e2e test)
 *
 * The AI service is NOT required — the API falls back to safe mocks when it is
 * unreachable, so the flow (and its events) still complete.
 */

const RUN = process.env.RUN_E2E === "1";
const API_URL = process.env.E2E_API_URL ?? "http://localhost:3001";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

// Unique phone per run so we always exercise the new-worker path.
const PHONE = `+9198${String(Date.now()).slice(-8)}`;
const NATIONAL = PHONE.slice(1); // digits only, no leading "+"
const CONSENT_VERSION = "2026-06-01";

async function post(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`POST ${path} -> ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

async function get(path: string): Promise<any> {
  const res = await fetch(`${API_URL}${path}`);
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}: ${await res.text()}`);
  return res.json();
}

/** Poll an async extraction job (BullMQ) until it completes; return profile_id. */
async function pollExtraction(aiJobId: string, attempts = 40, delayMs = 250): Promise<string> {
  for (let i = 0; i < attempts; i++) {
    const job = await get(`/ai-jobs/${aiJobId}`);
    if (job.status === "completed") {
      const profileId = job.output_ref?.profile_id;
      if (!profileId) throw new Error("extraction completed without a profile_id");
      return profileId;
    }
    if (job.status === "failed") throw new Error(`extraction failed: ${job.error_message}`);
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(`extraction job ${aiJobId} did not complete within ${attempts * delayMs}ms`);
}

describe.skipIf(!RUN)("Phase 1 worker-profiling flow (e2e)", () => {
  let client!: DbClient;
  const ids = { workerId: "", sessionId: "", profileId: "", resumeId: "" };

  beforeAll(() => {
    client = createDbClient(DATABASE_URL);
  });

  afterAll(async () => {
    await client?.sql.end({ timeout: 5 });
  });

  /** Events attributable to this run's worker (by payload.worker_id or our ids). */
  async function myEvents(): Promise<EventRow[]> {
    const rows = await client.db.select().from(events);
    const ours = new Set([ids.workerId, ids.sessionId, ids.profileId, ids.resumeId]);
    return rows.filter((e) => {
      const wid = (e.payload as { worker_id?: string } | null)?.worker_id;
      return wid === ids.workerId || ours.has(e.actorId ?? "") || ours.has(e.subjectId ?? "");
    });
  }

  it("drives login -> consent -> chat -> extract -> confirm -> resume", async () => {
    // 1. login (mock OTP — any 4-6 digits)
    await post("/auth/otp/request", { phone: PHONE });
    const verify = await post("/auth/otp/verify", { phone: PHONE, otp: "123456" });
    expect(verify.worker_id).toBeTruthy();
    expect(verify.is_new_worker).toBe(true);
    ids.workerId = verify.worker_id;

    // 2. consent
    const consent = await post("/consent/accept", {
      worker_id: ids.workerId,
      consent_version: CONSENT_VERSION,
      purposes: ["profiling", "resume_generation"],
    });
    expect(consent.consent_id).toBeTruthy();

    // 3. chat (one turn)
    const session = await post("/chat/session", { worker_id: ids.workerId });
    expect(session.session_id).toBeTruthy();
    ids.sessionId = session.session_id;

    const message = await post("/chat/message", {
      session_id: ids.sessionId,
      worker_id: ids.workerId,
      text: "I run VMC and CNC lathe, Fanuc controller, 5 years experience.",
    });
    expect(typeof message.reply).toBe("string");
    expect(message.reply.length).toBeGreaterThan(0);

    // 4. extract profile (async: enqueues a BullMQ job; poll until done)
    const extract = await post("/profile/extract", {
      worker_id: ids.workerId,
      session_id: ids.sessionId,
    });
    expect(extract.ai_job_id).toBeTruthy();
    expect(extract.status).toBe("queued");
    ids.profileId = await pollExtraction(extract.ai_job_id);
    expect(ids.profileId).toBeTruthy();

    // 5. confirm
    const confirm = await post("/profile/confirm", {
      worker_id: ids.workerId,
      profile_id: ids.profileId,
    });
    expect(confirm.profile_status).toBe("confirmed");

    // 6. resume
    const resume = await post("/resume/generate", {
      worker_id: ids.workerId,
      profile_id: ids.profileId,
    });
    expect(resume.resume_id).toBeTruthy();
    expect(typeof resume.resume_text).toBe("string");
    ids.resumeId = resume.resume_id;
  });

  it("emitted the expected events along the flow", async () => {
    const names = new Set((await myEvents()).map((e) => e.eventName));
    for (const expected of [
      "worker.created",
      "worker.otp_verified",
      "consent.accepted",
      "chat.session_started",
      "chat.message_received",
      "chat.message_sent",
      "profile.extraction_requested",
      "profile.extraction_completed",
      "profile.confirmed",
      "resume.generated",
    ]) {
      expect(names.has(expected), `expected event "${expected}" to be emitted`).toBe(true);
    }
  });

  it("never writes raw PII (phone) into the events table", async () => {
    const serialized = JSON.stringify(await myEvents());
    expect(serialized).not.toContain(PHONE);
    expect(serialized).not.toContain(NATIONAL);
  });

  it("keeps the interview stateful across turns (advances, never repeats Q1)", async () => {
    // Fresh worker + session so we start the interview from turn 0.
    const phone = `+9197${String(Date.now()).slice(-8)}`;
    await post("/auth/otp/request", { phone });
    const verify = await post("/auth/otp/verify", { phone, otp: "123456" });
    const workerId = verify.worker_id as string;
    const session = await post("/chat/session", { worker_id: workerId });
    const sessionId = session.session_id as string;

    const messages = ["namaste bhai", "VMC operator hoon", "5 saal ka experience"];
    const asked: (string | null)[] = [];
    for (const text of messages) {
      const reply = await post("/chat/message", { session_id: sessionId, worker_id: workerId, text });
      expect(reply.reply.length).toBeGreaterThan(0); // existing behavior preserved
      asked.push(reply.asked_question_id ?? null);
    }

    // DoD: 3 turns advance through the question bank without repeating Q1.
    expect(asked).toEqual(["role", "machines", "experience"]);
    expect(new Set(asked).size).toBe(3);

    // The state was actually persisted across turns (not restarted each message).
    const rows = await client.db.select().from(chatSessions);
    const row = rows.find((r) => r.id === sessionId);
    const state = row?.conversationState as
      | { turn_count?: number; asked_question_ids?: string[] }
      | null;
    expect(state?.turn_count).toBe(3);
    expect(state?.asked_question_ids).toEqual(["role", "machines", "experience"]);

    // Privacy: the persisted interview state must carry topic ids / counts / slugs
    // ONLY — never the raw worker message text (which lives in chat_messages, not
    // here, and never in events). Guards the conversation_state JSONB column.
    const stateJson = JSON.stringify(row?.conversationState ?? {});
    for (const raw of messages) {
      expect(stateJson).not.toContain(raw);
    }

    // Events still emitted for these turns.
    const evRows = await client.db.select().from(events);
    const sentForSession = evRows.filter(
      (e) =>
        e.eventName === "chat.message_sent" &&
        (e.payload as { session_id?: string } | null)?.session_id === sessionId,
    );
    expect(sentForSession.length).toBe(3);
  });

  it("emits profile.extraction_ready exactly once, on the turn the interview flips ready", async () => {
    const phone = `+9196${String(Date.now()).slice(-8)}`;
    await post("/auth/otp/request", { phone });
    const verify = await post("/auth/otp/verify", { phone, otp: "123456" });
    const workerId = verify.worker_id as string;
    const session = await post("/chat/session", { worker_id: workerId });
    const sessionId = session.session_id as string;

    // Drive the interview until the engine reports extraction_ready (mock flips
    // once role/machines/experience/location are covered). Bounded so a stuck
    // engine fails loudly instead of looping.
    let readyTurn = -1;
    for (let i = 0; i < 10 && readyTurn < 0; i++) {
      const reply = await post("/chat/message", {
        session_id: sessionId,
        worker_id: workerId,
        text: "VMC operator, Fanuc, 5 saal, Pune me ready",
      });
      if (reply.extraction_ready === true) readyTurn = i;
    }
    expect(readyTurn).toBeGreaterThanOrEqual(0);

    const readyEvents = (rows: EventRow[]) =>
      rows.filter(
        (e) =>
          e.eventName === "profile.extraction_ready" &&
          (e.payload as { session_id?: string } | null)?.session_id === sessionId,
      );

    // Emitted on the flip — exactly once.
    let evRows = await client.db.select().from(events);
    const ready = readyEvents(evRows);
    expect(ready.length).toBe(1);
    const payload = ready[0]!.payload as {
      worker_id?: string;
      role_family?: string;
      answered_topics?: string[];
    };
    expect(payload.worker_id).toBe(workerId);
    expect(payload.role_family).toBe("cnc_vmc");
    for (const essential of ["role", "machines", "experience", "location"]) {
      expect(payload.answered_topics).toContain(essential);
    }

    // Idempotent: a further turn after ready does NOT re-emit.
    await post("/chat/message", {
      session_id: sessionId,
      worker_id: workerId,
      text: "aur kuch nahi bhai",
    });
    evRows = await client.db.select().from(events);
    expect(readyEvents(evRows).length).toBe(1);
  });
});
