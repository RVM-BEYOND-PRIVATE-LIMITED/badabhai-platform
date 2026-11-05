import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { ForbiddenException } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDbClient, type DbClient } from "@badabhai/db";
import type { ServerConfig } from "@badabhai/config";
import type { RequestContext } from "../common/request-context";
import { PinRepository } from "./pin.repository";
import { PinService } from "./pin.service";
import { ADMIN_ACTION_CODES } from "../admin/admin-action-codes";

/**
 * #2562 (N1) — the DURABLE admin PIN-reset gate against Postgres.
 *
 * The unit suite proves the comparison against a mocked repository. This one proves the
 * production query reads the real `audit_logs` row written by an admin reset, and that a
 * session created BEFORE that row is refused end to end while one created at/after it is
 * allowed.
 */

const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";
const TAG = randomUUID().slice(0, 8);

function assertLocalDatabase(url: string): void {
  const host = new URL(url).hostname;
  if (!["localhost", "127.0.0.1", "::1"].includes(host)) {
    throw new Error(`DB tests write fixtures; refusing non-local host ${host}`);
  }
}

const CTX: RequestContext = { correlationId: randomUUID(), requestId: `pin-gate-${TAG}` };

describe.skipIf(!RUN)("admin PIN-reset gate — against Postgres (#2562)", () => {
  let client!: DbClient;
  let pins!: PinRepository;
  let service!: PinService;
  let workerId!: string;
  let resetAt!: Date;

  beforeAll(async () => {
    assertLocalDatabase(DATABASE_URL);
    client = createDbClient(DATABASE_URL, { max: 2 });
    const { sql, db } = client;

    const [worker] = await sql<{ id: string }[]>`
      INSERT INTO workers (phone_e164, phone_hash, status)
      VALUES (${`enc:pin-gate-${TAG}`}, ${`hmac:pin-gate-${TAG}`}, 'active')
      RETURNING id
    `;
    workerId = worker!.id;

    const [audit] = await sql<{ created_at: string | Date }[]>`
      INSERT INTO audit_logs (actor_type, actor_id, action, entity_type, entity_id, metadata)
      VALUES ('admin', ${randomUUID()}::uuid, ${ADMIN_ACTION_CODES.worker_pin_reset}, 'worker',
              ${workerId}::uuid, '{}'::jsonb)
      RETURNING created_at
    `;
    resetAt = new Date(audit!.created_at);

    pins = new PinRepository(db);
    service = new PinService(
      {} as ServerConfig,
      { emit: vi.fn(async () => undefined) } as never,
      {} as never,
      { hash: (pin: string) => ({ pinHash: `pin$${pin}`, pepperVersion: 1 }), isCorrectFormat: () => true } as never,
      pins,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
  });

  afterAll(async () => {
    if (!client) return;
    try {
      await client.sql`DELETE FROM audit_logs WHERE entity_id = ${workerId}::uuid`;
      await client.sql`DELETE FROM workers WHERE id = ${workerId}::uuid`;
    } finally {
      await client.sql.end({ timeout: 5 });
    }
  });

  it("reads the latest admin reset from the real indexed audit row", async () => {
    await expect(pins.latestAdminPinResetAt(workerId)).resolves.toEqual(resetAt);
  });

  it("refuses a session created BEFORE the reset, and allows one at/after it", async () => {
    const err = await service
      .setPin(workerId, "1234", CTX, resetAt.getTime() - 1)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect((err as ForbiddenException).getResponse()).toMatchObject({
      code: "PIN_RESET_REQUIRES_PHONE_CODE",
    });
    // Nothing was written by the refused attempt.
    await expect(pins.findByWorkerId(workerId)).resolves.toBeUndefined();

    await expect(
      service.setPin(workerId, "1234", CTX, resetAt.getTime()),
    ).resolves.toBeUndefined();
    await expect(pins.findByWorkerId(workerId)).resolves.toMatchObject({
      workerId,
      pinHash: "pin$1234",
    });
  });
});
