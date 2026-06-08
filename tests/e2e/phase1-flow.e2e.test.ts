import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient, events, type DbClient, type EventRow } from "@badabhai/db";

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

    // 4. extract profile
    const extract = await post("/profile/extract", {
      worker_id: ids.workerId,
      session_id: ids.sessionId,
    });
    expect(extract.profile_id).toBeTruthy();
    ids.profileId = extract.profile_id;

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
});
