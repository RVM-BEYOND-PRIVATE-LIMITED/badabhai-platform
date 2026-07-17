import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import type { ServerConfig } from "@badabhai/config";
import type { RequestContext } from "../common/request-context";
import type { EventsService } from "../events/events.service";
import type { ConsentRepository } from "../consent/consent.repository";
import type { WorkersRepository } from "../workers/workers.repository";
import type { PiiCryptoService } from "../common/pii-crypto.service";
import type { StorageService } from "../storage/storage.service";
import type { ResumeRenderer, ResumeRenderInput } from "../resume/resume-renderer.service";
import { ResumeDisclosureService } from "./resume-disclosure.service";
import type { ResumeDisclosureRepository } from "./resume-disclosure.repository";
import { RequestDisclosureSchema } from "./resume-disclosure.dto";
import { neutralUnavailable } from "../unlocks/unlock-response";

const CTX = { correlationId: "corr-1", requestId: "req-1" } as RequestContext;
const PAYER = "11111111-1111-1111-1111-111111111111";
const WORKER = "22222222-2222-2222-2222-222222222222";
const REAL_NAME = "Ramesh Kumar"; // must NEVER appear in event/response
const MASKED = "R***** K.";
const SENTINEL_PHONE = "+919876500000"; // must NEVER appear anywhere client-visible
const SIGNED_URL = "https://signed.example/disclosure/abc?token=secret"; // never logged/evented (B-D)

const CONFIG = {
  UNLOCK_MAX_REVEALS_PER_WORKER_PER_DAY: 5,
  UNLOCK_MAX_PAYERS_PER_WORKER_PER_WEEK: 10,
  RESUME_SIGNED_URL_TTL_SECONDS: 900,
} as unknown as ServerConfig;

interface SetupOpts {
  consentPurposes?: string[] | null; // null => no consent row
  consentRevoked?: boolean;
  workerExists?: boolean;
  pendingDeletion?: boolean; // ADR-0031: worker inside the deletion grace window
  hasResume?: boolean;
  dailyCount?: number;
  weeklyPayers?: number;
  renderNull?: boolean; // renderPdf degrades to null
  existing?: Record<string, unknown>; // existing disclosure row for idempotency
}

function setup(opts: SetupOpts = {}) {
  const consentPurposes = opts.consentPurposes === undefined ? ["employer_sharing"] : opts.consentPurposes;
  const workerExists = opts.workerExists ?? true;
  const hasResume = opts.hasResume ?? true;
  // ADR-0031: NULL = active worker; a Date = pending deletion (the grace marker).
  const deletionScheduledAt = opts.pendingDeletion ? new Date("2026-07-21T10:00:00.000Z") : null;

  const txMethods = {
    lockWorker: vi.fn(async () => undefined),
    findByPayerWorkerPosting: vi.fn(async () => opts.existing),
    countDisclosuresToPayersSince: vi.fn(async () => opts.dailyCount ?? 0),
    countDistinctPayersSince: vi.fn(async () => opts.weeklyPayers ?? 0),
    // ADR-0031: the tx-scoped deletion-grace marker read (the in-tx re-check).
    getWorkerDeletionMarker: vi.fn(async () => (workerExists ? { deletionScheduledAt } : undefined)),
    insertRow: vi.fn(async (_tx: unknown, input: Record<string, unknown>) => ({
      id: "disc-1",
      ...input,
    })),
    updateStatus: vi.fn(async (_tx: unknown, id: string, patch: Record<string, unknown>) => ({
      id,
      ...patch,
    })),
  };

  const repo = {
    withTransaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(txMethods)),
    findResumeSource: vi.fn(async () =>
      hasResume
        ? { resumeId: "resume-1", sourceProfileSnapshot: {}, templateId: "classic", version: 1 }
        : undefined,
    ),
    markDisclosed: vi.fn(async (_id: string, _input: Record<string, unknown>) => undefined),
    listByPayer: vi.fn(async () => []),
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
    findById: vi.fn(async () =>
      workerExists ? { id: WORKER, fullName: "enc:" + REAL_NAME, deletionScheduledAt } : undefined,
    ),
  };

  const pii = {
    decrypt: vi.fn((token: string) => token.replace(/^enc:/, "")), // returns REAL_NAME
  };

  let renderInput: ResumeRenderInput | undefined;
  const renderer = {
    renderPdf: vi.fn(async (input: ResumeRenderInput) => {
      renderInput = input;
      return opts.renderNull ? null : Buffer.from("%PDF-1.4 masked");
    }),
  };

  const storage = {
    uploadPdf: vi.fn(async () => undefined),
    createSignedUrl: vi.fn(async () => SIGNED_URL),
  };

  const emitted: unknown[] = [];
  const events = {
    emit: vi.fn(async (params: unknown) => {
      emitted.push(params);
      return {};
    }),
  };

  const service = new ResumeDisclosureService(
    repo as unknown as ResumeDisclosureRepository,
    consents as unknown as ConsentRepository,
    workers as unknown as WorkersRepository,
    pii as unknown as PiiCryptoService,
    renderer as unknown as ResumeRenderer,
    storage as unknown as StorageService,
    events as unknown as EventsService,
    CONFIG,
  );

  return { service, repo, txMethods, consents, workers, pii, renderer, storage, events, emitted, getRenderInput: () => renderInput };
}

const NEUTRAL = { status: "unavailable" };

describe("ResumeDisclosureService — happy path (B-G masked render + B-E fact-only event)", () => {
  it("grants + discloses: returns the signed URL and renders with MASKED initials", async () => {
    const t = setup();
    const res = await t.service.requestDisclosure({ payerId: PAYER, workerId: WORKER, jobPostingId: null }, CTX);

    expect(res).toEqual({
      ok: true,
      disclosure_id: "disc-1",
      status: "disclosed",
      resume_url: SIGNED_URL,
      expires_at: expect.any(String),
    });
    // B-G: the renderer got the MASKED name, never the real one.
    expect(t.getRenderInput()?.displayName).toBe(MASKED);
    // ADR-0032 (the faceless invariant): the disclosure render input carries NO
    // photo — photoDataUri is STRUCTURALLY null, so the payer-facing PDF can never
    // embed a worker's face even when the worker HAS a photo + show_photo on.
    expect(t.getRenderInput()?.photoDataUri).toBeNull();
    expect(t.renderer.renderPdf).toHaveBeenCalledOnce();
    // Marked disclosed with the opaque resume_ref pointer.
    expect(t.repo.markDisclosed).toHaveBeenCalledWith("disc-1", expect.objectContaining({ resumeRef: "resume-1" }));
    // B-E: exactly one resume.disclosed, FACT-only payload (ids + opaque ref).
    expect(t.emitted).toHaveLength(1);
    const ev = t.emitted[0] as { event_name: string; payload: Record<string, unknown> };
    expect(ev.event_name).toBe("resume.disclosed");
    expect(Object.keys(ev.payload).sort()).toEqual(
      ["disclosure_id", "job_posting_id", "payer_id", "resume_ref", "worker_id"].sort(),
    );
  });

  it("decrypts the real name EXACTLY once (single PII touch, F-5)", async () => {
    const t = setup();
    await t.service.requestDisclosure({ payerId: PAYER, workerId: WORKER, jobPostingId: null }, CTX);
    expect(t.pii.decrypt).toHaveBeenCalledOnce();
  });
});

describe("B-D / B-E — no raw PII (name, phone, signed URL) in the event or any log arg", () => {
  it("never passes the real name, phone, or signed URL into events.emit", async () => {
    const t = setup();
    await t.service.requestDisclosure({ payerId: PAYER, workerId: WORKER, jobPostingId: null }, CTX);
    const blob = JSON.stringify(t.emitted);
    expect(blob).not.toContain(REAL_NAME);
    expect(blob).not.toContain("Ramesh");
    expect(blob).not.toContain(SENTINEL_PHONE);
    expect(blob).not.toContain(SIGNED_URL); // the link is RETURNED, never EVENTED (B-D)
  });

  it("the signed URL is returned to the payer but never persisted on the row", async () => {
    const t = setup();
    const res = await t.service.requestDisclosure({ payerId: PAYER, workerId: WORKER, jobPostingId: null }, CTX);
    expect((res as { resume_url: string }).resume_url).toBe(SIGNED_URL);
    // markDisclosed stores only the opaque resume_ref + timestamps — never the URL.
    const markArg = t.repo.markDisclosed.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(JSON.stringify(markArg)).not.toContain(SIGNED_URL);
  });
});

describe("B-A — employer_sharing consent gate (fail closed, no oracle)", () => {
  it("no consent row → neutral; no render, no event", async () => {
    const t = setup({ consentPurposes: null });
    const res = await t.service.requestDisclosure({ payerId: PAYER, workerId: WORKER, jobPostingId: null }, CTX);
    expect(res).toEqual(NEUTRAL);
    expect(t.renderer.renderPdf).not.toHaveBeenCalled();
    expect(t.emitted).toHaveLength(0);
  });

  it("only profiling consent (no employer_sharing) → neutral", async () => {
    const t = setup({ consentPurposes: ["profiling", "resume_generation"] });
    const res = await t.service.requestDisclosure({ payerId: PAYER, workerId: WORKER, jobPostingId: null }, CTX);
    expect(res).toEqual(NEUTRAL);
  });

  it("revoked employer_sharing → neutral", async () => {
    const t = setup({ consentPurposes: ["employer_sharing"], consentRevoked: true });
    const res = await t.service.requestDisclosure({ payerId: PAYER, workerId: WORKER, jobPostingId: null }, CTX);
    expect(res).toEqual(NEUTRAL);
  });

  it("no-consent but worker EXISTS → records an internal denied row (no_consent)", async () => {
    const t = setup({ consentPurposes: null, workerExists: true });
    await t.service.requestDisclosure({ payerId: PAYER, workerId: WORKER, jobPostingId: null }, CTX);
    expect(t.txMethods.insertRow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "denied", denyReason: "no_consent" }),
    );
  });

  it("UNKNOWN worker → NO row written (FK-oracle avoidance) but identical neutral body", async () => {
    const t = setup({ consentPurposes: null, workerExists: false });
    const res = await t.service.requestDisclosure({ payerId: PAYER, workerId: WORKER, jobPostingId: null }, CTX);
    expect(res).toEqual(NEUTRAL);
    expect(t.txMethods.insertRow).not.toHaveBeenCalled();
  });
});

describe("B-B — SHARED per-worker cap (spans unlock reveals + disclosures), atomic", () => {
  it("daily shared ceiling reached → neutral + denied(capped); no render/event", async () => {
    const t = setup({ dailyCount: 5 }); // == UNLOCK_MAX_REVEALS_PER_WORKER_PER_DAY
    const res = await t.service.requestDisclosure({ payerId: PAYER, workerId: WORKER, jobPostingId: null }, CTX);
    expect(res).toEqual(NEUTRAL);
    expect(t.txMethods.insertRow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "denied", denyReason: "capped" }),
    );
    expect(t.renderer.renderPdf).not.toHaveBeenCalled();
    expect(t.emitted).toHaveLength(0);
  });

  it("weekly distinct-payer ceiling reached → neutral", async () => {
    const t = setup({ weeklyPayers: 10 });
    const res = await t.service.requestDisclosure({ payerId: PAYER, workerId: WORKER, jobPostingId: null }, CTX);
    expect(res).toEqual(NEUTRAL);
  });

  it("takes the worker advisory lock before the cap read (atomicity)", async () => {
    const t = setup();
    await t.service.requestDisclosure({ payerId: PAYER, workerId: WORKER, jobPostingId: null }, CTX);
    expect(t.txMethods.lockWorker).toHaveBeenCalledWith(expect.anything(), WORKER);
  });
});

describe("B-C — single neutral body, byte-identical across every deny branch", () => {
  it("no_consent / capped / no-resume / unknown all return the identical object", async () => {
    const a = await setup({ consentPurposes: null }).service.requestDisclosure({ payerId: PAYER, workerId: WORKER, jobPostingId: null }, CTX);
    const b = await setup({ dailyCount: 5 }).service.requestDisclosure({ payerId: PAYER, workerId: WORKER, jobPostingId: null }, CTX);
    const c = await setup({ hasResume: false }).service.requestDisclosure({ payerId: PAYER, workerId: WORKER, jobPostingId: null }, CTX);
    const d = await setup({ consentPurposes: null, workerExists: false }).service.requestDisclosure({ payerId: PAYER, workerId: WORKER, jobPostingId: null }, CTX);
    expect(a).toEqual(NEUTRAL);
    expect(b).toEqual(NEUTRAL);
    expect(c).toEqual(NEUTRAL);
    expect(d).toEqual(NEUTRAL);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(b)).toBe(JSON.stringify(c));
    expect(JSON.stringify(c)).toBe(JSON.stringify(d));
  });

  it("the deny_reason never crosses the response boundary", async () => {
    const res = await setup({ dailyCount: 5 }).service.requestDisclosure({ payerId: PAYER, workerId: WORKER, jobPostingId: null }, CTX);
    expect(JSON.stringify(res)).not.toContain("capped");
    expect(JSON.stringify(res)).not.toContain("reason");
  });
});

describe("fail-closed render — degrade to neutral, disclose nothing", () => {
  it("renderPdf null (render disabled / WeasyPrint missing) → neutral, no markDisclosed, no event", async () => {
    const t = setup({ renderNull: true });
    const res = await t.service.requestDisclosure({ payerId: PAYER, workerId: WORKER, jobPostingId: null }, CTX);
    expect(res).toEqual(NEUTRAL);
    expect(t.repo.markDisclosed).not.toHaveBeenCalled();
    expect(t.emitted).toHaveLength(0);
  });
});

describe("idempotency — a live disclosed grant is reused, not re-rendered", () => {
  it("existing live 'disclosed' row → re-signs the link; no insert, no render, no new event", async () => {
    const future = new Date(Date.now() + 60_000);
    const t = setup({ existing: { id: "disc-existing", status: "disclosed", expiresAt: future } });
    const res = await t.service.requestDisclosure({ payerId: PAYER, workerId: WORKER, jobPostingId: null }, CTX);
    expect((res as { ok: boolean; disclosure_id: string }).disclosure_id).toBe("disc-existing");
    expect(t.txMethods.insertRow).not.toHaveBeenCalled();
    expect(t.renderer.renderPdf).not.toHaveBeenCalled();
    expect(t.emitted).toHaveLength(0);
    expect(t.storage.createSignedUrl).toHaveBeenCalledOnce(); // re-mint only
  });
});

describe("B-F — no bulk/list disclosure shape (anti-harvest)", () => {
  it("the request DTO is a SINGLE (payer, worker, posting) — no array/list field", () => {
    const parsed = RequestDisclosureSchema.parse({ payer_id: PAYER, worker_id: WORKER });
    expect(parsed).toEqual({ payer_id: PAYER, worker_id: WORKER, job_posting_id: null });
    // A bulk shape (worker_ids array) is rejected — there is no such field.
    expect("worker_ids" in parsed).toBe(false);
  });
});

// ---- ADR-0031 payer-surface freeze (ruling (b)): pending-deletion worker ----

describe("ADR-0031 — a pending-deletion worker is not disclosable (byte-identical neutral)", () => {
  it("requestDisclosure during grace → the BYTE-IDENTICAL neutral body; no lock, no render, no row, no event", async () => {
    const t = setup({ pendingDeletion: true });
    const res = await t.service.requestDisclosure({ payerId: PAYER, workerId: WORKER, jobPostingId: null }, CTX);
    // Byte-equality with the canonical neutral constructor (the no-oracle guarantee).
    expect(JSON.stringify(res)).toBe(JSON.stringify(neutralUnavailable()));
    // Denied PRE-lock: the tx never opens; nothing is rendered, minted, written, or evented.
    expect(t.repo.withTransaction).not.toHaveBeenCalled();
    expect(t.renderer.renderPdf).not.toHaveBeenCalled();
    expect(t.storage.createSignedUrl).not.toHaveBeenCalled();
    expect(t.txMethods.insertRow).not.toHaveBeenCalled();
    expect(t.emitted).toHaveLength(0);
    expect(t.pii.decrypt).not.toHaveBeenCalled(); // a frozen worker's real name is NEVER read
  });

  it("a pending-deletion deny is INDISTINGUISHABLE from no-consent/capped/no-resume (no leaving-oracle)", async () => {
    const pending = await setup({ pendingDeletion: true }).service.requestDisclosure({ payerId: PAYER, workerId: WORKER, jobPostingId: null }, CTX);
    const noConsent = await setup({ consentPurposes: null }).service.requestDisclosure({ payerId: PAYER, workerId: WORKER, jobPostingId: null }, CTX);
    expect(JSON.stringify(pending)).toBe(JSON.stringify(noConsent));
  });

  it("the in-tx RE-CHECK closes the schedule-vs-disclosure race AND blocks the live-reuse re-mint", async () => {
    const future = new Date(Date.now() + 60_000);
    // Active at the pre-lock read; a LIVE disclosed row exists (the re-mint path).
    const t = setup({ existing: { id: "disc-existing", status: "disclosed", expiresAt: future } });
    // The tx-scoped marker read sees the schedule land after the pre-lock read.
    t.txMethods.getWorkerDeletionMarker.mockResolvedValue({ deletionScheduledAt: new Date() });
    const res = await t.service.requestDisclosure({ payerId: PAYER, workerId: WORKER, jobPostingId: null }, CTX);
    expect(JSON.stringify(res)).toBe(JSON.stringify(neutralUnavailable()));
    // No fresh signed URL is minted during grace (a re-mint IS a new disclosure).
    expect(t.storage.createSignedUrl).not.toHaveBeenCalled();
    expect(t.renderer.renderPdf).not.toHaveBeenCalled();
    expect(t.emitted).toHaveLength(0);
  });
});
