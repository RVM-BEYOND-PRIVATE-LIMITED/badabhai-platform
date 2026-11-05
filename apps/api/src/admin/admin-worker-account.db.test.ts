import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { NotFoundException } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDbClient, type DbClient } from "@badabhai/db";
import type { RequestContext } from "../common/request-context";
import { EventsRepository } from "../events/events.repository";
import { EventsService } from "../events/events.service";
import { PinRepository } from "../auth/pin.repository";
import type { SessionService } from "../auth/session.service";
import type { PayerSessionService } from "../payers/payer-session.service";
import type { AdminRepository } from "./admin.repository";
import { AdminActionsRepository } from "./admin-actions.repository";
import { AdminActionsService } from "./admin-actions.service";
import type { AdminInviteService } from "./admin-invite.service";

/**
 * #2562 worker account actions AGAINST POSTGRES — the acceptance criteria that are about the
 * SYSTEM OF RECORD, not HTTP shape:
 *
 *   - a PIN reset really DELETES the `worker_credentials` row (so the old PIN can never match
 *     again) and writes the audit row + both events in the same commit;
 *   - suspend/unsuspend really move `workers.status` and leave a written reason;
 *   - sign-out-all reaches the worker-session seam;
 *   - an unknown worker writes nothing.
 *
 * The Redis/session side is a spy: its own "every session rejected" contract is covered by
 * `session.service.test.ts` (`revokeAll`), which is exactly the seam these actions call.
 */
const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

/** This file WRITES fixture rows, and the repo-root env points at PRODUCTION: local hosts only. */
function assertLocalDatabase(url: string): void {
  const host = new URL(url).hostname;
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error(`admin-worker-account.db refuses to write to a non-local host (${host})`);
  }
}

const TAG = randomUUID().slice(0, 8);
const ADMIN_ID = randomUUID();
const CTX: RequestContext = { correlationId: randomUUID(), requestId: `worker-account-db-${TAG}` };
const REASON = {
  signOut: {
    reason_code: "worker_sign_out_all" as const,
    reason_text: "Worker reported a lost handset on the support call",
  },
  pin: {
    reason_code: "worker_pin_reset" as const,
    reason_text: "Worker cannot recall the existing device PIN",
  },
  suspend: {
    reason_code: "worker_suspend" as const,
    reason_text: "Repeated abusive messages confirmed by the review team",
  },
  unsuspend: {
    reason_code: "worker_unsuspend" as const,
    reason_text: "Appeal upheld after the review team cleared the account",
  },
};

describe.skipIf(!RUN)("#2562 worker account actions — against Postgres", () => {
  let client!: DbClient;
  let service!: AdminActionsService;
  let workerId!: string;
  const workerSessions = { revokeAll: vi.fn(async () => 2) };

  beforeAll(async () => {
    assertLocalDatabase(DATABASE_URL);
    client = createDbClient(DATABASE_URL, { max: 4 });
    const db = client.db;

    const [row] = await client.sql<{ id: string }[]>`
      INSERT INTO workers (phone_e164, phone_hash, status)
      VALUES (${`enc:${TAG}`}, ${`hmac:${TAG}`}, 'active')
      RETURNING id
    `;
    workerId = row!.id;
    await new PinRepository(db).upsertPin(workerId, `pin-hash-${TAG}`, 1);

    service = new AdminActionsService(
      new AdminActionsRepository(db),
      {} as AdminRepository,
      new EventsService(new EventsRepository(db), { NODE_ENV: "test" } as never),
      {} as PayerSessionService,
      {} as AdminInviteService,
      workerSessions as unknown as SessionService,
      new PinRepository(db),
    );
  });

  afterAll(async () => {
    if (!client) return;
    try {
      await client.sql`DELETE FROM audit_logs WHERE entity_id = ${workerId}::uuid`;
      await client.sql`DELETE FROM events WHERE correlation_id = ${CTX.correlationId}::uuid`;
      await client.sql`DELETE FROM workers WHERE id = ${workerId}::uuid`;
    } finally {
      await client.sql.end({ timeout: 5 });
    }
  });

  it("PIN reset DELETES the credential and records the reason + both events", async () => {
    const res = await service.resetWorkerPin(ADMIN_ID, workerId, REASON.pin, CTX);
    expect(res).toEqual({ target_id: workerId, changed: true });

    const creds = await client.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM worker_credentials WHERE worker_id = ${workerId}::uuid
    `;
    expect(creds[0]!.n).toBe(0);

    const audit = await client.sql<{ action: string; metadata: Record<string, unknown> }[]>`
      SELECT action, metadata FROM audit_logs WHERE entity_id = ${workerId}::uuid
    `;
    expect(audit).toHaveLength(1);
    expect(audit[0]!.action).toBe("worker_pin_reset");
    expect(audit[0]!.metadata).toMatchObject({
      reason_code: "worker_pin_reset",
      reason_text: REASON.pin.reason_text,
    });

    const events = await client.sql<{ event_name: string; actor_type: string }[]>`
      SELECT event_name, actor_type FROM events
      WHERE correlation_id = ${CTX.correlationId}::uuid
      ORDER BY event_name
    `;
    expect(events.map((e) => e.event_name)).toEqual([
      "admin.action_performed",
      "worker.pin_reset",
    ]);
    // The PIN reset was ADMIN-initiated; the domain fact must not claim the worker did it.
    expect(events.every((e) => e.actor_type === "admin")).toBe(true);
    // The reset ends every session: the only path back to a new PIN is a fresh OTP login.
    expect(workerSessions.revokeAll).toHaveBeenCalledWith(workerId);
  });

  it("suspend moves the durable status and leaves a written reason; unsuspend restores it", async () => {
    const suspended = await service.suspendWorker(ADMIN_ID, workerId, REASON.suspend, CTX);
    expect(suspended).toEqual({ target_id: workerId, changed: true });

    const [afterSuspend] = await client.sql<{ status: string }[]>`
      SELECT status FROM workers WHERE id = ${workerId}::uuid
    `;
    expect(afterSuspend!.status).toBe("suspended");

    // Idempotent: a second suspend is a no-op with no new audit/event.
    expect(await service.suspendWorker(ADMIN_ID, workerId, REASON.suspend, CTX)).toEqual({
      target_id: workerId,
      changed: false,
    });

    const unsuspended = await service.unsuspendWorker(ADMIN_ID, workerId, REASON.unsuspend, CTX);
    expect(unsuspended).toEqual({ target_id: workerId, changed: true });
    const [afterUnsuspend] = await client.sql<{ status: string }[]>`
      SELECT status FROM workers WHERE id = ${workerId}::uuid
    `;
    expect(afterUnsuspend!.status).toBe("active");

    const audit = await client.sql<{ action: string }[]>`
      SELECT action FROM audit_logs WHERE entity_id = ${workerId}::uuid ORDER BY action
    `;
    expect(audit.map((a) => a.action)).toEqual([
      "worker_pin_reset",
      "worker_reinstated",
      "worker_suspended",
    ]);
  });

  it("sign-out-all writes the audit row and reaches the session sweep", async () => {
    const res = await service.signOutAllWorker(ADMIN_ID, workerId, REASON.signOut, CTX);
    expect(res).toEqual({ target_id: workerId, changed: true });
    expect(workerSessions.revokeAll).toHaveBeenCalledWith(workerId);

    const [audit] = await client.sql<{ action: string }[]>`
      SELECT action FROM audit_logs
      WHERE entity_id = ${workerId}::uuid AND action = 'worker_signed_out_all'
    `;
    expect(audit!.action).toBe("worker_signed_out_all");
  });

  it("unknown worker → 404 and NO audit/event", async () => {
    const missing = randomUUID();
    await expect(
      service.resetWorkerPin(ADMIN_ID, missing, REASON.pin, CTX),
    ).rejects.toBeInstanceOf(NotFoundException);
    const audits = await client.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM audit_logs WHERE entity_id = ${missing}::uuid
    `;
    expect(audits[0]!.n).toBe(0);
  });
});
