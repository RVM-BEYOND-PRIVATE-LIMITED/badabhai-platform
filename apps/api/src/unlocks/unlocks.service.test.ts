import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import type { ServerConfig } from "@badabhai/config";
import type { RequestContext } from "../common/request-context";
import type { EventsService } from "../events/events.service";
import type { ConsentRepository } from "../consent/consent.repository";
import type { WorkersRepository } from "../workers/workers.repository";
import type { PiiCryptoService } from "../common/pii-crypto.service";
import type { PayerOrgsRepository } from "../payers/payer-orgs.repository";
import { UnlockService } from "./unlocks.service";
import type { UnlocksRepository } from "./unlocks.repository";
import { PaymentGateway } from "./payment-gateway";

const CTX = { correlationId: "corr-1", requestId: "req-1" } as RequestContext;
const PAYER = "11111111-1111-1111-1111-111111111111";
const WORKER = "22222222-2222-2222-2222-222222222222";
const SENTINEL_PHONE = "+919876500000"; // a value that must NEVER appear in events/response

// ADR-0027 B5.x Inc 2 — the tenancy flip. Each acting payer resolves to a STABLE org id
// via PayerOrgsRepository.resolveOrgForPayer. The default single-payer tests map PAYER→ORG,
// so ownership/wallet key on ORG while behavior is preserved (solo org == the one payer).
const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // PAYER's solo org
// Default payer→org map (multi-org / shared-org tests override it).
const DEFAULT_ORG_MAP: Record<string, string> = { [PAYER]: ORG };

const CAPS = {
  UNLOCK_MAX_REVEALS_PER_WORKER_PER_DAY: 5,
  UNLOCK_MAX_PAYERS_PER_WORKER_PER_WEEK: 10,
  UNLOCK_MAX_ATTEMPTS_PER_UNLOCK: 3,
  PAYMENTS_ENABLE_REAL: false,
} as unknown as ServerConfig;

interface SetupOpts {
  balance?: number;
  consentPurposes?: string[] | null; // null => no consent row
  consentRevoked?: boolean;
  workerExists?: boolean;
  existingUnlock?: Record<string, unknown>;
  reveals?: number; // countRevealsSince
  orgs?: number; // countDistinctOrgsSince (the weekly cap unit, ADR-0027 B5.x Inc 2)
  debitOk?: boolean;
  // ADR-0027 B5.x Inc 2: acting-payer → owning-org map (defaults to PAYER→ORG). A payer
  // ABSENT from the map resolves to null (the fail-closed no-org case).
  orgMap?: Record<string, string>;
  // The org id stamped onto the projection returned by getProjection (the reveal IDOR
  // gate compares it to the CALLER's resolved org). Defaults to ORG (owned by PAYER).
  projectionOrgId?: string;
}

function setup(opts: SetupOpts = {}) {
  const balance = opts.balance ?? 5;
  const consentPurposes = opts.consentPurposes === undefined ? ["employer_sharing"] : opts.consentPurposes;
  const workerExists = opts.workerExists ?? true;
  const orgMap = opts.orgMap ?? DEFAULT_ORG_MAP;
  const projectionOrgId = opts.projectionOrgId ?? ORG;

  const txMethods = {
    findByOrgWorker: vi.fn(async () => opts.existingUnlock),
    findByIdForUpdate: vi.fn(async () => opts.existingUnlock),
    lockWorker: vi.fn(async () => undefined),
    countRevealsSince: vi.fn(async () => opts.reveals ?? 0),
    countDistinctOrgsSince: vi.fn(async () => opts.orgs ?? 0),
    upsertGrant: vi.fn(async (_tx: unknown, input: Record<string, unknown>) => ({
      id: "unlock-1",
      ...input,
      status: "granted",
      revealCount: 0,
    })),
    recordDeny: vi.fn(async (_tx: unknown, input: Record<string, unknown>) => ({
      id: "unlock-deny-1",
      ...input,
      status: "denied",
    })),
    incrementReveal: vi.fn(async () => 1),
    createRouting: vi.fn(async () => ({ id: "routing-1" })),
    // Typed (_tx, input) so the org_id + payer_id stamping assertions can read calls[0][1].
    appendLedger: vi.fn(async (_tx: unknown, _input: Record<string, unknown>) => undefined),
    tryDebit: vi.fn(async () => ((opts.debitOk ?? true) ? balance - 1 : undefined)),
  };

  const repo = {
    withTransaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(txMethods)),
    getBalance: vi.fn(async () => balance),
    listByOrg: vi.fn(async () => []),
    // reveal() reads the projection (tx-external) BEFORE the lock to run the consent
    // gate; return a worker_id + org_id bearing projection whenever an unlock exists so
    // the pre-lock consent + ORG-ownership checks fire in the reveal tests.
    // worker_id is `string | null` post-ADR-0026 Phase 5 (DSAR SET NULL) — type the literal so
    // a test can mockResolvedValue a null-worker_id projection (the deleted-worker guard).
    getProjection: vi.fn(
      async (): Promise<{ worker_id: string | null; payer_id: string; org_id: string | null } | undefined> =>
        opts.existingUnlock ? { worker_id: WORKER, payer_id: PAYER, org_id: projectionOrgId } : undefined,
    ),
    ...txMethods,
  };

  const consents = {
    findLatestByWorker: vi.fn(async () =>
      consentPurposes === null
        ? undefined
        : { purposes: consentPurposes, revokedAt: opts.consentRevoked ? new Date() : null },
    ),
  };

  const workers = {
    findById: vi.fn(async () => (workerExists ? { id: WORKER, phoneE164: "ciphertext" } : undefined)),
  };

  const pii = { decrypt: vi.fn(() => SENTINEL_PHONE) };

  const events = { emit: vi.fn(async (p: Record<string, unknown>) => p) };

  // ADR-0027 B5.x Inc 2: the tenancy resolver. Maps each acting payer → its owning org (or
  // null when absent — the fail-closed no-org case). resolveOrgForPayer ONLY (the hot path
  // never calls ensureSoloOrg).
  const orgs = {
    resolveOrgForPayer: vi.fn(async (payerId: string) =>
      payerId in orgMap ? { orgId: orgMap[payerId], orgRole: "owner" } : null,
    ),
  };

  const payments = new PaymentGateway(repo as unknown as UnlocksRepository, CAPS);

  const svc = new UnlockService(
    repo as unknown as UnlocksRepository,
    consents as unknown as ConsentRepository,
    workers as unknown as WorkersRepository,
    pii as unknown as PiiCryptoService,
    payments,
    events as unknown as EventsService,
    orgs as unknown as PayerOrgsRepository,
    CAPS,
  );
  return { svc, repo, txMethods, consents, workers, pii, events, orgs };
}

function emitted(events: { emit: { mock: { calls: unknown[][] } } }): string[] {
  return events.emit.mock.calls.map((c) => (c[0] as { event_name: string }).event_name);
}

describe("UnlockService — F-1 (no consent oracle for a zero-credit payer)", () => {
  it("returns a BYTE-IDENTICAL neutral body for a consented-uncapped vs a non-consented worker", async () => {
    // Consented + uncapped worker, but zero credits.
    const a = setup({ balance: 0, consentPurposes: ["employer_sharing"] });
    const outConsented = await a.svc.requestUnlock({ payerId: PAYER, workerId: WORKER, jobId: null }, CTX);

    // Non-consented worker, zero credits.
    const b = setup({ balance: 0, consentPurposes: null });
    const outNoConsent = await b.svc.requestUnlock({ payerId: PAYER, workerId: WORKER, jobId: null }, CTX);

    expect(outConsented).toEqual({ status: "unavailable" });
    expect(outNoConsent).toEqual({ status: "unavailable" });
    // Byte-identical serialization (the no-oracle guarantee).
    expect(JSON.stringify(outConsented)).toBe(JSON.stringify(outNoConsent));

    // Worker state was NOT consulted on the zero-credit path (no consent/cap read).
    expect(a.consents.findLatestByWorker).not.toHaveBeenCalled();
    expect(a.repo.withTransaction).not.toHaveBeenCalled();
    expect(b.consents.findLatestByWorker).not.toHaveBeenCalled();
    // No debit, no grant.
    expect(a.txMethods.tryDebit).not.toHaveBeenCalled();
  });
});

describe("UnlockService — F-3 (every deny branch returns the identical neutral body)", () => {
  it("no_consent, capped, unknown_worker, already-owned-by-another all return the same body", async () => {
    const bodies: string[] = [];

    // no_consent (worker exists, has credits, but no employer_sharing consent)
    const noConsent = setup({ balance: 5, consentPurposes: ["profiling"] });
    bodies.push(
      JSON.stringify(await noConsent.svc.requestUnlock({ payerId: PAYER, workerId: WORKER, jobId: null }, CTX)),
    );

    // capped (consented but over daily reveals cap)
    const capped = setup({ balance: 5, consentPurposes: ["employer_sharing"], reveals: 5 });
    bodies.push(
      JSON.stringify(await capped.svc.requestUnlock({ payerId: PAYER, workerId: WORKER, jobId: null }, CTX)),
    );

    // unknown_worker (no worker row, no consent)
    const unknown = setup({ balance: 5, consentPurposes: null, workerExists: false });
    bodies.push(
      JSON.stringify(await unknown.svc.requestUnlock({ payerId: PAYER, workerId: WORKER, jobId: null }, CTX)),
    );

    // already-owned-by-another: a live grant exists for a DIFFERENT payer would, for THIS
    // payer, simply have no existing row → falls to consent/caps; modelled here as no row,
    // consent absent → neutral. (A second payer cannot tell the worker is unlockable.)
    const ownedByOther = setup({ balance: 5, consentPurposes: null });
    bodies.push(
      JSON.stringify(await ownedByOther.svc.requestUnlock({ payerId: PAYER, workerId: WORKER, jobId: null }, CTX)),
    );

    // All four bodies identical.
    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).toBe(JSON.stringify({ status: "unavailable" }));
  });

  it("reveal returns the neutral body (not a 404) for an unknown/expired/revoked unlock", async () => {
    const unknown = setup({ existingUnlock: undefined });
    expect(await unknown.svc.reveal("33333333-3333-3333-3333-333333333333", CTX)).toEqual({
      status: "unavailable",
    });

    const expired = setup({
      existingUnlock: {
        id: "unlock-1",
        payerId: PAYER,
        workerId: WORKER,
        status: "granted",
        routingTokenRef: "44444444-4444-4444-4444-444444444444",
        revealCount: 0,
        expiresAt: new Date(Date.now() - 1000), // expired
      },
    });
    expect(await expired.svc.reveal("unlock-1", CTX)).toEqual({ status: "unavailable" });
  });
});

describe("UnlockService — consent gate", () => {
  it("a worker with profiling but NOT employer_sharing is denied (neutral) + emits internal unlock.denied", async () => {
    const { svc, events, txMethods } = setup({ consentPurposes: ["profiling", "resume_generation"] });
    const out = await svc.requestUnlock({ payerId: PAYER, workerId: WORKER, jobId: null }, CTX);
    expect(out).toEqual({ status: "unavailable" });
    expect(emitted(events)).toContain("unlock.denied");
    const deny = events.emit.mock.calls.find((c) => (c[0] as { event_name: string }).event_name === "unlock.denied");
    expect((deny![0] as { payload: { reason: string } }).payload.reason).toBe("no_consent");
    // No debit, no reveal.
    expect(txMethods.tryDebit).not.toHaveBeenCalled();
    expect(txMethods.createRouting).not.toHaveBeenCalled();
  });

  it("a revoked employer_sharing consent fails closed (neutral)", async () => {
    const { svc } = setup({ consentPurposes: ["employer_sharing"], consentRevoked: true });
    expect(await svc.requestUnlock({ payerId: PAYER, workerId: WORKER, jobId: null }, CTX)).toEqual({
      status: "unavailable",
    });
  });

  it("an UNKNOWN worker returns neutral WITHOUT an FK-constrained insert (F-A no-oracle)", async () => {
    // Regression for the F-A finding: the old code called recordDeny for a non-existent
    // worker, which violates the unlocks.worker_id FK → 500 → a worker-enumeration oracle
    // distinguishable from the 200 neutral body. recordDeny must NOT be called; the audit
    // event is emitted row-less (unlock_id null, subject = worker).
    const { svc, events, txMethods } = setup({ balance: 5, consentPurposes: null, workerExists: false });
    const out = await svc.requestUnlock({ payerId: PAYER, workerId: WORKER, jobId: null }, CTX);
    expect(out).toEqual({ status: "unavailable" });
    expect(txMethods.recordDeny, "no unlocks row for an unknown worker (FK would 500)").not.toHaveBeenCalled();
    const deny = events.emit.mock.calls.find(
      (c) => (c[0] as { event_name: string }).event_name === "unlock.denied",
    );
    expect(deny, "unlock.denied must still be emitted for the audit spine").toBeDefined();
    const ev = deny![0] as {
      payload: { reason: string; unlock_id: string | null };
      subject: { subject_type: string };
    };
    expect(ev.payload.reason).toBe("unknown_worker");
    expect(ev.payload.unlock_id).toBeNull();
    expect(ev.subject.subject_type).toBe("worker");
  });
});

describe("UnlockService — caps (F-2: payment NOT attempted when capped)", () => {
  it("daily reveals cap → cap_exceeded emitted, NO debit, neutral body", async () => {
    const { svc, events, txMethods } = setup({ consentPurposes: ["employer_sharing"], reveals: 5 });
    const out = await svc.requestUnlock({ payerId: PAYER, workerId: WORKER, jobId: null }, CTX);
    expect(out).toEqual({ status: "unavailable" });
    expect(emitted(events)).toContain("unlock.cap_exceeded");
    expect(txMethods.tryDebit).not.toHaveBeenCalled(); // caps precede payment ([2] before [3])
  });
});

describe("UnlockService — happy path (apply→grant) emits the right PII-free events", () => {
  it("emits requested → payment.authorized → payment.captured → granted, debits once, grants once", async () => {
    const { svc, events, txMethods } = setup({ balance: 5, consentPurposes: ["employer_sharing"] });
    const out = await svc.requestUnlock({ payerId: PAYER, workerId: WORKER, jobId: null }, CTX);
    expect(out).toMatchObject({ ok: true, unlock_id: "unlock-1", status: "granted" });
    expect((out as { expires_at: string }).expires_at).toMatch(/Z$/);

    const names = emitted(events);
    expect(names).toEqual([
      "unlock.requested",
      "payment.authorized",
      "payment.captured",
      "unlock.granted",
    ]);
    expect(txMethods.tryDebit).toHaveBeenCalledTimes(1);
    expect(txMethods.upsertGrant).toHaveBeenCalledTimes(1);
    expect(txMethods.appendLedger).toHaveBeenCalledTimes(1);

    // Every payment.* event carries real_call:false (mock honesty, F-6).
    for (const c of events.emit.mock.calls) {
      const e = c[0] as { event_name: string; payload: Record<string, unknown> };
      if (e.event_name.startsWith("payment.")) expect(e.payload.real_call).toBe(false);
    }
  });

  it("an already-live grant for THIS payer returns the SAME grant with no second debit (idempotent, F-6)", async () => {
    const { svc, txMethods, events } = setup({
      balance: 5,
      consentPurposes: ["employer_sharing"],
      existingUnlock: {
        id: "unlock-1",
        payerId: PAYER,
        workerId: WORKER,
        status: "granted",
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const out = await svc.requestUnlock({ payerId: PAYER, workerId: WORKER, jobId: null }, CTX);
    expect(out).toMatchObject({ ok: true, unlock_id: "unlock-1", status: "granted" });
    expect(txMethods.tryDebit).not.toHaveBeenCalled(); // no second debit
    expect(txMethods.upsertGrant).not.toHaveBeenCalled();
    // Only the entry unlock.requested event (no second grant/payment events).
    expect(emitted(events)).toEqual(["unlock.requested"]);
  });
});

describe("UnlockService — F-6 (insufficient credits → neutral, payment.failed, no grant)", () => {
  it("a zero-balance payer never grants and emits payment.failed (insufficient_credits)", async () => {
    const { svc, events, txMethods } = setup({ balance: 0 });
    const out = await svc.requestUnlock({ payerId: PAYER, workerId: WORKER, jobId: null }, CTX);
    expect(out).toEqual({ status: "unavailable" });
    const names = emitted(events);
    expect(names).toContain("payment.failed");
    expect(names).not.toContain("unlock.granted");
    expect(txMethods.upsertGrant).not.toHaveBeenCalled();
    const failed = events.emit.mock.calls.find((c) => (c[0] as { event_name: string }).event_name === "payment.failed");
    expect((failed![0] as { payload: { real_call: boolean } }).payload.real_call).toBe(false);
  });
});

describe("UnlockService — reveal (F-5: sentinel phone never leaks)", () => {
  function grantedUnlock() {
    return {
      id: "unlock-1",
      payerId: PAYER,
      workerId: WORKER,
      status: "granted",
      routingTokenRef: "44444444-4444-4444-4444-444444444444",
      revealCount: 0,
      expiresAt: new Date(Date.now() + 60_000),
    };
  }

  it("a happy reveal returns an opaque relay handle (NOT the phone) and emits contact.revealed (channel KIND only)", async () => {
    const { svc, events, pii } = setup({
      consentPurposes: ["employer_sharing"],
      existingUnlock: grantedUnlock(),
    });
    const out = await svc.reveal("unlock-1", CTX);
    expect(out).toMatchObject({ channel: "in_app_relay" });
    const handle = (out as { relay_handle: string }).relay_handle;
    expect(handle).toMatch(/^relay_/);
    // The decrypt happened (the only site) but the phone is NOWHERE in the response.
    expect(pii.decrypt).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(out)).not.toContain(SENTINEL_PHONE);

    // contact.revealed carries channel KIND + counts only — never the number/handle.
    const revealed = events.emit.mock.calls.find(
      (c) => (c[0] as { event_name: string }).event_name === "contact.revealed",
    );
    const payload = (revealed![0] as { payload: Record<string, unknown> }).payload;
    expect(Object.keys(payload).sort()).toEqual(
      ["channel", "payer_id", "reveal_count", "unlock_id", "worker_id"].sort(),
    );
    expect(JSON.stringify(payload)).not.toContain(SENTINEL_PHONE);
    expect(JSON.stringify(payload)).not.toContain(handle); // the handle is not evented either
  });

  it("the routing token is NEVER in the response or the contact.revealed event (F-4)", async () => {
    const u = grantedUnlock();
    const { svc, events } = setup({ consentPurposes: ["employer_sharing"], existingUnlock: u });
    const out = await svc.reveal("unlock-1", CTX);
    const serializedEvents = JSON.stringify(events.emit.mock.calls.map((c) => c[0]));
    expect(JSON.stringify(out)).not.toContain(u.routingTokenRef);
    expect(serializedEvents).not.toContain(u.routingTokenRef);
  });

  it("a provider/relay error carrying the phone never reaches the response or logs (fail closed → neutral)", async () => {
    const { svc, pii } = setup({ consentPurposes: ["employer_sharing"], existingUnlock: grantedUnlock() });
    // Make decrypt throw WITH the sentinel phone in the message.
    pii.decrypt.mockImplementationOnce(() => {
      throw new Error(`provider failed for ${SENTINEL_PHONE}`);
    });
    const out = await svc.reveal("unlock-1", CTX);
    expect(out).toEqual({ status: "unavailable" }); // fail closed, neutral
    expect(JSON.stringify(out)).not.toContain(SENTINEL_PHONE);
  });

  it("reveal after revocation fails closed (neutral), no channel resolved", async () => {
    const { svc, txMethods } = setup({
      consentPurposes: ["employer_sharing"],
      consentRevoked: true,
      existingUnlock: grantedUnlock(),
    });
    expect(await svc.reveal("unlock-1", CTX)).toEqual({ status: "unavailable" });
    expect(txMethods.createRouting).not.toHaveBeenCalled();
  });

  it("reveal over the per-unlock attempt cap → cap_exceeded, neutral, no new routing", async () => {
    const { svc, events, txMethods } = setup({
      consentPurposes: ["employer_sharing"],
      existingUnlock: { ...grantedUnlock(), revealCount: 3 }, // == UNLOCK_MAX_ATTEMPTS_PER_UNLOCK
    });
    expect(await svc.reveal("unlock-1", CTX)).toEqual({ status: "unavailable" });
    expect(emitted(events)).toContain("unlock.cap_exceeded");
    expect(txMethods.createRouting).not.toHaveBeenCalled();
  });

  // ---- ADR-0026 Phase 5: a hard-deleted worker SET-NULLs unlocks.worker_id ----

  it("reveal on a NULL worker_id (worker deleted, DSAR SET NULL) returns the neutral body, no crash, no oracle", async () => {
    // The paid-grant row survives the worker hard-delete with worker_id nulled. A reveal must
    // NOT relay to a gone worker — it returns the IDENTICAL neutral body, never an error/404,
    // and never passes null into the consent check or the worker lock.
    const { svc, txMethods, consents, pii } = setup({
      consentPurposes: ["employer_sharing"],
      existingUnlock: { ...grantedUnlock(), workerId: null },
    });
    // The pre-lock projection reports a null worker_id (the SET-NULL result).
    txMethods.findByIdForUpdate.mockResolvedValue({ ...grantedUnlock(), workerId: null });
    (svc as unknown as { repo: { getProjection: ReturnType<typeof vi.fn> } }).repo.getProjection =
      vi.fn(async () => ({ worker_id: null, payer_id: PAYER, org_id: ORG }));

    const out = await svc.reveal("unlock-1", CTX);
    expect(out).toEqual({ status: "unavailable" }); // byte-identical neutral
    // The null worker_id is guarded BEFORE consent / lock / relay — none of these fire.
    expect(consents.findLatestByWorker).not.toHaveBeenCalled();
    expect(txMethods.lockWorker).not.toHaveBeenCalled();
    expect(txMethods.createRouting).not.toHaveBeenCalled();
    expect(pii.decrypt).not.toHaveBeenCalled(); // the phone is never decrypted for a gone worker
  });

  it("the pre-lock projection guard catches a NULL worker_id before the tx even opens (no oracle)", async () => {
    // Even if the projection (the tx-external pre-lock read) reports a null worker_id, the
    // reveal short-circuits to neutral WITHOUT opening the transaction — the strongest
    // no-oracle posture for a DSAR-erased worker.
    const { svc, repo, txMethods } = setup({
      existingUnlock: { ...grantedUnlock(), workerId: null },
    });
    repo.getProjection.mockResolvedValue({ worker_id: null, payer_id: PAYER, org_id: ORG });
    const out = await svc.reveal("unlock-1", CTX);
    expect(out).toEqual({ status: "unavailable" });
    expect(repo.withTransaction).not.toHaveBeenCalled(); // never opened the tx
    expect(txMethods.findByIdForUpdate).not.toHaveBeenCalled();
  });
});

describe("UnlockService — no PII anywhere in emitted events", () => {
  it("a full grant + reveal flow never serializes the sentinel phone into any event", async () => {
    const { svc, events } = setup({
      balance: 5,
      consentPurposes: ["employer_sharing"],
    });
    await svc.requestUnlock({ payerId: PAYER, workerId: WORKER, jobId: null }, CTX);

    const r = setup({
      consentPurposes: ["employer_sharing"],
      existingUnlock: {
        id: "unlock-1",
        payerId: PAYER,
        workerId: WORKER,
        status: "granted",
        routingTokenRef: "44444444-4444-4444-4444-444444444444",
        revealCount: 0,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await r.svc.reveal("unlock-1", CTX);

    const allEvents = JSON.stringify([
      ...events.emit.mock.calls.map((c) => c[0]),
      ...r.events.emit.mock.calls.map((c) => c[0]),
    ]);
    for (const k of ["phone", "phone_e164", "full_name", "relay_handle", SENTINEL_PHONE]) {
      expect(allEvents).not.toContain(k);
    }
  });
});

describe("UnlockService — reveal ownership (XB-A: payer-self path, ADR-0019 → ORG, ADR-0027 B5.x Inc 2)", () => {
  const OWNER = PAYER; // resolves to ORG via DEFAULT_ORG_MAP
  // A payer in a DIFFERENT org (mapped to ORG_B). The unlock's org_id (ORG) != caller's org.
  const OTHER_PAYER = "99999999-9999-4999-8999-999999999999";
  const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

  function grantedOwnedByOwner() {
    return {
      id: "unlock-1",
      payerId: OWNER,
      orgId: ORG,
      workerId: WORKER,
      status: "granted",
      routingTokenRef: "44444444-4444-4444-4444-444444444444",
      revealCount: 0,
      expiresAt: new Date(Date.now() + 60_000),
    };
  }

  it("a payer in ANOTHER org revealing the org's unlock gets the IDENTICAL neutral body (no 403, no routing, no contact.revealed)", async () => {
    // OTHER_PAYER resolves to ORG_B; the unlock's org_id is ORG → foreign-org → neutral.
    const r = setup({
      consentPurposes: ["employer_sharing"],
      existingUnlock: grantedOwnedByOwner(),
      orgMap: { [PAYER]: ORG, [OTHER_PAYER]: ORG_B },
    });
    // The projection (pre-lock read) reports the TRUE owning org (ORG); the caller is in ORG_B.
    r.repo.getProjection.mockResolvedValue({ worker_id: WORKER, payer_id: OWNER, org_id: ORG });
    const out = await r.svc.reveal("unlock-1", CTX, OTHER_PAYER);
    expect(out).toEqual({ status: "unavailable" }); // byte-identical neutral (no-oracle)
    expect(r.txMethods.createRouting).not.toHaveBeenCalled();
    expect(emitted(r.events)).not.toContain("contact.revealed");
  });

  it("the OWNER revealing their OWN org's unlock succeeds (caller org == unlock org)", async () => {
    const r = setup({ consentPurposes: ["employer_sharing"], existingUnlock: grantedOwnedByOwner() });
    r.repo.getProjection.mockResolvedValue({ worker_id: WORKER, payer_id: OWNER, org_id: ORG });
    const out = await r.svc.reveal("unlock-1", CTX, OWNER);
    expect(out).toMatchObject({ channel: "in_app_relay" });
    expect(emitted(r.events)).toContain("contact.revealed");
  });

  it("an unknown unlock returns neutral for a payer too (no existence oracle) and never reaches the tx", async () => {
    // OTHER_PAYER RESOLVES to an org (ORG_B) so the null projection — not the no-org fail-
    // closed — is what drives the neutral body (genuinely exercising the unknown-unlock path).
    const r = setup({ existingUnlock: undefined, orgMap: { [PAYER]: ORG, [OTHER_PAYER]: ORG_B } });
    const out = await r.svc.reveal("33333333-3333-4333-8333-333333333333", CTX, OTHER_PAYER);
    expect(out).toEqual({ status: "unavailable" });
    expect(r.txMethods.createRouting).not.toHaveBeenCalled();
  });

  it("OPS reveal (no expectedPayerId) is UNAFFECTED by the ownership gate (backward-compat)", async () => {
    const r = setup({ consentPurposes: ["employer_sharing"], existingUnlock: grantedOwnedByOwner() });
    r.repo.getProjection.mockResolvedValue({ worker_id: WORKER, payer_id: OWNER, org_id: ORG });
    const out = await r.svc.reveal("unlock-1", CTX); // ops path — no expectedPayerId
    expect(out).toMatchObject({ channel: "in_app_relay" });
    // Ops path never resolves a caller org (expectedPayerId is undefined).
    expect(r.orgs.resolveOrgForPayer).not.toHaveBeenCalled();
    expect(emitted(r.events)).toContain("contact.revealed");
  });
});

// ===========================================================================
// ADR-0027 B5.x Inc 2 — the payer_id→org_id tenancy flip
// ===========================================================================

const PAYER_A2 = "aaaaaaa2-aaa2-4aa2-8aa2-aaaaaaaaaaa2"; // a SECOND payer in PAYER's org (ORG)
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PAYER_B = "bbbbbbb1-bbb1-4bb1-8bb1-bbbbbbbbbbb1"; // a payer in ORG_B

function grantedOwnedBy(orgId: string) {
  return {
    id: "unlock-1",
    payerId: PAYER,
    orgId,
    workerId: WORKER,
    status: "granted",
    routingTokenRef: "44444444-4444-4444-4444-444444444444",
    revealCount: 0,
    expiresAt: new Date(Date.now() + 60_000),
  };
}

describe("UnlockService — cross-org IDOR (reveal keys ownership on ORG, no leak, no-oracle)", () => {
  it("payerB (orgB) revealing payerA's (orgA) unlock gets the IDENTICAL neutral body, no data leak", async () => {
    const r = setup({
      consentPurposes: ["employer_sharing"],
      existingUnlock: grantedOwnedBy(ORG), // owned by ORG (payer A's org)
      orgMap: { [PAYER]: ORG, [PAYER_B]: ORG_B },
    });
    r.repo.getProjection.mockResolvedValue({ worker_id: WORKER, payer_id: PAYER, org_id: ORG });
    const out = await r.svc.reveal("unlock-1", CTX, PAYER_B); // caller is in ORG_B
    expect(out).toEqual({ status: "unavailable" }); // no 403, byte-identical neutral
    // No decrypt, no routing, no contact.revealed — nothing about ORG's unlock leaks.
    expect(r.pii.decrypt).not.toHaveBeenCalled();
    expect(r.txMethods.createRouting).not.toHaveBeenCalled();
    expect(emitted(r.events)).not.toContain("contact.revealed");
    // The IDOR gate short-circuits BEFORE the tx opens.
    expect(r.repo.withTransaction).not.toHaveBeenCalled();
  });

  it("the foreign-org neutral body is BYTE-IDENTICAL to the unknown-unlock neutral body (no-oracle)", async () => {
    const foreign = setup({
      consentPurposes: ["employer_sharing"],
      existingUnlock: grantedOwnedBy(ORG),
      orgMap: { [PAYER]: ORG, [PAYER_B]: ORG_B },
    });
    foreign.repo.getProjection.mockResolvedValue({ worker_id: WORKER, payer_id: PAYER, org_id: ORG });
    const foreignBody = await foreign.svc.reveal("unlock-1", CTX, PAYER_B);

    const unknown = setup({ existingUnlock: undefined, orgMap: { [PAYER_B]: ORG_B } });
    const unknownBody = await unknown.svc.reveal("33333333-3333-4333-8333-333333333333", CTX, PAYER_B);

    expect(JSON.stringify(foreignBody)).toBe(JSON.stringify(unknownBody));
  });
});

describe("UnlockService — shared-org (two payers, one org: shared ownership + shared wallet)", () => {
  it("payerA2 can reveal an unlock owned by payerA's org (same org == shared ownership)", async () => {
    // PAYER and PAYER_A2 both resolve to ORG.
    const r = setup({
      consentPurposes: ["employer_sharing"],
      existingUnlock: grantedOwnedBy(ORG),
      orgMap: { [PAYER]: ORG, [PAYER_A2]: ORG },
    });
    r.repo.getProjection.mockResolvedValue({ worker_id: WORKER, payer_id: PAYER, org_id: ORG });
    const out = await r.svc.reveal("unlock-1", CTX, PAYER_A2); // teammate reveals A's unlock
    expect(out).toMatchObject({ channel: "in_app_relay" });
    expect(emitted(r.events)).toContain("contact.revealed");
  });

  it("a top-up by payerA then an unlock by payerA2 draw the SAME org wallet (org_id)", async () => {
    // Top-up: payerA buys a pack → credits ORG's wallet (org_id=ORG stamped on creditPack).
    const topUp = setup({ orgMap: { [PAYER]: ORG } });
    // Spy on the underlying repo.creditPack (PaymentGateway.purchasePackMock delegates to it).
    (topUp.repo as unknown as { creditPack: ReturnType<typeof vi.fn> }).creditPack = vi.fn(
      async () => 12,
    );
    const bought = await topUp.svc.purchaseCredits(PAYER, "pack_10", CTX);
    expect(bought).not.toBeNull();
    const creditArgs = (topUp.repo as unknown as { creditPack: ReturnType<typeof vi.fn> }).creditPack
      .mock.calls[0]![0] as { orgId: string; payerId: string };
    expect(creditArgs.orgId).toBe(ORG); // credited the ORG wallet
    expect(creditArgs.payerId).toBe(PAYER); // acting payer still stamped

    // Unlock by payerA2 (same org) → getBalance + debit key on ORG, not the acting payer.
    const spend = setup({ consentPurposes: ["employer_sharing"], orgMap: { [PAYER_A2]: ORG } });
    await spend.svc.requestUnlock({ payerId: PAYER_A2, workerId: WORKER, jobId: null }, CTX);
    expect(spend.repo.getBalance).toHaveBeenCalledWith(ORG); // balance read on the ORG wallet
    expect(spend.txMethods.tryDebit).toHaveBeenCalledWith(expect.anything(), ORG, 1); // debit ORG wallet
    // The grant + ledger stamp the ORG (ownership) AND the acting payer A2.
    const grantArg = spend.txMethods.upsertGrant.mock.calls[0]![1] as { orgId: string; payerId: string };
    expect(grantArg).toMatchObject({ orgId: ORG, payerId: PAYER_A2 });
    const ledgerArg = spend.txMethods.appendLedger.mock.calls[0]![1] as { orgId: string; payerId: string };
    expect(ledgerArg).toMatchObject({ orgId: ORG, payerId: PAYER_A2 });
  });
});

describe("UnlockService — weekly cap counts DISTINCT ORGS (behavior-preserving under solo orgs)", () => {
  it("the weekly cap reads countDistinctOrgsSince and denies with the UNCHANGED weekly_payers kind", async () => {
    // countDistinctOrgsSince at the cap → capped. The KIND string stays weekly_payers.
    const r = setup({ consentPurposes: ["employer_sharing"], orgs: 10 }); // == UNLOCK_MAX_PAYERS_PER_WORKER_PER_WEEK
    const out = await r.svc.requestUnlock({ payerId: PAYER, workerId: WORKER, jobId: null }, CTX);
    expect(out).toEqual({ status: "unavailable" });
    expect(r.txMethods.countDistinctOrgsSince).toHaveBeenCalled();
    const cap = r.events.emit.mock.calls.find(
      (c) => (c[0] as { event_name: string }).event_name === "unlock.cap_exceeded",
    );
    expect(cap).toBeDefined();
    // The counted unit changed (payer→org) but the payload KIND string is UNCHANGED.
    expect((cap![0] as { payload: { cap: string; window: string } }).payload.cap).toBe("weekly_payers");
    expect((cap![0] as { payload: { window: string } }).payload.window).toBe("week");
    expect(r.txMethods.tryDebit).not.toHaveBeenCalled(); // caps precede payment
  });

  it("N distinct payers in the SAME org count as ONE org (under the cap → granted)", async () => {
    // The repo count is what the DB returns (distinct org_id). Modelled as 1 for a single-org
    // team of many payers → below the cap → the request proceeds to a grant.
    const r = setup({ consentPurposes: ["employer_sharing"], orgs: 1 });
    const out = await r.svc.requestUnlock({ payerId: PAYER, workerId: WORKER, jobId: null }, CTX);
    expect(out).toMatchObject({ ok: true, status: "granted" });
    expect(r.txMethods.tryDebit).toHaveBeenCalledTimes(1);
  });
});

describe("UnlockService — fail-closed when the acting payer has NO resolvable org", () => {
  it("requestUnlock with an unresolvable org returns neutral, never opens the tx, never reads balance", async () => {
    // PAYER absent from the org map → resolveOrgForPayer returns null.
    const r = setup({ orgMap: {} });
    const out = await r.svc.requestUnlock({ payerId: PAYER, workerId: WORKER, jobId: null }, CTX);
    expect(out).toEqual({ status: "unavailable" }); // byte-identical neutral, no distinguishable error
    expect(r.repo.getBalance).not.toHaveBeenCalled(); // org resolved BEFORE the balance read
    expect(r.repo.withTransaction).not.toHaveBeenCalled();
    expect(r.txMethods.tryDebit).not.toHaveBeenCalled();
  });

  it("reveal with an unresolvable caller org fails closed to the IDENTICAL neutral body", async () => {
    const r = setup({
      consentPurposes: ["employer_sharing"],
      existingUnlock: grantedOwnedBy(ORG),
      orgMap: {}, // the caller resolves to null
    });
    r.repo.getProjection.mockResolvedValue({ worker_id: WORKER, payer_id: PAYER, org_id: ORG });
    const out = await r.svc.reveal("unlock-1", CTX, PAYER);
    expect(out).toEqual({ status: "unavailable" });
    expect(r.repo.withTransaction).not.toHaveBeenCalled();
    expect(r.pii.decrypt).not.toHaveBeenCalled();
  });

  it("getCredits with an unresolvable org returns balance 0 (fail-closed read, keeps payer_id field)", async () => {
    const r = setup({ orgMap: {} });
    const out = await r.svc.getCredits(PAYER);
    expect(out).toEqual({ payer_id: PAYER, balance: 0 });
    expect(r.repo.getBalance).not.toHaveBeenCalled();
  });

  it("listByPayer with an unresolvable org returns an empty list (fail-closed read)", async () => {
    const r = setup({ orgMap: {} });
    const out = await r.svc.listByPayer(PAYER);
    expect(out).toEqual({ unlocks: [] });
    expect(r.repo.listByOrg).not.toHaveBeenCalled();
  });

  it("purchaseCredits with an unresolvable org returns null (→404) and never credits", async () => {
    const r = setup({ orgMap: {} });
    (r.repo as unknown as { creditPack: ReturnType<typeof vi.fn> }).creditPack = vi.fn(async () => 0);
    const out = await r.svc.purchaseCredits(PAYER, "pack_10", CTX); // a KNOWN pack
    expect(out).toBeNull(); // fail-closed, not because the pack is unknown
    expect(
      (r.repo as unknown as { creditPack: ReturnType<typeof vi.fn> }).creditPack,
    ).not.toHaveBeenCalled();
  });
});

describe("UnlockService — NOT-NULL stamping (grant/deny/wallet/ledger carry org_id + payer_id)", () => {
  it("a grant stamps BOTH org_id (ownership) and payer_id (acting)", async () => {
    const r = setup({ consentPurposes: ["employer_sharing"] });
    await r.svc.requestUnlock({ payerId: PAYER, workerId: WORKER, jobId: null }, CTX);
    const grant = r.txMethods.upsertGrant.mock.calls[0]![1] as Record<string, unknown>;
    expect(grant.orgId).toBe(ORG);
    expect(grant.payerId).toBe(PAYER);
    const ledger = r.txMethods.appendLedger.mock.calls[0]![1] as Record<string, unknown>;
    expect(ledger.orgId).toBe(ORG);
    expect(ledger.payerId).toBe(PAYER);
  });

  it("a deny stamps BOTH org_id and payer_id (no_consent branch)", async () => {
    const r = setup({ consentPurposes: ["profiling"] }); // consented for profiling, NOT employer_sharing
    await r.svc.requestUnlock({ payerId: PAYER, workerId: WORKER, jobId: null }, CTX);
    const deny = r.txMethods.recordDeny.mock.calls[0]![1] as Record<string, unknown>;
    expect(deny.orgId).toBe(ORG);
    expect(deny.payerId).toBe(PAYER);
  });
});
