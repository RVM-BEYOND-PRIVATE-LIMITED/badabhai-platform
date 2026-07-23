import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import type { ServerConfig } from "@badabhai/config";
import type { AgencyKyc } from "@badabhai/db";
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

function make(opts?: { row?: AgencyKyc; verified?: boolean; rejected?: boolean }) {
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
    markVerified: vi.fn().mockResolvedValue(opts?.verified ?? true),
    markRejected: vi.fn().mockResolvedValue(opts?.rejected ?? true),
  } as unknown as AgencyKycRepository;
  const svc = new AgencyKycService(repo, pii, events);
  return { svc, repo, emit, captured: () => captured };
}

describe("AgencyKycService — financial PII at rest + PII-free spine", () => {
  it("ENCRYPTS every field (no plaintext) and stores a keyed PAN hash", async () => {
    const { svc, captured } = make();
    await svc.submit(AGENCY, { pan: PAN, bank_account: BANK, ifsc: IFSC, account_holder_name: HOLDER });
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
    await svc.submit(AGENCY, { pan: PAN, bank_account: BANK, ifsc: IFSC, account_holder_name: HOLDER });

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
    const view = await svc.submit(AGENCY, { pan: PAN, bank_account: BANK, ifsc: IFSC, account_holder_name: HOLDER });
    expect(view).toMatchObject({ status: "pending", panLast4: "234F", bankLast4: "9012" });
    expect(JSON.stringify(view)).not.toContain(PAN);
    expect(JSON.stringify(view)).not.toContain(BANK);
  });

  it("getOwnView returns not_submitted when there is no KYC row", async () => {
    const { svc } = make({ row: undefined });
    expect(await svc.getOwnView(AGENCY)).toMatchObject({ status: "not_submitted", panLast4: null });
  });

  it("statusForGate returns the raw status (verified) with NO decrypt", async () => {
    const { svc } = make({ row: kycRow({ status: "verified" }) });
    expect(await svc.statusForGate(AGENCY)).toBe("verified");
  });

  it("statusForGate returns null when never submitted", async () => {
    const { svc } = make({ row: undefined });
    expect(await svc.statusForGate(AGENCY)).toBeNull();
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

  it("reject emits agency_kyc.rejected carrying the bounded reason CODE", async () => {
    const { svc, emit } = make({ rejected: true });
    await svc.reject(AGENCY, "invalid_pan");
    const call = emit.mock.calls.find((c) => (c[0] as { event_name: string }).event_name === "agency_kyc.rejected");
    expect((call![0] as { payload: { reason: string } }).payload).toEqual({ payer_id: AGENCY, reason: "invalid_pan" });
  });
});
