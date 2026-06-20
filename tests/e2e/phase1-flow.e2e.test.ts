import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDbClient,
  events,
  chatSessions,
  workers,
  workerProfiles,
  aiJobs,
  type DbClient,
  type EventRow,
} from "@badabhai/db";

/**
 * Phase 1 end-to-end onboarding flow, proving State-9 requirements:
 *   login (mock OTP) -> consent -> multi-turn interview -> state persists ->
 *   extraction_ready -> AUTOMATIC profile extraction -> status 'extracted' ->
 *   profile.extraction_completed -> confirm -> resume.
 *
 * Plus: AI usage/cost metadata is persisted on the ai_job, and NO raw phone
 * number ever lands in the events table (only hashes/ciphertext at rest).
 *
 * Extraction is NOT requested manually here — it is auto-triggered by the chat
 * service the moment the interview flips `extraction_ready` (no /profile/extract).
 *
 * Opt-in (requires a running API + Postgres + Redis):
 *   1. docker compose up -d postgres redis     # or point at Supabase + Redis
 *   2. pnpm db:migrate
 *   3. pnpm --filter @badabhai/api start        # (or `dev`) in another terminal
 *   4. RUN_E2E=1 pnpm --filter @badabhai/e2e test
 *      (PowerShell:  $env:RUN_E2E=1; pnpm --filter @badabhai/e2e test)
 *
 * The AI service is NOT required — the API falls back to safe mocks when it is
 * unreachable (real_call=false, model="mock"), so the flow + its metadata still
 * complete. With the real LLM enabled, real_call=true and costs/tokens are real.
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

async function post(path: string, body: unknown, token?: string): Promise<any> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  // Bearer session token: required by the worker-authenticated chat/profile/voice
  // routes (P0 auth+consent gate). The worker comes from this token, not the body.
  if (token) headers["authorization"] = `Bearer ${token}`;
  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} -> ${res.status}: ${await res.text()}`);
  return res.json();
}

describe.skipIf(!RUN)("Phase 1 worker-profiling flow (e2e)", () => {
  let client!: DbClient;
  const ids = { workerId: "", sessionId: "", profileId: "", aiJobId: "", resumeId: "" };

  beforeAll(() => {
    client = createDbClient(DATABASE_URL);
  });

  afterAll(async () => {
    await client?.sql.end({ timeout: 5 });
  });

  /** Events attributable to this run (by payload.worker_id / our ids on actor|subject). */
  async function myEvents(): Promise<EventRow[]> {
    const rows = await client.db.select().from(events);
    const ours = new Set([ids.workerId, ids.sessionId, ids.profileId, ids.aiJobId, ids.resumeId]);
    return rows.filter((e) => {
      const wid = (e.payload as { worker_id?: string } | null)?.worker_id;
      return wid === ids.workerId || ours.has(e.actorId ?? "") || ours.has(e.subjectId ?? "");
    });
  }

  /** The worker's completed extraction ai_job (auto-created), or undefined. */
  async function myCompletedJob() {
    const rows = await client.db.select().from(aiJobs);
    return rows.find(
      (j) =>
        j.status === "completed" &&
        (j.inputRef as { worker_id?: string } | null)?.worker_id === ids.workerId,
    );
  }

  /**
   * Poll until AUTO extraction produced an 'extracted' profile for this worker.
   * No /profile/extract call — the chat service triggered it on the readiness flip.
   */
  async function pollExtractedProfile(attempts = 60, delayMs = 250): Promise<void> {
    for (let i = 0; i < attempts; i++) {
      const rows = await client.db.select().from(workerProfiles);
      const mine = rows
        .filter((p) => p.workerId === ids.workerId)
        .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
      const extracted = mine.find((p) => p.profileStatus === "extracted");
      if (extracted) {
        ids.profileId = extracted.id;
        const job = await myCompletedJob();
        if (job) ids.aiJobId = job.id;
        return;
      }
      await new Promise((r) => setTimeout(r, delayMs));
    }
    throw new Error(`auto extraction did not produce an 'extracted' profile in time`);
  }

  it("login -> consent -> multi-turn interview (state persists) -> AUTO extract -> confirm -> resume", async () => {
    // 1. login (real OTP — the console SMS provider echoes the code as dev_otp in
    //    dev/test only; assertAuthConfig forbids console outside dev/test).
    const reqOtp = await post("/auth/otp/request", { phone: PHONE });
    const verify = await post("/auth/otp/verify", { phone: PHONE, otp: reqOtp.dev_otp });
    expect(verify.worker_id).toBeTruthy();
    expect(verify.is_new_worker).toBe(true);
    ids.workerId = verify.worker_id;
    const token = verify.access_token as string;
    expect(token).toBeTruthy();

    // 2. consent
    const consent = await post("/consent/accept", {
      worker_id: ids.workerId,
      consent_version: CONSENT_VERSION,
      purposes: ["profiling", "resume_generation"],
    });
    expect(consent.consent_id).toBeTruthy();

    // 3. chat session + multi-turn interview until it flips extraction_ready.
    const session = await post("/chat/session", {}, token);
    ids.sessionId = session.session_id;
    expect(ids.sessionId).toBeTruthy();

    const turns = [
      "Namaste bhai, kaam dhundh raha hoon",
      "VMC operator hoon, Fanuc controller",
      "5 saal ka experience hai",
      "Pune mein kaam chahiye, ready hoon",
      "Setting aur programming dono aata hai",
      "Bas itna hi bhai",
    ];
    const asked: (string | null)[] = [];
    let ready = false;
    for (const text of turns) {
      const r = await post("/chat/message", { session_id: ids.sessionId, text }, token);
      expect(typeof r.reply).toBe("string");
      expect(r.reply.length).toBeGreaterThan(0);
      asked.push(r.asked_question_id ?? null);
      if (r.extraction_ready === true) {
        ready = true;
        break;
      }
    }
    expect(ready).toBe(true);

    // 4. State persisted across turns: at least 3 turns, advancing (never restart Q1).
    const sessionRow = (await client.db.select().from(chatSessions)).find((s) => s.id === ids.sessionId);
    const state = sessionRow?.conversationState as
      | { turn_count?: number; asked_question_ids?: string[] }
      | null;
    expect(state?.turn_count ?? 0).toBeGreaterThanOrEqual(3);
    expect(new Set(state?.asked_question_ids ?? []).size).toBeGreaterThanOrEqual(3);
    expect(state?.asked_question_ids?.[0]).toBe("role"); // advanced from the first topic, not stuck

    // 5. AUTO extraction (no manual /profile/extract). Poll until 'extracted'.
    await pollExtractedProfile();
    expect(ids.profileId).toBeTruthy();
    const profRow = (await client.db.select().from(workerProfiles)).find((p) => p.id === ids.profileId);
    expect(profRow?.profileStatus).toBe("extracted");

    // 6. confirm
    const confirm = await post("/profile/confirm", { profile_id: ids.profileId }, token);
    expect(confirm.profile_status).toBe("confirmed");

    // 7. resume
    const resume = await post("/resume/generate", { worker_id: ids.workerId, profile_id: ids.profileId });
    expect(resume.resume_id).toBeTruthy();
    expect(typeof resume.resume_text).toBe("string");
    ids.resumeId = resume.resume_id;
  });

  it("emitted the expected events along the flow (incl. auto-extraction)", async () => {
    const names = new Set((await myEvents()).map((e) => e.eventName));
    for (const expected of [
      "worker.created",
      "worker.otp_verified",
      "consent.accepted",
      "chat.session_started",
      "chat.message_received",
      "chat.message_sent",
      "profile.extraction_ready",
      "profile.extraction_requested", // emitted by the AUTO trigger, not a manual call
      "profile.extraction_completed",
      "profile.confirmed",
      "resume.generated",
    ]) {
      expect(names.has(expected), `expected event "${expected}" to be emitted`).toBe(true);
    }
  });

  it("emits profile.extraction_completed exactly once for the worker", async () => {
    const completed = (await myEvents()).filter(
      (e) =>
        e.eventName === "profile.extraction_completed" &&
        (e.payload as { worker_id?: string } | null)?.worker_id === ids.workerId,
    );
    expect(completed.length).toBe(1);
  });

  it("persists AI usage/cost metadata on the ai_job (model, tokens, cost, real_call)", async () => {
    const job = await myCompletedJob();
    expect(job, "a completed extraction ai_job for this worker").toBeDefined();

    // model exists
    expect(job!.modelName).toBeTruthy();
    // token usage exists (mock path → 0; real path → real counts), total = in + out
    expect(typeof job!.inputTokens).toBe("number");
    expect(typeof job!.outputTokens).toBe("number");
    expect(typeof job!.totalTokens).toBe("number");
    expect(job!.totalTokens).toBe((job!.inputTokens ?? 0) + (job!.outputTokens ?? 0));
    // cost exists
    expect(typeof job!.costInr).toBe("number");
    // real_call behavior is correct: false on the safe mock path (true once the
    // real LLM is enabled for this role).
    expect(typeof job!.realCall).toBe("boolean");
    expect(job!.realCall).toBe(false);

    // The dedicated ai.cost_recorded event carries the same operational metadata.
    const costEvents = (await client.db.select().from(events)).filter(
      (e) =>
        e.eventName === "ai.cost_recorded" &&
        (e.payload as { ai_job_id?: string } | null)?.ai_job_id === job!.id,
    );
    expect(costEvents.length).toBeGreaterThanOrEqual(1);
    const p = costEvents[0]!.payload as { model?: string; real_call?: boolean };
    expect(p.model).toBeTruthy();
    expect(p.real_call).toBe(false);
  });

  it("never writes raw PII (phone) into the events table, and stores only hashes/ciphertext", async () => {
    // (a) No raw number anywhere in this run's events (E.164 or national form).
    const serialized = JSON.stringify(await myEvents());
    expect(serialized).not.toContain(PHONE);
    expect(serialized).not.toContain(NATIONAL);

    // (b) The worker row holds only an HMAC hash + AES ciphertext — never the raw number.
    const me = (await client.db.select().from(workers)).find((w) => w.id === ids.workerId);
    expect(me).toBeDefined();
    expect(me!.phoneHash).toMatch(/^[0-9a-f]{64}$/); // keyed HMAC-SHA256
    expect(me!.phoneE164.startsWith("v1.")).toBe(true); // AES-256-GCM ciphertext token
    expect(JSON.stringify(me)).not.toContain(NATIONAL);
  });

  it("keeps the interview stateful across turns (advances, never repeats Q1)", async () => {
    // Fresh worker + session so we start the interview from turn 0.
    const phone = `+9197${String(Date.now()).slice(-8)}`;
    const reqOtp = await post("/auth/otp/request", { phone });
    const verify = await post("/auth/otp/verify", { phone, otp: reqOtp.dev_otp });
    const workerId = verify.worker_id as string;
    const token = verify.access_token as string;
    // Consent is the gate (invariant 6): chat is blocked until it is accepted.
    await post("/consent/accept", {
      worker_id: workerId,
      consent_version: CONSENT_VERSION,
      purposes: ["profiling", "resume_generation"],
    });
    const session = await post("/chat/session", {}, token);
    const sessionId = session.session_id as string;

    const messages = ["namaste bhai", "VMC operator hoon", "5 saal ka experience"];
    const asked: (string | null)[] = [];
    for (const text of messages) {
      const reply = await post("/chat/message", { session_id: sessionId, text }, token);
      expect(reply.reply.length).toBeGreaterThan(0);
      asked.push(reply.asked_question_id ?? null);
    }

    expect(asked).toEqual(["role", "machines", "experience"]);
    expect(new Set(asked).size).toBe(3);

    const rows = await client.db.select().from(chatSessions);
    const row = rows.find((r) => r.id === sessionId);
    const state = row?.conversationState as
      | { turn_count?: number; asked_question_ids?: string[] }
      | null;
    expect(state?.turn_count).toBe(3);
    expect(state?.asked_question_ids).toEqual(["role", "machines", "experience"]);

    // Privacy: persisted interview state carries topic ids / counts / slugs ONLY —
    // never the raw worker message text.
    const stateJson = JSON.stringify(row?.conversationState ?? {});
    for (const raw of messages) {
      expect(stateJson).not.toContain(raw);
    }

    const evRows = await client.db.select().from(events);
    const sentForSession = evRows.filter(
      (e) =>
        e.eventName === "chat.message_sent" &&
        (e.payload as { session_id?: string } | null)?.session_id === sessionId,
    );
    expect(sentForSession.length).toBe(3);
  });
});
