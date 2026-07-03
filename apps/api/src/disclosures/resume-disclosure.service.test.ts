import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import type { ServerConfig } from "@badabhai/config";
import type { RequestContext } from "../common/request-context";
import type { EventsService } from "../events/events.service";
import type { ConsentRepository } from "../consent/consent.repository";
import type { WorkersRepository } from "../workers/workers.repository";
import type { PiiCryptoService } from "../common/pii-crypto.service";
import type { PayerOrgsRepository } from "../payers/payer-orgs.repository";
import type { StorageService } from "../storage/storage.service";
import type { ResumeRenderer, ResumeRenderInput } from "../resume/resume-renderer.service";
import { ResumeDisclosureService } from "./resume-disclosure.service";
import type { ResumeDisclosureRepository } from "./resume-disclosure.repository";
import { RequestDisclosureSchema } from "./resume-disclosure.dto";

const CTX = { correlationId: "corr-1", requestId: "req-1" } as RequestContext;
const PAYER = "11111111-1111-1111-1111-111111111111";
const WORKER = "22222222-2222-2222-2222-222222222222";
const REAL_NAME = "Ramesh Kumar"; // must NEVER appear in event/response
const MASKED = "R***** K.";
const SENTINEL_PHONE = "+919876500000"; // must NEVER appear anywhere client-visible
const SIGNED_URL = "https://signed.example/disclosure/abc?token=secret"; // never logged/evented (B-D)

// ADR-0027 B5.x Inc 4 — the tenancy flip (the EXACT sibling of the Inc 2 unlocks flip). Each
// acting payer resolves to a STABLE org id via PayerOrgsRepository.resolveOrgForPayer. The
// default single-payer tests map PAYER→ORG, so ownership/idempotency key on ORG while behavior
// is preserved (solo org == the one payer).
const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // PAYER's solo org
const DEFAULT_ORG_MAP: Record<string, string> = { [PAYER]: ORG };

const CONFIG = {
  UNLOCK_MAX_REVEALS_PER_WORKER_PER_DAY: 5,
  UNLOCK_MAX_PAYERS_PER_WORKER_PER_WEEK: 10,
  RESUME_SIGNED_URL_TTL_SECONDS: 900,
} as unknown as ServerConfig;

interface SetupOpts {
  consentPurposes?: string[] | null; // null => no consent row
  consentRevoked?: boolean;
  workerExists?: boolean;
  hasResume?: boolean;
  dailyCount?: number;
  weeklyOrgs?: number; // countDistinctOrgsSince (the weekly cap unit, ADR-0027 B5.x Inc 4)
  renderNull?: boolean; // renderPdf degrades to null
  existing?: Record<string, unknown>; // existing disclosure row for idempotency
  // ADR-0027 B5.x Inc 4: acting-payer → owning-org map (defaults to PAYER→ORG). A payer
  // ABSENT from the map resolves to null (the fail-closed no-org case).
  orgMap?: Record<string, string>;
}

function setup(opts: SetupOpts = {}) {
  const consentPurposes = opts.consentPurposes === undefined ? ["employer_sharing"] : opts.consentPurposes;
  const workerExists = opts.workerExists ?? true;
  const hasResume = opts.hasResume ?? true;
  const orgMap = opts.orgMap ?? DEFAULT_ORG_MAP;

  const txMethods = {
    lockWorker: vi.fn(async () => undefined),
    // Typed (_tx, orgId, ...) so the cross-org IDOR test can key the "existing" row on the
    // caller's org via mockImplementation (a foreign org sees no row → no collision).
    findByOrgWorkerPosting: vi.fn(
      async (_tx: unknown, _orgId: string, _workerId?: string, _jobPostingId?: string | null) => opts.existing,
    ),
    countDisclosuresToPayersSince: vi.fn(async () => opts.dailyCount ?? 0),
    countDistinctOrgsSince: vi.fn(async () => opts.weeklyOrgs ?? 0),
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
    listByOrg: vi.fn(async () => []),
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
    findById: vi.fn(async () => (workerExists ? { id: WORKER, fullName: "enc:" + REAL_NAME } : undefined)),
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

  // ADR-0027 B5.x Inc 4: the tenancy resolver. Maps each acting payer → its owning org (or
  // null when absent — the fail-closed no-org case). resolveOrgForPayer ONLY (the hot path
  // never calls ensureSoloOrg).
  const orgs = {
    resolveOrgForPayer: vi.fn(async (payerId: string) =>
      payerId in orgMap ? { orgId: orgMap[payerId], orgRole: "owner" } : null,
    ),
  };

  const service = new ResumeDisclosureService(
    repo as unknown as ResumeDisclosureRepository,
    consents as unknown as ConsentRepository,
    workers as unknown as WorkersRepository,
    pii as unknown as PiiCryptoService,
    renderer as unknown as ResumeRenderer,
    storage as unknown as StorageService,
    events as unknown as EventsService,
    orgs as unknown as PayerOrgsRepository,
    CONFIG,
  );

  return { service, repo, txMethods, consents, workers, pii, renderer, storage, events, orgs, emitted, getRenderInput: () => renderInput };
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

  it("no-consent but worker EXISTS → records an internal denied row (no_consent), stamping org_id + payer_id", async () => {
    const t = setup({ consentPurposes: null, workerExists: true });
    await t.service.requestDisclosure({ payerId: PAYER, workerId: WORKER, jobPostingId: null }, CTX);
    expect(t.txMethods.insertRow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "denied", denyReason: "no_consent", orgId: ORG, payerId: PAYER }),
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
      expect.objectContaining({ status: "denied", denyReason: "capped", orgId: ORG, payerId: PAYER }),
    );
    expect(t.renderer.renderPdf).not.toHaveBeenCalled();
    expect(t.emitted).toHaveLength(0);
  });

  it("weekly distinct-ORG ceiling reached → neutral (ADR-0027 B5.x Inc 4)", async () => {
    const t = setup({ weeklyOrgs: 10 });
    const res = await t.service.requestDisclosure({ payerId: PAYER, workerId: WORKER, jobPostingId: null }, CTX);
    expect(res).toEqual(NEUTRAL);
    expect(t.txMethods.countDistinctOrgsSince).toHaveBeenCalled();
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

// ===========================================================================
// ADR-0027 B5.x Inc 4 — the payer_id→org_id tenancy flip (sibling of Inc 2)
// ===========================================================================

const PAYER_A2 = "aaaaaaa2-aaa2-4aa2-8aa2-aaaaaaaaaaa2"; // a SECOND payer in PAYER's org (ORG)
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PAYER_B = "bbbbbbb1-bbb1-4bb1-8bb1-bbbbbbbbbbb1"; // a payer in ORG_B

describe("ResumeDisclosureService — cross-org IDOR (idempotency keys on ORG, no leak, no-oracle)", () => {
  it("payerB (orgB) requesting a worker+posting orgA already disclosed does NOT collide with orgA's row (org-scoped lookup)", async () => {
    // orgA has a LIVE disclosed row for (WORKER, null). payerB is in ORG_B, so its org-scoped
    // idempotency lookup MUST return undefined (no cross-org collision) — the mock keys the
    // "existing" row on the caller's org, so payerB sees none and proceeds on its own budget.
    const future = new Date(Date.now() + 60_000);
    const t = setup({
      orgMap: { [PAYER]: ORG, [PAYER_B]: ORG_B },
    });
    // The lookup is org-scoped in the repo; model that here — payerB's org has no existing row.
    t.txMethods.findByOrgWorkerPosting.mockImplementation(async (_tx: unknown, orgId: string) =>
      orgId === ORG ? { id: "disc-A", status: "disclosed", expiresAt: future } : undefined,
    );
    const res = await t.service.requestDisclosure({ payerId: PAYER_B, workerId: WORKER, jobPostingId: null }, CTX);
    // payerB gets a FRESH disclosure (disc-1 from the insert), never orgA's disc-A → no leak.
    expect((res as { disclosure_id: string }).disclosure_id).toBe("disc-1");
    // The lookup was called with ORG_B (the caller's org), never orgA's ORG.
    expect(t.txMethods.findByOrgWorkerPosting).toHaveBeenCalledWith(expect.anything(), ORG_B, WORKER, null);
    expect(t.txMethods.findByOrgWorkerPosting).not.toHaveBeenCalledWith(expect.anything(), ORG, WORKER, null);
  });

  it("a foreign-org caller with no resolvable org gets the IDENTICAL neutral body (no-oracle)", async () => {
    // PAYER_B absent from the map → resolves to null → fail-closed neutral (byte-identical).
    const t = setup({ orgMap: { [PAYER]: ORG } });
    const res = await t.service.requestDisclosure({ payerId: PAYER_B, workerId: WORKER, jobPostingId: null }, CTX);
    expect(res).toEqual(NEUTRAL);
    expect(JSON.stringify(res)).toBe(JSON.stringify(NEUTRAL));
  });
});

describe("ResumeDisclosureService — shared-org (two payers, one org: shared idempotency)", () => {
  it("payerA2 requesting the SAME (worker, posting) as payerA reuses the SAME org disclosure row", async () => {
    // PAYER and PAYER_A2 both resolve to ORG. payerA already has a LIVE disclosed row for
    // (WORKER, null) — payerA2 (teammate) must converge on the SAME row, no new grant/render.
    const future = new Date(Date.now() + 60_000);
    const t = setup({
      orgMap: { [PAYER]: ORG, [PAYER_A2]: ORG },
      existing: { id: "disc-shared", status: "disclosed", expiresAt: future },
    });
    const res = await t.service.requestDisclosure({ payerId: PAYER_A2, workerId: WORKER, jobPostingId: null }, CTX);
    expect((res as { disclosure_id: string }).disclosure_id).toBe("disc-shared");
    // Idempotent: no new grant, no re-render, no new event — just a re-signed link (B-B reuse).
    expect(t.txMethods.insertRow).not.toHaveBeenCalled();
    expect(t.renderer.renderPdf).not.toHaveBeenCalled();
    expect(t.emitted).toHaveLength(0);
    // The lookup was org-scoped on ORG (the shared org), not on the acting payer.
    expect(t.txMethods.findByOrgWorkerPosting).toHaveBeenCalledWith(expect.anything(), ORG, WORKER, null);
  });
});

describe("ResumeDisclosureService — weekly cap counts DISTINCT ORGS (behavior-preserving under solo orgs)", () => {
  it("N distinct payers in the SAME org count as ONE org (under the cap → discloses)", async () => {
    // The repo count is what the DB returns (distinct org_id across the unlocks+disclosures
    // union). Modelled as 1 for a single-org team of many payers → below the cap → discloses.
    const t = setup({ weeklyOrgs: 1 });
    const res = await t.service.requestDisclosure({ payerId: PAYER, workerId: WORKER, jobPostingId: null }, CTX);
    expect((res as { ok?: boolean }).ok).toBe(true);
    expect(t.txMethods.countDistinctOrgsSince).toHaveBeenCalled();
    expect(t.renderer.renderPdf).toHaveBeenCalledOnce();
  });

  it("distinct ORGS at the cap → neutral (the weekly ceiling now counts employers, not payers)", async () => {
    const t = setup({ weeklyOrgs: 10 }); // == UNLOCK_MAX_PAYERS_PER_WORKER_PER_WEEK
    const res = await t.service.requestDisclosure({ payerId: PAYER, workerId: WORKER, jobPostingId: null }, CTX);
    expect(res).toEqual(NEUTRAL);
    expect(t.txMethods.countDistinctOrgsSince).toHaveBeenCalled();
  });
});

describe("ResumeDisclosureService — fail-closed when the acting payer has NO resolvable org", () => {
  it("requestDisclosure (WRITE) with an unresolvable org returns neutral, never opens the tx", async () => {
    // PAYER absent from the org map → resolveOrgForPayer returns null.
    const t = setup({ orgMap: {} });
    const res = await t.service.requestDisclosure({ payerId: PAYER, workerId: WORKER, jobPostingId: null }, CTX);
    expect(res).toEqual(NEUTRAL); // byte-identical neutral, no distinguishable error
    // Org resolved BEFORE any tx-external read / the lock — nothing downstream fired.
    expect(t.consents.findLatestByWorker).not.toHaveBeenCalled();
    expect(t.repo.withTransaction).not.toHaveBeenCalled();
    expect(t.txMethods.insertRow).not.toHaveBeenCalled();
  });

  it("listByPayer (READ) with an unresolvable org returns an empty list (fail-closed read)", async () => {
    const t = setup({ orgMap: {} });
    const out = await t.service.listByPayer(PAYER);
    expect(out).toEqual({ disclosures: [] });
    expect(t.repo.listByOrg).not.toHaveBeenCalled();
  });

  it("listByPayer resolves the org and lists ON org_id (not the acting payer)", async () => {
    const t = setup(); // PAYER→ORG
    await t.service.listByPayer(PAYER);
    expect(t.orgs.resolveOrgForPayer).toHaveBeenCalledWith(PAYER);
    expect(t.repo.listByOrg).toHaveBeenCalledWith(ORG);
  });
});

describe("ResumeDisclosureService — NOT-NULL stamping (every insert carries org_id + payer_id)", () => {
  it("a GRANTED disclosure insert stamps BOTH org_id (ownership) and payer_id (acting)", async () => {
    const t = setup({ consentPurposes: ["employer_sharing"] });
    await t.service.requestDisclosure({ payerId: PAYER, workerId: WORKER, jobPostingId: null }, CTX);
    const insert = t.txMethods.insertRow.mock.calls[0]![1] as Record<string, unknown>;
    expect(insert.orgId).toBe(ORG);
    expect(insert.payerId).toBe(PAYER);
    expect(insert.status).toBe("granted");
  });

  it("a DENIED disclosure insert (no_consent) stamps BOTH org_id and payer_id", async () => {
    const t = setup({ consentPurposes: ["profiling"], workerExists: true }); // consented, NOT employer_sharing
    await t.service.requestDisclosure({ payerId: PAYER, workerId: WORKER, jobPostingId: null }, CTX);
    const insert = t.txMethods.insertRow.mock.calls[0]![1] as Record<string, unknown>;
    expect(insert.orgId).toBe(ORG);
    expect(insert.payerId).toBe(PAYER);
    expect(insert.status).toBe("denied");
  });
});
