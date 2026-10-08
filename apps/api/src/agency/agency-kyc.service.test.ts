import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { ConflictException } from "@nestjs/common";
import { DrizzleQueryError } from "drizzle-orm";
import type { ServerConfig } from "@badabhai/config";
import type { AgencyKyc } from "@badabhai/db";
import type { PayersRepository } from "../payers/payers.repository";
import {
  defaultModeResolver,
  ownScope,
  ownTenantKey,
  resolverOver,
} from "../payers/payer-tenant-scope.test-support";
import { AgencyKycService } from "./agency-kyc.service";
import { AgencyKycRepository, type AgencyKycCiphertext } from "./agency-kyc.repository";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { EventsService } from "../events/events.service";

const AGENCY = "11111111-1111-4111-8111-111111111111";
const PAN = "ABCDE1234F";
const BANK = "123456789012";
const IFSC = "HDFC0001234";
const HOLDER = "Acme Staffing Pvt Ltd";

// Real crypto with deterministic test secrets (mirrors payers.repository.test.ts).
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");
const pii = new PiiCryptoService({
  PII_HASH_PEPPER: "test-pepper",
  PII_ENCRYPTION_KEY: TEST_KEY,
} as unknown as ServerConfig);

/** A failed query as drizzle 0.45 throws it — the driver's SQLSTATE rides on `cause`. */
function queryError(sqlstate: string): Error {
  return new DrizzleQueryError("insert into agency_kyc …", [], Object.assign(new Error("driver"), { code: sqlstate }));
}

function kycRow(overrides: Partial<AgencyKyc> = {}): AgencyKyc {
  const now = new Date("2026-07-23T00:00:00Z");
  return {
    id: "kyc-1",
    payerId: AGENCY,
    panEnc: pii.encrypt(PAN),
    panHash: pii.hmac(PAN),
    bankAccountEnc: pii.encrypt(BANK),
    ifscEnc: pii.encrypt(IFSC),
    accountHolderNameEnc: pii.encrypt(HOLDER),
    status: "pending",
    verifiedAt: null,
    verifiedBy: null,
    rejectReason: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as AgencyKyc;
}

function make(opts?: {
  row?: AgencyKyc;
  verified?: boolean;
  rejected?: boolean;
  /** ADR-0037 Decision 7 — the owning agency's lifecycle status. Defaults to `active`. */
  payerStatus?: "pending" | "active" | "suspended";
}) {
  const emit = vi.fn().mockResolvedValue(undefined);
  const events = { emit } as unknown as EventsService;
  let captured: AgencyKycCiphertext | undefined;
  const repo = {
    upsertPending: vi.fn().mockImplementation(async (payerId: string, c: AgencyKycCiphertext) => {
      captured = c;
      return kycRow({ payerId, ...c });
    }),
    findByPayer: vi.fn().mockResolvedValue(opts?.row),
    listByStatus: vi.fn().mockResolvedValue(opts?.row ? [opts.row] : []),
    markVerified: vi.fn().mockResolvedValue(opts?.verified === false ? null : new Date("2026-07-23T09:00:00Z")),
    markRejected: vi.fn().mockResolvedValue(opts?.rejected === false ? null : new Date("2026-07-23T09:00:00Z")),
  } as unknown as AgencyKycRepository;
  // ADR-0037 Decision 7 — the lifecycle read the ops verify consults.
  const payers = {
    findAuthFacts: vi
      .fn()
      .mockResolvedValue({ role: "agent", status: opts?.payerStatus ?? "active" }),
  } as unknown as PayersRepository;
  const svc = new AgencyKycService(repo, pii, events, payers);
  return { svc, repo, emit, payers, captured: () => captured };
}

describe("AgencyKycService — financial PII at rest + PII-free spine", () => {
  it("ENCRYPTS every field (no plaintext) and stores a keyed PAN hash", async () => {
    const { svc, captured } = make();
    await svc.submit(await ownScope(AGENCY), { pan: PAN, bank_account: BANK, ifsc: IFSC, account_holder_name: HOLDER });
    const c = captured()!;

    expect(c.panEnc).not.toContain(PAN);
    expect(c.bankAccountEnc).not.toContain(BANK);
    expect(c.accountHolderNameEnc).not.toContain("Acme");
    // round-trips, and the PAN hash is the keyed HMAC (dedup key), never plaintext.
    expect(pii.decrypt(c.panEnc)).toBe(PAN);
    expect(pii.decrypt(c.bankAccountEnc)).toBe(BANK);
    expect(c.panHash).toBe(pii.hmac(PAN));
    expect(c.panHash).not.toContain(PAN);
  });

  it("emits agency_kyc.submitted with NO PAN/bank in the payload (PII-free spine)", async () => {
    const { svc, emit } = make();
    await svc.submit(await ownScope(AGENCY), { pan: PAN, bank_account: BANK, ifsc: IFSC, account_holder_name: HOLDER });

    const call = emit.mock.calls.find((c) => (c[0] as { event_name: string }).event_name === "agency_kyc.submitted");
    expect(call).toBeDefined();
    const evt = call![0] as { payload: unknown; actor: { actor_type: string } };
    expect(evt.payload).toEqual({ payer_id: AGENCY, status: "pending" });
    expect(evt.actor.actor_type).toBe("agent");
    // The raw financial PII appears NOWHERE in the emitted event.
    const serialized = JSON.stringify(evt);
    expect(serialized).not.toContain(PAN);
    expect(serialized).not.toContain(BANK);
    expect(serialized).not.toContain("Acme");
  });

  it("returns a MASKED view (last-4 only) — never the full PAN/bank", async () => {
    const { svc } = make();
    const view = await svc.submit(await ownScope(AGENCY), { pan: PAN, bank_account: BANK, ifsc: IFSC, account_holder_name: HOLDER });
    expect(view).toMatchObject({ status: "pending", panLast4: "234F", bankLast4: "9012" });
    expect(JSON.stringify(view)).not.toContain(PAN);
    expect(JSON.stringify(view)).not.toContain(BANK);
  });

  it("a cross-agency duplicate PAN (23505) surfaces a NEUTRAL conflict — no oracle, no PAN echoed", async () => {
    const { svc, repo, emit } = make();
    // Wrapped exactly as drizzle 0.45 throws it: the SQLSTATE is on `cause`, not the error (#1811).
    (repo.upsertPending as ReturnType<typeof vi.fn>).mockRejectedValue(queryError("23505"));
    const err = await svc
      .submit(await ownScope(AGENCY), { pan: PAN, bank_account: BANK, ifsc: IFSC, account_holder_name: HOLDER })
      .then(() => null)
      .catch((e: Error) => e);

    expect(err).toBeInstanceOf(ConflictException);
    // The rejection never echoes the PAN or says "PAN taken" (no oracle), and no event fires.
    expect(err!.message).not.toContain(PAN);
    expect(err!.message.toLowerCase()).not.toContain("pan");
    expect(emit).not.toHaveBeenCalled();
  });

  it("any other write failure propagates as itself — it is never dressed up as a conflict", async () => {
    const { svc, repo, emit } = make();
    const boom = queryError("23514");
    (repo.upsertPending as ReturnType<typeof vi.fn>).mockRejectedValue(boom);
    await expect(
      svc.submit(await ownScope(AGENCY), { pan: PAN, bank_account: BANK, ifsc: IFSC, account_holder_name: HOLDER }),
    ).rejects.toBe(boom);
    expect(emit).not.toHaveBeenCalled();
  });

  it("getOwnView returns not_submitted when there is no KYC row", async () => {
    const { svc } = make({ row: undefined });
    expect(await svc.getOwnView(await ownScope(AGENCY))).toMatchObject({ status: "not_submitted", panLast4: null });
  });

  it("statusForGate returns the raw status (verified) with NO decrypt", async () => {
    const { svc } = make({ row: kycRow({ status: "verified" }) });
    expect(await svc.statusForGate(await ownTenantKey(AGENCY))).toBe("verified");
  });

  it("statusForGate returns null when never submitted", async () => {
    const { svc } = make({ row: undefined });
    expect(await svc.statusForGate(await ownTenantKey(AGENCY))).toBeNull();
  });
});

/**
 * ADR-0053 (PAY-DB-01 P2d, owner ruling O-5) — KYC is ORG-level: the agency-facing entry points
 * key the row by the TENANT key of the scope they are HANDED (never resolving one themselves —
 * the route's owner gate resolves once and hands it over, agency-payouts-single-resolution.test.ts);
 * the acting login is the actor. Scopes here come from the REAL resolver, as the guard's do.
 */
describe("AgencyKycService — the tenant key keys the org's KYC (ADR-0053 P2d)", () => {
  const ANCHOR = AGENCY;
  const MEMBER = "77777777-7777-4777-8777-777777777777";
  const OUTSIDER = "88888888-8888-4888-8888-888888888888";
  const TEAM = [{ anchor: ANCHOR, members: [MEMBER] }];
  const ON = { PAYER_ORG_TENANCY_MODE: "on" } as unknown as ServerConfig;
  const DTO = { pan: PAN, bank_account: BANK, ifsc: IFSC, account_holder_name: HOLDER };
  const scopeOff = (actor: string) => defaultModeResolver(TEAM).resolve(actor);
  const scopeOn = (actor: string) => resolverOver(ON, TEAM).resolve(actor);

  const submitted = (emit: ReturnType<typeof vi.fn>) =>
    emit.mock.calls
      .map(
        (c) => c[0] as { event_name: string; actor: unknown; subject: unknown; payload: unknown },
      )
      .find((evt) => evt.event_name === "agency_kyc.submitted");

  it("off: byte-identical — the session payer keys the row, and is the event's actor, subject and payer_id", async () => {
    const { svc, repo, emit } = make();
    await svc.submit(await scopeOff(MEMBER), DTO);
    expect(repo.upsertPending).toHaveBeenCalledWith(MEMBER, expect.anything());
    expect(submitted(emit)).toMatchObject({
      actor: { actor_type: "agent", actor_id: MEMBER },
      subject: { subject_type: "payer", subject_id: MEMBER },
      payload: { payer_id: MEMBER, status: "pending" },
    });
    await svc.getOwnView(await scopeOff(MEMBER));
    expect(repo.findByPayer).toHaveBeenCalledWith(MEMBER);
  });

  it("on: the owner (the anchor) keys its own org — every field is the anchor", async () => {
    const { svc, repo, emit } = make();
    await svc.submit(await scopeOn(ANCHOR), DTO);
    expect(repo.upsertPending).toHaveBeenCalledWith(ANCHOR, expect.anything());
    expect(submitted(emit)).toMatchObject({
      actor: { actor_type: "agent", actor_id: ANCHOR },
      payload: { payer_id: ANCHOR },
    });
  });

  it("on: the row is the ORG's — a teammate's scope keys the anchor's row; the login stays the actor", async () => {
    const { svc, repo, emit } = make();
    await svc.submit(await scopeOn(MEMBER), DTO);
    expect(repo.upsertPending).toHaveBeenCalledWith(ANCHOR, expect.anything());
    expect(submitted(emit)).toMatchObject({
      actor: { actor_type: "agent", actor_id: MEMBER },
      subject: { subject_type: "payer", subject_id: ANCHOR },
      payload: { payer_id: ANCHOR, status: "pending" },
    });
    await svc.getOwnView(await scopeOn(MEMBER));
    expect(repo.findByPayer).toHaveBeenCalledWith(ANCHOR);
  });

  it("on: an outsider reads only their own org's KYC, never the team's", async () => {
    const { svc, repo } = make({ row: undefined });
    expect(await svc.getOwnView(await scopeOn(OUTSIDER))).toMatchObject({
      status: "not_submitted",
    });
    expect(repo.findByPayer).toHaveBeenCalledWith(OUTSIDER);
    expect(repo.findByPayer).not.toHaveBeenCalledWith(ANCHOR);
  });
});

describe("AgencyKycService — ops verify / reject (actor = ops, event-first)", () => {
  it("verify emits agency_kyc.verified with actor ops when it performs the transition", async () => {
    const { svc, emit } = make({ verified: true });
    const out = await svc.verify(AGENCY);
    expect(out).toEqual({ ok: true });
    const call = emit.mock.calls.find((c) => (c[0] as { event_name: string }).event_name === "agency_kyc.verified");
    expect((call![0] as { actor: { actor_type: string } }).actor.actor_type).toBe("ops");
    expect((call![0] as { payload: unknown }).payload).toEqual({ payer_id: AGENCY });
  });

  it("verify is a no-op (no event) when the row was NOT pending", async () => {
    const { svc, emit } = make({ verified: false });
    const out = await svc.verify(AGENCY);
    expect(out).toEqual({ ok: false });
    expect(emit.mock.calls.some((c) => (c[0] as { event_name: string }).event_name === "agency_kyc.verified")).toBe(false);
  });

  it("stamps a PER-DECISION idempotency key so a re-verify after a KYC resubmit lands on the spine", async () => {
    const { svc, repo, emit } = make({ verified: true });
    // Two separate verify DECISIONS (resubmit → re-verify) with distinct transition timestamps.
    (repo.markVerified as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(new Date("2026-07-23T09:00:00Z"))
      .mockResolvedValueOnce(new Date("2026-07-24T10:00:00Z"));
    await svc.verify(AGENCY);
    await svc.verify(AGENCY);
    const keys = emit.mock.calls
      .filter((c) => (c[0] as { event_name: string }).event_name === "agency_kyc.verified")
      .map((c) => (c[0] as { idempotencyKey: string }).idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]); // distinct → the 2nd genuine decision is NOT deduped away
    expect(keys[0]).toContain(AGENCY);
  });

  it("reject emits agency_kyc.rejected carrying the bounded reason CODE", async () => {
    const { svc, emit } = make({ rejected: true });
    await svc.reject(AGENCY, "invalid_pan");
    const call = emit.mock.calls.find((c) => (c[0] as { event_name: string }).event_name === "agency_kyc.rejected");
    expect((call![0] as { payload: { reason: string } }).payload).toEqual({ payer_id: AGENCY, reason: "invalid_pan" });
  });
});

describe("AgencyKycService.verify — a suspended agency is frozen (ADR-0037 Decision 7)", () => {
  it("REFUSES to verify a suspended agency's KYC", async () => {
    const m = make({ payerStatus: "suspended" });
    await expect(m.svc.verify(AGENCY)).rejects.toBeInstanceOf(ConflictException);
    // The transition never runs — the row is untouched, so a later reinstate + verify is
    // still a clean first decision rather than a replay.
    expect(m.repo.markVerified).not.toHaveBeenCalled();
  });

  it("emits NOTHING when it refuses (no half-recorded decision on the spine)", async () => {
    const m = make({ payerStatus: "suspended" });
    await expect(m.svc.verify(AGENCY)).rejects.toThrow();
    expect(m.emit).not.toHaveBeenCalled();
  });

  it("still verifies an ACTIVE agency — the freeze is targeted, not a blanket stop", async () => {
    // The control. Without it, a mutation that refused EVERY verify would satisfy both
    // assertions above while silently breaking the entire ops KYC queue.
    const m = make({ payerStatus: "active" });
    await expect(m.svc.verify(AGENCY)).resolves.toEqual({ ok: true });
    expect(m.repo.markVerified).toHaveBeenCalledWith(AGENCY);
  });

  it("still verifies a PENDING agency (not-yet-verified is not the same as banned)", async () => {
    const m = make({ payerStatus: "pending" });
    await expect(m.svc.verify(AGENCY)).resolves.toEqual({ ok: true });
  });

  it("REJECT is deliberately NOT blocked for a suspended agency", async () => {
    // Rejecting is restrictive — it takes eligibility away, never grants it. Ops must stay
    // able to clear a fraudulent submission from the queue without first reinstating the
    // account that made it.
    const m = make({ payerStatus: "suspended" });
    await expect(m.svc.reject(AGENCY, "invalid_pan")).resolves.toEqual({ ok: true });
    expect(m.repo.markRejected).toHaveBeenCalled();
  });
});
