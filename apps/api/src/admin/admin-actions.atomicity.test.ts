import "reflect-metadata";
import { describe, it, expect } from "vitest";
import type { EventsService } from "../events/events.service";
import type { RequestContext } from "../common/request-context";
import type { PayerOrgsRepository } from "../payers/payer-orgs.repository";
import type { AdminRepository } from "./admin.repository";
import type { AdminActionsRepository } from "./admin-actions.repository";
import { AdminActionsService } from "./admin-actions.service";

/**
 * ATOMICITY (must-fix H3) — proves the governed-action SoR write + the `admin.action_performed`
 * emit run inside ONE transaction whose callback, on an emit throw AFTER the SoR write, leaves
 * the COMMITTED world unchanged (rolled back), and that a retry re-does both and emits exactly
 * one event.
 *
 * We model a Postgres transaction with a STAGING world: writes inside the tx mutate a deep copy;
 * the copy is committed to the canonical world only if the callback resolves, and DISCARDED if it
 * throws. The repo's write methods + the (mocked) EventsService.emit operate on the `tx` handle
 * they are given — exactly as the real Drizzle tx + the H3 transaction-aware emit do. This isolates
 * the SERVICE's control flow (the thing H3 fixed: write + emit in ONE withTransaction) from the DB.
 */

const ADMIN_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const PAYER_ID = "bbbbbbbb-0000-4000-8000-000000000002";
const CTX: RequestContext = {
  requestId: "req-1",
  correlationId: "11111111-1111-4111-8111-111111111111",
};

interface World {
  payerStatus: string;
  events: { idempotencyKey?: string; actionCode: string }[];
}

/**
 * Build a service whose AdminActionsRepository.withTransaction is a real commit/rollback
 * simulator and whose suspendPayer write + events.emit mutate the STAGED world via the `tx` token.
 * `failEmitOnce` makes the first emit throw AFTER the staged write (simulating emit failing inside
 * the tx) so we can prove the staged write is discarded (the committed world is untouched).
 */
function makeHarness(opts: { failEmitOnce?: boolean } = {}) {
  const world: World = { payerStatus: "active", events: [] };
  let armed = opts.failEmitOnce ?? false;

  // The `tx` token IS the staged world for the duration of one transaction.
  const withTransaction = async <T>(cb: (tx: World) => Promise<T>): Promise<T> => {
    const staged: World = structuredClone(world);
    const result = await cb(staged); // may throw → staged is discarded (rollback)
    world.payerStatus = staged.payerStatus;
    world.events = staged.events;
    return result;
  };

  const actions = {
    withTransaction,
    findPayerStatus: async () => ({ id: PAYER_ID, status: world.payerStatus }),
    // The guarded write: only flips active→suspended; mutates the STAGED world via `tx`.
    suspendPayer: async (_id: string, tx: World | undefined) => {
      const w = tx!;
      if (w.payerStatus !== "active") return undefined;
      w.payerStatus = "suspended";
      return { status: "suspended" as const };
    },
  } as unknown as AdminActionsRepository;

  const admins = {} as unknown as AdminRepository;

  const events = {
    emit: async (params: { idempotencyKey?: string; payload: { action_code: string }; tx?: World }) => {
      if (armed) {
        armed = false; // fail once, then succeed on retry
        throw new Error("simulated emit failure");
      }
      // Insert the event onto the SAME staged tx world (H3: emit rides the caller tx).
      const w = params.tx!;
      w.events.push({ idempotencyKey: params.idempotencyKey, actionCode: params.payload.action_code });
      return undefined;
    },
  } as unknown as EventsService;

  // ADR-0027 B5.x Inc 2: the credit-grant path resolves the target payer's org. These atomicity
  // tests only exercise suspendPayer (no grant), so an unused stub suffices.
  const payerOrgs = {} as unknown as PayerOrgsRepository;

  const service = new AdminActionsService(actions, admins, events, payerOrgs);
  return { service, world };
}

describe("ADMIN-3a atomicity (H3) — SoR write + emit commit together or roll back", () => {
  it("emit throwing after the SoR write rolls back the suspend (payer NOT left suspended)", async () => {
    const h = makeHarness({ failEmitOnce: true });

    await expect(h.service.suspendPayer(ADMIN_ID, PAYER_ID, CTX)).rejects.toThrow(/emit failure/);

    // ROLLBACK: the committed world still shows ACTIVE + NO event (the staged write was discarded).
    expect(h.world.payerStatus).toBe("active");
    expect(h.world.events).toHaveLength(0);
  });

  it("a retry after an emit failure re-does BOTH and emits exactly one event", async () => {
    const h = makeHarness({ failEmitOnce: true });

    await expect(h.service.suspendPayer(ADMIN_ID, PAYER_ID, CTX)).rejects.toThrow();
    // Retry (emit no longer armed to fail): both commit together.
    const res = await h.service.suspendPayer(ADMIN_ID, PAYER_ID, CTX);

    expect(res).toEqual({ target_id: PAYER_ID, changed: true });
    expect(h.world.payerStatus).toBe("suspended");
    expect(h.world.events).toHaveLength(1);
    expect(h.world.events[0]!.actionCode).toBe("payer_suspended");
  });

  it("a successful suspend commits the SoR write AND the event together (one transaction)", async () => {
    const h = makeHarness({ failEmitOnce: false });
    const res = await h.service.suspendPayer(ADMIN_ID, PAYER_ID, CTX);
    expect(res).toEqual({ target_id: PAYER_ID, changed: true });
    expect(h.world.payerStatus).toBe("suspended");
    expect(h.world.events).toHaveLength(1);
  });
});
