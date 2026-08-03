import { describe, it, expect, vi, beforeEach } from "vitest";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { createEvent, type CreateEventInput } from "@badabhai/event-schema";
import type { RequestContext } from "../common/request-context";
import type { EventsService } from "../events/events.service";
import type { PayerSessionService } from "../payers/payer-session.service";
import type { AdminRepository } from "./admin.repository";
import type { AdminActionsRepository } from "./admin-actions.repository";
import { AdminActionsService } from "./admin-actions.service";

const CTX: RequestContext = {
  requestId: "req-1",
  correlationId: "11111111-1111-1111-1111-111111111111",
};

const ADMIN_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const PAYER_ID = "bbbbbbbb-0000-4000-8000-000000000002";
const POSTING_ID = "cccccccc-0000-4000-8000-000000000003";
const WORKER_ID = "dddddddd-0000-4000-8000-000000000004";
const TARGET_ADMIN_ID = "eeeeeeee-0000-4000-8000-000000000005";
const LEDGER_ID = "ffffffff-0000-4000-8000-000000000006";

// The sanctioned action CODES (the ONLY free-form string the spine carries — the WHAT, not the
// value). The no-value scan deliberately EXCLUDES action_code (a code like `payer_suspended`
// legitimately shares a substring with a status value); it scans every OTHER leaf instead.
const SANCTIONED_ACTION_CODES = new Set([
  "payer_suspended",
  "payer_reinstated",
  "credits_granted",
  "posting_force_closed",
  "worker_flagged",
  "worker_unflagged",
  "admin_invited",
  "admin_role_changed",
  "admin_suspended",
]);

// Every VALUE/PII string that must NEVER appear in an emitted event payload OUTSIDE the
// action_code (the new status, the amount, the reason codes, an email). The spine carries the
// action CODE + opaque ids ONLY — no value/amount/reason/email rides on any other field.
const FORBIDDEN_VALUE_FRAGMENTS = [
  "suspended",
  "active",
  "closed",
  "goodwill",
  "correction",
  "promo",
  "support_resolution",
  "quality_review",
  "abuse_report",
  "duplicate",
  "ops@badabhai.in",
  "ops_admin",
  "500", // a representative grant amount used below
];

interface Mocks {
  /** ADR-0037 — the payer session revoker suspension calls after the tx commits. */
  sessions: { revokeAllForPayer: ReturnType<typeof vi.fn> };
  actions: {
    findPayerStatus: ReturnType<typeof vi.fn>;
    suspendPayer: ReturnType<typeof vi.fn>;
    reinstatePayer: ReturnType<typeof vi.fn>;
    suspendPayerInventory: ReturnType<typeof vi.fn>;
    reinstatePayerInventory: ReturnType<typeof vi.fn>;
    grantCredits: ReturnType<typeof vi.fn>;
    findPostingStatus: ReturnType<typeof vi.fn>;
    forceClosePosting: ReturnType<typeof vi.fn>;
    openFlag: ReturnType<typeof vi.fn>;
    resolveFlag: ReturnType<typeof vi.fn>;
    withTransaction: ReturnType<typeof vi.fn>;
  };
  admins: {
    create: ReturnType<typeof vi.fn>;
    updateRole: ReturnType<typeof vi.fn>;
    suspend: ReturnType<typeof vi.fn>;
    findById: ReturnType<typeof vi.fn>;
    countActiveSuperAdmins: ReturnType<typeof vi.fn>;
    withTransaction: ReturnType<typeof vi.fn>;
  };
  events: { emit: ReturnType<typeof vi.fn> };
  service: AdminActionsService;
}

/** A fake `tx` token the mocked withTransaction hands to the callback (the repo mocks ignore it). */
const FAKE_TX = { __tx: true } as unknown;

function make(): Mocks {
  const actions = {
    findPayerStatus: vi.fn(),
    suspendPayer: vi.fn(),
    reinstatePayer: vi.fn(),
    // ADR-0037 Decision 1 — the inventory cascade. Default to a NON-ZERO result so a test
    // that forgets to stub it still exercises the emit path with real counts.
    suspendPayerInventory: vi.fn(async () => ({ postings: 3, jobs: 1 })),
    reinstatePayerInventory: vi.fn(async () => ({ postings: 3, jobs: 1 })),
    grantCredits: vi.fn(),
    findPostingStatus: vi.fn(),
    forceClosePosting: vi.fn(),
    openFlag: vi.fn(),
    resolveFlag: vi.fn(),
    withTransaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(FAKE_TX)),
  };
  const admins = {
    create: vi.fn(),
    updateRole: vi.fn(),
    suspend: vi.fn(),
    findById: vi.fn(),
    countActiveSuperAdmins: vi.fn(async () => 2),
    withTransaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(FAKE_TX)),
  };
  const events = { emit: vi.fn(async () => undefined) };
  // ADR-0037 — suspension revokes every live payer session. Spied so tests can assert
  // revocation happened (and did NOT happen on the idempotent no-op path).
  const sessions = { revokeAllForPayer: vi.fn(async () => 2) };
  const service = new AdminActionsService(
    actions as unknown as AdminActionsRepository,
    admins as unknown as AdminRepository,
    events as unknown as EventsService,
    sessions as unknown as PayerSessionService,
  );
  return { actions, admins, events, sessions, service };
}

/** The emit params the service passed to EventsService.emit (camelCase tracing ids). */
interface CapturedEmit {
  event_name: "admin.action_performed";
  actor: { actor_type: string; actor_id: string };
  subject: { subject_type: string; subject_id: string };
  payload: Record<string, unknown>;
  correlationId: string;
  requestId: string;
  idempotencyKey: string;
}

/** The single emitted event call (asserts EXACTLY ONE emit happened). */
function soleEmit(events: Mocks["events"]): CapturedEmit {
  expect(events.emit).toHaveBeenCalledTimes(1);
  return events.emit.mock.calls[0]![0] as CapturedEmit;
}

/**
 * Pick ONE emit by event name out of a multi-emit action, asserting there is exactly one.
 *
 * ADR-0037 made the payer lifecycle actions emit TWO events: the value-free
 * `admin.action_performed` (an admin did a thing) and the `payer.*` transition (the payer
 * moved from X to Y). They answer different questions and the audit mandate needs both,
 * so `soleEmit` no longer fits those two actions — it is deliberately kept for every
 * other action, where "exactly one event" is still the contract.
 */
function emitNamed(events: Mocks["events"], eventName: string): CapturedEmit {
  const matches = events.emit.mock.calls
    .map((c) => c[0] as CapturedEmit)
    .filter((e) => (e as { event_name?: string }).event_name === eventName);
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

/** Recursively walk every primitive leaf of a value (for the no-value/no-PII scan). */
function leaves(value: unknown, out: string[] = []): string[] {
  if (value === null || value === undefined) return out;
  if (typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) leaves(v, out);
  } else {
    out.push(String(value));
  }
  return out;
}

/**
 * Assert an emitted action event is registry-VALID, carries EXACTLY the 4 payload keys
 * {admin_id, action_code, target_type, target_id}, and that NO value/PII fragment rides on it.
 */
function assertValueFreeAction(
  emitted: CapturedEmit,
  expect_: { actionCode: string; subjectType: string; targetId: string },
): void {
  // 1) actor + subject are the session admin + the opaque target (not spoofable from a body).
  expect(emitted.event_name).toBe("admin.action_performed");
  expect(emitted.actor).toEqual({ actor_type: "admin", actor_id: ADMIN_ID });
  expect(emitted.subject).toEqual({
    subject_type: expect_.subjectType,
    subject_id: expect_.targetId,
  });

  // 2) the payload is EXACTLY the 4 code+id keys — no value/amount/status/reason key.
  expect(Object.keys(emitted.payload).sort()).toEqual(
    ["action_code", "admin_id", "target_id", "target_type"].sort(),
  );
  expect(emitted.payload).toEqual({
    admin_id: ADMIN_ID,
    action_code: expect_.actionCode,
    target_type: expect_.subjectType,
    target_id: expect_.targetId,
  });

  // 3) recursive no-value/no-PII scan over EVERY leaf of the payload.
  expect(SANCTIONED_ACTION_CODES.has(emitted.payload.action_code as string)).toBe(true);
  const { action_code: _code, ...rest } = emitted.payload;
  const blob = leaves(rest).join("");
  for (const frag of FORBIDDEN_VALUE_FRAGMENTS) {
    expect(blob, `value/PII "${frag}" must not ride on the spine`).not.toContain(frag);
  }

  // 4) it is a registry-VALID event end-to-end — build it EXACTLY as EventsService would (same
  //    createEvent path, source + metadata), which THROWS on an invalid/strict-violating payload.
  const built = createEvent<"admin.action_performed">({
    event_name: emitted.event_name,
    payload: emitted.payload as CreateEventInput<"admin.action_performed">["payload"],
    source: "api",
    correlation_id: emitted.correlationId,
    metadata: { environment: "test", service: "api", request_id: emitted.requestId },
    ...({ actor: emitted.actor, subject: emitted.subject } as Pick<
      CreateEventInput<"admin.action_performed">,
      "actor" | "subject"
    >),
  });
  expect(built.event_name).toBe("admin.action_performed");
}

let m: Mocks;
beforeEach(() => {
  m = make();
});

// ---------------------------------------------------------------------------
// payers — suspend / reinstate
// ---------------------------------------------------------------------------

describe("suspendPayer", () => {
  it("active payer → suspends the SoR + emits the value-free payer_suspended action", async () => {
    m.actions.findPayerStatus.mockResolvedValue({ id: PAYER_ID, status: "active" });
    m.actions.suspendPayer.mockResolvedValue({ status: "suspended", previousStatus: "active" });

    const res = await m.service.suspendPayer(ADMIN_ID, PAYER_ID, CTX);

    // SoR mutated, target from arg; the 2nd arg is the H3 transaction handle.
    expect(m.actions.suspendPayer).toHaveBeenCalledWith(PAYER_ID, FAKE_TX);
    expect(res).toEqual({ target_id: PAYER_ID, changed: true });
    assertValueFreeAction(emitNamed(m.events, "admin.action_performed"), {
      actionCode: "payer_suspended",
      subjectType: "payer",
      targetId: PAYER_ID,
    });
  });

  it("ADR-0037: also emits payer.suspended carrying BOTH ends of the transition", async () => {
    m.actions.findPayerStatus.mockResolvedValue({ id: PAYER_ID, status: "active" });
    m.actions.suspendPayer.mockResolvedValue({ status: "suspended", previousStatus: "active" });

    await m.service.suspendPayer(ADMIN_ID, PAYER_ID, CTX);

    const e = emitNamed(m.events, "payer.suspended") as unknown as {
      payload: Record<string, unknown>;
      tx?: unknown;
    };
    expect(e.payload).toEqual({
      payer_id: PAYER_ID,
      previous_status: "active",
      new_status: "suspended",
    });
    // Rides the SAME transaction as the SoR write (H3) — never a separate commit.
    expect(e.tx).toBe(FAKE_TX);
  });

  it("ADR-0037 D1: freezes the inventory and reports the counts on the same transaction", async () => {
    m.actions.findPayerStatus.mockResolvedValue({ id: PAYER_ID, status: "active" });
    m.actions.suspendPayer.mockResolvedValue({ status: "suspended", previousStatus: "active" });
    m.actions.suspendPayerInventory.mockResolvedValue({ postings: 4, jobs: 2 });

    await m.service.suspendPayer(ADMIN_ID, PAYER_ID, CTX);

    // The cascade is called with the tx handle — "cannot recruit while suspended" and
    // "is suspended" have to become true together or neither does.
    expect(m.actions.suspendPayerInventory).toHaveBeenCalledWith(PAYER_ID, FAKE_TX);

    const e = emitNamed(m.events, "payer.inventory_suspended") as unknown as {
      payload: Record<string, unknown>;
      tx?: unknown;
    };
    expect(e.payload).toEqual({
      payer_id: PAYER_ID,
      postings_affected: 4,
      jobs_affected: 2,
    });
    expect(e.tx).toBe(FAKE_TX);
  });

  it("ADR-0037 D1: emits the cascade event even when NOTHING was live (zero is evidence)", async () => {
    // A zero-count event is what distinguishes "this payer had no open jobs" from "the
    // cascade never ran" — the first question asked when a job is reported still visible
    // after a suspension. Suppressing it would erase that distinction from the spine.
    m.actions.findPayerStatus.mockResolvedValue({ id: PAYER_ID, status: "pending" });
    m.actions.suspendPayer.mockResolvedValue({ status: "suspended", previousStatus: "pending" });
    m.actions.suspendPayerInventory.mockResolvedValue({ postings: 0, jobs: 0 });

    await m.service.suspendPayer(ADMIN_ID, PAYER_ID, CTX);

    const e = emitNamed(m.events, "payer.inventory_suspended") as unknown as {
      payload: Record<string, unknown>;
    };
    expect(e.payload).toEqual({ payer_id: PAYER_ID, postings_affected: 0, jobs_affected: 0 });
  });

  it("ADR-0037 D1: an ALREADY-suspended payer runs no cascade (idempotent, no double freeze)", async () => {
    // The re-suspend no-ops before the transaction. Re-running the cascade here would be
    // actively harmful: the postings are already `suspended`, so a second capture would
    // overwrite `previous_status` with 'suspended' itself and reinstatement would restore
    // them to a frozen state — permanently invisible with no error anywhere.
    m.actions.findPayerStatus.mockResolvedValue({ id: PAYER_ID, status: "suspended" });

    const res = await m.service.suspendPayer(ADMIN_ID, PAYER_ID, CTX);

    expect(res).toEqual({ target_id: PAYER_ID, changed: false });
    expect(m.actions.suspendPayerInventory).not.toHaveBeenCalled();
  });

  it("ADR-0037: a PENDING payer CAN now be suspended (it used to 409 for every real payer)", async () => {
    m.actions.findPayerStatus.mockResolvedValue({ id: PAYER_ID, status: "pending" });
    m.actions.suspendPayer.mockResolvedValue({ status: "suspended", previousStatus: "pending" });

    const res = await m.service.suspendPayer(ADMIN_ID, PAYER_ID, CTX);

    expect(res).toEqual({ target_id: PAYER_ID, changed: true });
    // previous_status records that it was pending, so reinstate can put it BACK to pending
    // rather than granting an activation the payer never earned.
    const e = emitNamed(m.events, "payer.suspended") as unknown as {
      payload: Record<string, unknown>;
    };
    expect(e.payload).toMatchObject({ previous_status: "pending", new_status: "suspended" });
  });

  it("ADR-0037: revokes EVERY live session after the transaction commits", async () => {
    m.actions.findPayerStatus.mockResolvedValue({ id: PAYER_ID, status: "active" });
    m.actions.suspendPayer.mockResolvedValue({ status: "suspended", previousStatus: "active" });

    await m.service.suspendPayer(ADMIN_ID, PAYER_ID, CTX);

    expect(m.sessions.revokeAllForPayer).toHaveBeenCalledExactlyOnceWith(PAYER_ID);
  });

  it("ADR-0037: a revoke failure does NOT fail the suspension (the row is already committed)", async () => {
    m.actions.findPayerStatus.mockResolvedValue({ id: PAYER_ID, status: "active" });
    m.actions.suspendPayer.mockResolvedValue({ status: "suspended", previousStatus: "active" });
    m.sessions.revokeAllForPayer.mockRejectedValueOnce(new Error("redis down"));

    // The payer IS suspended; the per-request lifecycle gate in PayerAuthGuard closes the
    // window on the next request. Throwing here would report a committed change as failed.
    await expect(m.service.suspendPayer(ADMIN_ID, PAYER_ID, CTX)).resolves.toEqual({
      target_id: PAYER_ID,
      changed: true,
    });
  });

  it("already-suspended payer → idempotent no-op, NO SoR write, NO event", async () => {
    m.actions.findPayerStatus.mockResolvedValue({ id: PAYER_ID, status: "suspended" });

    const res = await m.service.suspendPayer(ADMIN_ID, PAYER_ID, CTX);

    expect(res).toEqual({ target_id: PAYER_ID, changed: false });
    expect(m.actions.suspendPayer).not.toHaveBeenCalled();
    expect(m.events.emit).not.toHaveBeenCalled();
  });

  it("unknown payer → 404, NO event", async () => {
    m.actions.findPayerStatus.mockResolvedValue(undefined);
    await expect(m.service.suspendPayer(ADMIN_ID, PAYER_ID, CTX)).rejects.toThrow(NotFoundException);
    expect(m.events.emit).not.toHaveBeenCalled();
  });

  it("a CONCURRENT writer moved the row (SoR returns undefined) → conflict, NO event", async () => {
    // This used to be "pending payer cannot be suspended". Under ADR-0037 pending IS
    // suspendable, so the only way the guarded update matches no row is that something
    // else changed the status between the read and the write. Retained as that guard.
    m.actions.findPayerStatus.mockResolvedValue({ id: PAYER_ID, status: "active" });
    m.actions.suspendPayer.mockResolvedValue(undefined);
    await expect(m.service.suspendPayer(ADMIN_ID, PAYER_ID, CTX)).rejects.toThrow(ConflictException);
    expect(m.events.emit).not.toHaveBeenCalled();
    // Nothing was suspended, so nothing may be revoked.
    expect(m.sessions.revokeAllForPayer).not.toHaveBeenCalled();
  });
});

describe("reinstatePayer", () => {
  it("suspended payer → reinstates + emits the value-free payer_reinstated action", async () => {
    m.actions.findPayerStatus.mockResolvedValue({ id: PAYER_ID, status: "suspended" });
    m.actions.reinstatePayer.mockResolvedValue({ status: "active" });

    const res = await m.service.reinstatePayer(ADMIN_ID, PAYER_ID, CTX);

    expect(m.actions.reinstatePayer).toHaveBeenCalledWith(PAYER_ID, FAKE_TX);
    expect(res).toEqual({ target_id: PAYER_ID, changed: true });
    assertValueFreeAction(emitNamed(m.events, "admin.action_performed"), {
      actionCode: "payer_reinstated",
      subjectType: "payer",
      targetId: PAYER_ID,
    });
  });

  it("ADR-0037: reinstate reports the status it RESTORED TO, not a hardcoded active", async () => {
    // A payer suspended while pending comes back as pending and must still verify —
    // otherwise suspend+reinstate would be a backdoor activation.
    m.actions.findPayerStatus.mockResolvedValue({ id: PAYER_ID, status: "suspended" });
    m.actions.reinstatePayer.mockResolvedValue({ status: "pending" });

    await m.service.reinstatePayer(ADMIN_ID, PAYER_ID, CTX);

    const e = emitNamed(m.events, "payer.reinstated") as unknown as {
      payload: Record<string, unknown>;
    };
    expect(e.payload).toEqual({
      payer_id: PAYER_ID,
      previous_status: "suspended",
      new_status: "pending",
    });
  });

  it("ADR-0037: reinstate never revokes sessions (it restores access, it does not remove it)", async () => {
    m.actions.findPayerStatus.mockResolvedValue({ id: PAYER_ID, status: "suspended" });
    m.actions.reinstatePayer.mockResolvedValue({ status: "active" });
    await m.service.reinstatePayer(ADMIN_ID, PAYER_ID, CTX);
    expect(m.sessions.revokeAllForPayer).not.toHaveBeenCalled();
  });

  it("already-active payer → idempotent no-op, NO event", async () => {
    m.actions.findPayerStatus.mockResolvedValue({ id: PAYER_ID, status: "active" });
    const res = await m.service.reinstatePayer(ADMIN_ID, PAYER_ID, CTX);
    expect(res).toEqual({ target_id: PAYER_ID, changed: false });
    expect(m.events.emit).not.toHaveBeenCalled();
  });

  it("ADR-0037 D1: thaws the inventory on the same transaction and reports the counts", async () => {
    m.actions.findPayerStatus.mockResolvedValue({ id: PAYER_ID, status: "suspended" });
    m.actions.reinstatePayer.mockResolvedValue({ status: "active" });
    m.actions.reinstatePayerInventory.mockResolvedValue({ postings: 4, jobs: 2 });

    await m.service.reinstatePayer(ADMIN_ID, PAYER_ID, CTX);

    expect(m.actions.reinstatePayerInventory).toHaveBeenCalledWith(PAYER_ID, FAKE_TX);
    const e = emitNamed(m.events, "payer.inventory_reinstated") as unknown as {
      payload: Record<string, unknown>;
      tx?: unknown;
    };
    expect(e.payload).toEqual({ payer_id: PAYER_ID, postings_affected: 4, jobs_affected: 2 });
    expect(e.tx).toBe(FAKE_TX);
  });

  it("ADR-0037 D1: thaws even when the payer is restored to PENDING (never strand the inventory)", async () => {
    // A payer suspended while `pending` is reinstated to `pending`, not `active`. Their
    // inventory must still be restored: they cannot authenticate to republish it
    // themselves, so leaving it frozen would strand it with no recovery path — and the
    // postings are harmless meanwhile, because `pending` blocks every payer route anyway.
    m.actions.findPayerStatus.mockResolvedValue({ id: PAYER_ID, status: "suspended" });
    m.actions.reinstatePayer.mockResolvedValue({ status: "pending" });
    m.actions.reinstatePayerInventory.mockResolvedValue({ postings: 1, jobs: 0 });

    await m.service.reinstatePayer(ADMIN_ID, PAYER_ID, CTX);

    expect(m.actions.reinstatePayerInventory).toHaveBeenCalledWith(PAYER_ID, FAKE_TX);
  });

  it("ADR-0037 D1: a NOT-suspended payer runs no thaw (nothing of theirs is frozen)", async () => {
    m.actions.findPayerStatus.mockResolvedValue({ id: PAYER_ID, status: "active" });
    await m.service.reinstatePayer(ADMIN_ID, PAYER_ID, CTX);
    expect(m.actions.reinstatePayerInventory).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// credits — grant (additive; amount stays OUT of the event)
// ---------------------------------------------------------------------------

const GRANT_KEY = "99999999-0000-4000-8000-00000000000a";

describe("grantCredits", () => {
  it("grants the SoR ledger + emits ONE value-free credits_granted (amount NOT in the event)", async () => {
    m.actions.findPayerStatus.mockResolvedValue({ id: PAYER_ID, status: "active" });
    m.actions.grantCredits.mockResolvedValue({ ledgerId: LEDGER_ID, balance: 500, applied: true });

    const res = await m.service.grantCredits(
      ADMIN_ID,
      PAYER_ID,
      { amount: 500, reason_code: "goodwill", idempotency_key: GRANT_KEY },
      CTX,
    );

    // The AMOUNT + reason go to the ledger SoR — NOT the event. The grant is keyed for H2.
    expect(m.actions.grantCredits).toHaveBeenCalledWith(PAYER_ID, 500, GRANT_KEY, FAKE_TX);
    expect(res).toEqual({ target_id: PAYER_ID, changed: true, ledger_id: LEDGER_ID, balance: 500 });
    const emitted = soleEmit(m.events);
    assertValueFreeAction(emitted, {
      actionCode: "credits_granted",
      subjectType: "payer",
      targetId: PAYER_ID,
    });
    // H2: the event is keyed on the SAME grant key as the ledger (ledger + spine agree).
    expect(emitted.idempotencyKey).toBe(`admin_action:credits_granted:${GRANT_KEY}`);
  });

  it("idempotent replay (applied:false) → NO event emitted, existing balance returned", async () => {
    m.actions.findPayerStatus.mockResolvedValue({ id: PAYER_ID, status: "active" });
    // The repo deduped on the key: no new ledger row, no balance move (applied:false).
    m.actions.grantCredits.mockResolvedValue({ ledgerId: LEDGER_ID, balance: 500, applied: false });

    const res = await m.service.grantCredits(
      ADMIN_ID,
      PAYER_ID,
      { amount: 500, reason_code: "goodwill", idempotency_key: GRANT_KEY },
      CTX,
    );

    expect(res).toEqual({ target_id: PAYER_ID, changed: false, ledger_id: LEDGER_ID, balance: 500 });
    expect(m.events.emit).not.toHaveBeenCalled(); // exactly-once: the replay emits nothing
  });

  it("unknown payer → 404, NO ledger write, NO event", async () => {
    m.actions.findPayerStatus.mockResolvedValue(undefined);
    await expect(
      m.service.grantCredits(
        ADMIN_ID,
        PAYER_ID,
        { amount: 10, reason_code: "promo", idempotency_key: GRANT_KEY },
        CTX,
      ),
    ).rejects.toThrow(NotFoundException);
    expect(m.actions.grantCredits).not.toHaveBeenCalled();
    expect(m.events.emit).not.toHaveBeenCalled();
  });

  /**
   * ADR-0037 — the seed finding.
   *
   * `grantCredits` opened with `const exists = await this.actions.findPayerStatus(payerId)`
   * and then consumed only `!exists`. `findPayerStatus` returns `{id, status}`, so the
   * status was SELECTED and thrown away — an admin could top up a suspended payer. The
   * whole suite covered only `active` and `undefined`; there was no suspended case at all,
   * which is why the gap survived. This test is that missing case.
   */
  it("ADR-0037: a SUSPENDED payer cannot be granted credits — no ledger write, no event", async () => {
    m.actions.findPayerStatus.mockResolvedValue({ id: PAYER_ID, status: "suspended" });
    await expect(
      m.service.grantCredits(
        ADMIN_ID,
        PAYER_ID,
        { amount: 10, reason_code: "promo", idempotency_key: GRANT_KEY },
        CTX,
      ),
    ).rejects.toThrow(ConflictException);
    expect(m.actions.grantCredits).not.toHaveBeenCalled();
    expect(m.events.emit).not.toHaveBeenCalled();
  });

  it("a PENDING payer CAN be granted credits (pre-provisioning is legitimate)", async () => {
    // Deliberately allowed: the credits are unspendable until the payer verifies, and
    // blocking this would break granting a signup bonus before first login.
    m.actions.findPayerStatus.mockResolvedValue({ id: PAYER_ID, status: "pending" });
    m.actions.grantCredits.mockResolvedValue({ applied: true, ledgerId: "l1", balance: 10 });

    await expect(
      m.service.grantCredits(
        ADMIN_ID,
        PAYER_ID,
        { amount: 10, reason_code: "promo", idempotency_key: GRANT_KEY },
        CTX,
      ),
    ).resolves.toMatchObject({ target_id: PAYER_ID });
    expect(m.actions.grantCredits).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// job_postings — force-close (terminal, idempotent)
// ---------------------------------------------------------------------------

describe("forceClosePosting", () => {
  it("open posting → closes SoR + emits ONE value-free posting_force_closed", async () => {
    m.actions.findPostingStatus.mockResolvedValue({ id: POSTING_ID, status: "open" });
    m.actions.forceClosePosting.mockResolvedValue({ id: POSTING_ID });

    const res = await m.service.forceClosePosting(ADMIN_ID, POSTING_ID, CTX);

    expect(m.actions.forceClosePosting).toHaveBeenCalledWith(POSTING_ID, expect.any(Date), FAKE_TX);
    expect(res).toEqual({ target_id: POSTING_ID, changed: true });
    assertValueFreeAction(soleEmit(m.events), {
      actionCode: "posting_force_closed",
      subjectType: "job_posting",
      targetId: POSTING_ID,
    });
  });

  it("already-closed posting → idempotent no-op success, NO SoR write, NO event", async () => {
    m.actions.findPostingStatus.mockResolvedValue({ id: POSTING_ID, status: "closed" });
    const res = await m.service.forceClosePosting(ADMIN_ID, POSTING_ID, CTX);
    expect(res).toEqual({ target_id: POSTING_ID, changed: false });
    expect(m.actions.forceClosePosting).not.toHaveBeenCalled();
    expect(m.events.emit).not.toHaveBeenCalled();
  });

  it("concurrent close race (SoR returns undefined) → no-op success, NO event", async () => {
    m.actions.findPostingStatus.mockResolvedValue({ id: POSTING_ID, status: "open" });
    m.actions.forceClosePosting.mockResolvedValue(undefined);
    const res = await m.service.forceClosePosting(ADMIN_ID, POSTING_ID, CTX);
    expect(res).toEqual({ target_id: POSTING_ID, changed: false });
    expect(m.events.emit).not.toHaveBeenCalled();
  });

  it("unknown posting → 404, NO event", async () => {
    m.actions.findPostingStatus.mockResolvedValue(undefined);
    await expect(m.service.forceClosePosting(ADMIN_ID, POSTING_ID, CTX)).rejects.toThrow(
      NotFoundException,
    );
    expect(m.events.emit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// worker_flags — flag / unflag (idempotent on the open-flag uniqueness)
// ---------------------------------------------------------------------------

describe("flagWorker", () => {
  it("first flag → opens the SoR row + emits ONE value-free worker_flagged (reason NOT in the event)", async () => {
    m.actions.openFlag.mockResolvedValue({ id: "flag-1" });

    const res = await m.service.flagWorker(ADMIN_ID, WORKER_ID, { reason_code: "abuse_report" }, CTX);

    // The reason CODE + the admin id go to the worker_flags ROW — NOT the event payload.
    expect(m.actions.openFlag).toHaveBeenCalledWith(WORKER_ID, "abuse_report", ADMIN_ID, FAKE_TX);
    expect(res).toEqual({ target_id: WORKER_ID, changed: true });
    assertValueFreeAction(soleEmit(m.events), {
      actionCode: "worker_flagged",
      subjectType: "worker",
      targetId: WORKER_ID,
    });
  });

  it("already-flagged (open flag exists) → idempotent no-op, NO event", async () => {
    m.actions.openFlag.mockResolvedValue(undefined); // ON CONFLICT DO NOTHING
    const res = await m.service.flagWorker(ADMIN_ID, WORKER_ID, { reason_code: "duplicate" }, CTX);
    expect(res).toEqual({ target_id: WORKER_ID, changed: false });
    expect(m.events.emit).not.toHaveBeenCalled();
  });
});

describe("unflagWorker", () => {
  it("open flag → resolves the SoR row + emits ONE value-free worker_unflagged", async () => {
    m.actions.resolveFlag.mockResolvedValue({ id: "flag-1" });

    const res = await m.service.unflagWorker(ADMIN_ID, WORKER_ID, CTX);

    expect(m.actions.resolveFlag).toHaveBeenCalledWith(WORKER_ID, ADMIN_ID, FAKE_TX);
    expect(res).toEqual({ target_id: WORKER_ID, changed: true });
    assertValueFreeAction(soleEmit(m.events), {
      actionCode: "worker_unflagged",
      subjectType: "worker",
      targetId: WORKER_ID,
    });
  });

  it("no open flag → idempotent no-op, NO event", async () => {
    m.actions.resolveFlag.mockResolvedValue(undefined);
    const res = await m.service.unflagWorker(ADMIN_ID, WORKER_ID, CTX);
    expect(res).toEqual({ target_id: WORKER_ID, changed: false });
    expect(m.events.emit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// admin_users — invite / change role / suspend (manage_admins)
// ---------------------------------------------------------------------------

describe("inviteAdmin", () => {
  it("creates the admin (pending) + emits ONE value-free admin_invited (email/role NOT in the event)", async () => {
    m.admins.create.mockResolvedValue({ id: TARGET_ADMIN_ID });

    const res = await m.service.inviteAdmin(
      ADMIN_ID,
      { email: "ops@badabhai.in", role: "ops_admin" },
      CTX,
    );

    // The email (PII) + role go to admin_users (encrypted) — NOT the event/response value-set.
    expect(m.admins.create).toHaveBeenCalledWith(
      { role: "ops_admin", email: "ops@badabhai.in" },
      FAKE_TX,
    );
    expect(res).toEqual({ admin_id: TARGET_ADMIN_ID });
    assertValueFreeAction(soleEmit(m.events), {
      actionCode: "admin_invited",
      subjectType: "admin_session",
      targetId: TARGET_ADMIN_ID,
    });
  });

  it("duplicate email (23505) → conflict, NO event", async () => {
    m.admins.create.mockRejectedValue(Object.assign(new Error("dup"), { code: "23505" }));
    await expect(
      m.service.inviteAdmin(ADMIN_ID, { email: "ops@badabhai.in", role: "analyst" }, CTX),
    ).rejects.toThrow(ConflictException);
    expect(m.events.emit).not.toHaveBeenCalled();
  });
});

describe("changeAdminRole", () => {
  it("known admin (different role) → updates role SoR + emits ONE value-free admin_role_changed", async () => {
    // Target is currently support → ops_admin is a real change (not a same-role no-op).
    m.admins.findById.mockResolvedValue({ id: TARGET_ADMIN_ID, role: "support", status: "active" });
    m.admins.updateRole.mockResolvedValue({ id: TARGET_ADMIN_ID, role: "ops_admin" });

    const res = await m.service.changeAdminRole(ADMIN_ID, TARGET_ADMIN_ID, { role: "ops_admin" }, CTX);

    expect(m.admins.updateRole).toHaveBeenCalledWith(TARGET_ADMIN_ID, "ops_admin", FAKE_TX);
    expect(res).toEqual({ target_id: TARGET_ADMIN_ID, changed: true });
    assertValueFreeAction(soleEmit(m.events), {
      actionCode: "admin_role_changed",
      subjectType: "admin_session",
      targetId: TARGET_ADMIN_ID,
    });
  });

  it("unknown admin → 404, NO event", async () => {
    m.admins.findById.mockResolvedValue(undefined);
    await expect(
      m.service.changeAdminRole(ADMIN_ID, TARGET_ADMIN_ID, { role: "support" }, CTX),
    ).rejects.toThrow(NotFoundException);
    expect(m.admins.updateRole).not.toHaveBeenCalled();
    expect(m.events.emit).not.toHaveBeenCalled();
  });

  // L2 — same-role X→X PATCH is a no-op (no row bump, no event).
  it("same-role PATCH (role X→X) → no-op success, NO SoR write, NO event", async () => {
    m.admins.findById.mockResolvedValue({ id: TARGET_ADMIN_ID, role: "ops_admin", status: "active" });
    const res = await m.service.changeAdminRole(ADMIN_ID, TARGET_ADMIN_ID, { role: "ops_admin" }, CTX);
    expect(res).toEqual({ target_id: TARGET_ADMIN_ID, changed: false });
    expect(m.admins.updateRole).not.toHaveBeenCalled();
    expect(m.events.emit).not.toHaveBeenCalled();
  });

  // L1 — self-demotion + last-super_admin lockout guards.
  it("demoting YOURSELF → 409 conflict, NO SoR write, NO event", async () => {
    m.admins.findById.mockResolvedValue({ id: ADMIN_ID, role: "super_admin", status: "active" });
    await expect(
      m.service.changeAdminRole(ADMIN_ID, ADMIN_ID, { role: "analyst" }, CTX),
    ).rejects.toThrow(ConflictException);
    expect(m.admins.updateRole).not.toHaveBeenCalled();
    expect(m.events.emit).not.toHaveBeenCalled();
  });

  it("demoting the LAST active super_admin → 409 conflict, NO SoR write, NO event", async () => {
    m.admins.findById.mockResolvedValue({ id: TARGET_ADMIN_ID, role: "super_admin", status: "active" });
    m.admins.countActiveSuperAdmins.mockResolvedValue(1); // the target is the only one
    await expect(
      m.service.changeAdminRole(ADMIN_ID, TARGET_ADMIN_ID, { role: "analyst" }, CTX),
    ).rejects.toThrow(ConflictException);
    expect(m.admins.updateRole).not.toHaveBeenCalled();
    expect(m.events.emit).not.toHaveBeenCalled();
  });

  it("demoting a super_admin when OTHERS remain (count > 1) → allowed", async () => {
    m.admins.findById.mockResolvedValue({ id: TARGET_ADMIN_ID, role: "super_admin", status: "active" });
    m.admins.countActiveSuperAdmins.mockResolvedValue(2);
    m.admins.updateRole.mockResolvedValue({ id: TARGET_ADMIN_ID, role: "analyst" });
    const res = await m.service.changeAdminRole(ADMIN_ID, TARGET_ADMIN_ID, { role: "analyst" }, CTX);
    expect(res).toEqual({ target_id: TARGET_ADMIN_ID, changed: true });
    expect(soleEmit(m.events).payload.action_code).toBe("admin_role_changed");
  });
});

describe("suspendAdmin", () => {
  it("active admin → suspends SoR + emits ONE value-free admin_suspended", async () => {
    m.admins.findById.mockResolvedValue({ id: TARGET_ADMIN_ID, role: "ops_admin", status: "active" });
    m.admins.suspend.mockResolvedValue({ id: TARGET_ADMIN_ID, status: "suspended" });

    const res = await m.service.suspendAdmin(ADMIN_ID, TARGET_ADMIN_ID, CTX);

    expect(m.admins.suspend).toHaveBeenCalledWith(TARGET_ADMIN_ID, FAKE_TX);
    expect(res).toEqual({ target_id: TARGET_ADMIN_ID, changed: true });
    assertValueFreeAction(soleEmit(m.events), {
      actionCode: "admin_suspended",
      subjectType: "admin_session",
      targetId: TARGET_ADMIN_ID,
    });
  });

  it("already-suspended admin → idempotent no-op, NO SoR write, NO event", async () => {
    m.admins.findById.mockResolvedValue({ id: TARGET_ADMIN_ID, role: "ops_admin", status: "suspended" });
    const res = await m.service.suspendAdmin(ADMIN_ID, TARGET_ADMIN_ID, CTX);
    expect(res).toEqual({ target_id: TARGET_ADMIN_ID, changed: false });
    expect(m.admins.suspend).not.toHaveBeenCalled();
    expect(m.events.emit).not.toHaveBeenCalled();
  });

  it("unknown admin → 404, NO event", async () => {
    m.admins.findById.mockResolvedValue(undefined);
    await expect(m.service.suspendAdmin(ADMIN_ID, TARGET_ADMIN_ID, CTX)).rejects.toThrow(
      NotFoundException,
    );
    expect(m.events.emit).not.toHaveBeenCalled();
  });

  // L1 — self-suspend + last-super_admin lockout guards.
  it("suspending YOURSELF → 409 conflict, NO SoR write, NO event", async () => {
    m.admins.findById.mockResolvedValue({ id: ADMIN_ID, role: "super_admin", status: "active" });
    await expect(m.service.suspendAdmin(ADMIN_ID, ADMIN_ID, CTX)).rejects.toThrow(ConflictException);
    expect(m.admins.suspend).not.toHaveBeenCalled();
    expect(m.events.emit).not.toHaveBeenCalled();
  });

  it("suspending the LAST active super_admin → 409 conflict, NO SoR write, NO event", async () => {
    m.admins.findById.mockResolvedValue({ id: TARGET_ADMIN_ID, role: "super_admin", status: "active" });
    m.admins.countActiveSuperAdmins.mockResolvedValue(1);
    await expect(m.service.suspendAdmin(ADMIN_ID, TARGET_ADMIN_ID, CTX)).rejects.toThrow(
      ConflictException,
    );
    expect(m.admins.suspend).not.toHaveBeenCalled();
    expect(m.events.emit).not.toHaveBeenCalled();
  });

  it("suspending a super_admin when OTHERS remain (count > 1) → allowed", async () => {
    m.admins.findById.mockResolvedValue({ id: TARGET_ADMIN_ID, role: "super_admin", status: "active" });
    m.admins.countActiveSuperAdmins.mockResolvedValue(2);
    m.admins.suspend.mockResolvedValue({ id: TARGET_ADMIN_ID, status: "suspended" });
    const res = await m.service.suspendAdmin(ADMIN_ID, TARGET_ADMIN_ID, CTX);
    expect(res).toEqual({ target_id: TARGET_ADMIN_ID, changed: true });
    expect(soleEmit(m.events).payload.action_code).toBe("admin_suspended");
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: the emit is the ONLY events touch, and is keyed for retry-safety.
// ---------------------------------------------------------------------------

describe("emit chokepoint — exactly one event, keyed, never update/delete(events)", () => {
  it("threads correlation/request ids + a stable idempotency key onto the emit", async () => {
    m.actions.findPayerStatus.mockResolvedValue({ id: PAYER_ID, status: "active" });
    m.actions.suspendPayer.mockResolvedValue({ status: "suspended" });

    await m.service.suspendPayer(ADMIN_ID, PAYER_ID, CTX);

    const emitted = m.events.emit.mock.calls[0]![0] as {
      correlationId: string;
      requestId: string;
      idempotencyKey: string;
    };
    expect(emitted.correlationId).toBe(CTX.correlationId);
    expect(emitted.requestId).toBe(CTX.requestId);
    // Keyed on action + actor + target + request → exactly-once under an at-least-once retry.
    expect(emitted.idempotencyKey).toBe(
      `admin_action:payer_suspended:${ADMIN_ID}:${PAYER_ID}:${CTX.requestId}`,
    );
  });
});
