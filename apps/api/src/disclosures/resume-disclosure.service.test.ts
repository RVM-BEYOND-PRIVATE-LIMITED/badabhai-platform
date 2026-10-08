import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import type { ServerConfig } from "@badabhai/config";
import type { RequestContext } from "../common/request-context";
import type { EventsService } from "../events/events.service";
import type { ConsentRepository } from "../consent/consent.repository";
import type { WorkersRepository } from "../workers/workers.repository";
import type { PiiCryptoService } from "../common/pii-crypto.service";
import type { WorkerAttributesRepository } from "../profiles/worker-attributes.repository";
import type { WorkerEmploymentRepository } from "../profiles/worker-employment.repository";
import type { WorkerQualificationsRepository } from "../profiles/worker-qualifications.repository";
import type {
  WorkerCertificateRecord,
  WorkerEducationRecord,
} from "../resume/resume-qualification-rows";
import type { WorkerEmploymentRecord } from "../resume/resume-employment-rows";
import type { StorageService } from "../storage/storage.service";
import type { ResumeRenderer, ResumeRenderInput } from "../resume/resume-renderer.service";
import { ResumeDisclosureService } from "./resume-disclosure.service";
import type { ResumeDisclosureRepository } from "./resume-disclosure.repository";
import { RequestDisclosureSchema } from "./resume-disclosure.dto";
import { neutralUnavailable } from "../unlocks/unlock-response";
import { ROAD_FALLBACK_FRESHER, roadSnapshot } from "../resume/__fixtures__/general-road";
import type { TradeSheetContext } from "../resume/resume-render-input";
import { PayerTenantScopeService } from "../payers/payer-tenant-scope.service";
import type { PayerOrgsRepository } from "../payers/payer-orgs.repository";
import type {
  ActiveMembershipFacts,
  PayerOrgTenancyMode,
} from "../payers/payer-tenant-scope";

// ADR-0045 Phase 5 — WHAT THE LEAK GUARD SCANS, captured by a PASS-THROUGH wrapper: the guard
// still runs for real on every call, and the context it saw is the evidence that the road was
// merged BEFORE it and that the worker's real name never rode that context.
const guardCalls = vi.hoisted(() => ({ contexts: [] as unknown[] }));
vi.mock("../resume/other-answer-leak-guard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../resume/other-answer-leak-guard")>();
  return {
    ...actual,
    containsOtherAnswerMarker: (value: unknown) => {
      guardCalls.contexts.push(value);
      return actual.containsOtherAnswerMarker(value);
    },
  };
});

const CTX = { correlationId: "corr-1", requestId: "req-1" } as RequestContext;
const PAYER = "11111111-1111-1111-1111-111111111111";
const WORKER = "22222222-2222-2222-2222-222222222222";
const REAL_NAME = "Ramesh Kumar"; // must NEVER appear in event/response
const MASKED = "R***** K.";
const SENTINEL_PHONE = "+919876500000"; // must NEVER appear in events, logs or API
// JSON (B-D/B-E) — but it DOES appear in the disclosed PDF itself since the 2026-09-18
// reversal (asserted below): the PDF is the artifact the payer unlocked, not the spine.
const SIGNED_URL = "https://signed.example/disclosure/abc?token=secret"; // never logged/evented (B-D)

const CONFIG = {
  UNLOCK_MAX_REVEALS_PER_WORKER_PER_DAY: 5,
  UNLOCK_MAX_PAYERS_PER_WORKER_PER_WEEK: 10,
  RESUME_SIGNED_URL_TTL_SECONDS: 900,
} as unknown as ServerConfig;

/**
 * The REAL tenant resolver (ADR-0053) over a fake membership read: `memberships` maps a payer id
 * to its ACTIVE memberships. Default `off` with none — every caller is their own tenant.
 */
function tenancyService(
  mode: PayerOrgTenancyMode = "off",
  memberships: Record<string, ActiveMembershipFacts[]> = {},
): PayerTenantScopeService {
  return new PayerTenantScopeService(
    { PAYER_ORG_TENANCY_MODE: mode } as unknown as ServerConfig,
    {
      listActiveMembershipsWithAnchor: vi.fn(async (id: string) => memberships[id] ?? []),
      ensureSoloOrg: vi.fn(async () => null),
    } as unknown as PayerOrgsRepository,
  );
}

interface SetupOpts {
  consentPurposes?: string[] | null; // null => no consent row
  consentRevoked?: boolean;
  workerExists?: boolean;
  pendingDeletion?: boolean; // ADR-0031: worker inside the deletion grace window
  hasResume?: boolean;
  dailyCount?: number;
  weeklyPayers?: number;
  renderNull?: boolean; // renderPdf degrades to null
  nightShiftReady?: boolean; // #947 — the worker's own toggle, as the column stores it
  // The worker's registered location (owner ruling 2026-09-08), as the plaintext columns store it.
  currentCity?: string | null;
  currentState?: string | null;
  // Makes the trade-attribute read throw, so the degrade around it can be asserted.
  attrThrows?: boolean;
  // Makes the work-history read throw. Since the 2026-09-08 ruling that degrade must stay
  // distinguishable from a worker who filed no jobs.
  empThrows?: boolean;
  existing?: Record<string, unknown>; // existing disclosure row for idempotency
  // The worker's settled pack answers, which the payer DOES see — trade capability is neither
  // identity nor negotiating position.
  tradeSheet?: { packId: string | null; attributes: Record<string, unknown> };
  employments?: WorkerEmploymentRecord[];
  // Zone 5's credentials (0098), which the payer also sees — a certificate is a qualification,
  // not identity or negotiating position.
  qualifications?: {
    certificates: WorkerCertificateRecord[];
    educations: WorkerEducationRecord[];
  };
  /** Layer A (f)/(i) — the declared secondary occupations, as stored role ids. */
  occupations?: string[];
  // 2026-09-18 reversal — the worker's number for the payer copy, as the stored
  // ciphertext (`enc:` prefix: the fake decrypt strips it, like the name). ABSENT by
  // default, which is what keeps every pre-existing test on the old behavior.
  phoneE164?: string | null;
  // Makes the phone decrypt (and only the phone decrypt) throw, for the degrade case.
  phoneDecryptThrows?: boolean;
  // ADR-0045 Phase 5 — the NAME decrypt throws (and only it), for the brief's fail-closed case.
  nameDecryptThrows?: boolean;
  // The disclosed résumé row's template id and snapshot. Default: `classic`, an empty snapshot —
  // every case written before the general road.
  templateId?: string;
  snapshot?: Record<string, unknown>;
  // ADR-0045 Phase 5 — the general road's reader, as the optional last dependency. OMITTED is
  // the reader absent; `"throws"` is a read that escapes it.
  generalRoads?: { answer: { road: "general" } | null } | "throws";
  /** #1898: whether the request's posting context names a `job_postings` row. Default true. */
  postingRowExists?: boolean;
  /** #1899: the posting / job ids each payer OWNS (findOwnedJobRef), keyed by ref id. */
  ownedRefs?: Record<string, { payerId: string; kind: "job" | "posting" }>;
  /** ADR-0053: the tenant resolver the service is built with (default: mode `off`). */
  tenancy?: PayerTenantScopeService;
}

function setup(opts: SetupOpts = {}) {
  const consentPurposes =
    opts.consentPurposes === undefined ? ["employer_sharing"] : opts.consentPurposes;
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
    getWorkerDeletionMarker: vi.fn(async () =>
      workerExists ? { deletionScheduledAt } : undefined,
    ),
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
        ? {
            resumeId: "resume-1",
            sourceProfileSnapshot: opts.snapshot ?? {},
            templateId: opts.templateId ?? "classic",
            version: 1,
          }
        : undefined,
    ),
    markDisclosed: vi.fn(async (_id: string, _input: Record<string, unknown>) => undefined),
    listByPayer: vi.fn(async () => []),
    countDisclosedForPosting: vi.fn(async () => 3),
    countDisclosedForPostings: vi.fn(
      async (_ids: readonly string[], _tenant: string) => new Map<string, number>(),
    ),
    // #1898: a global-pool read, so it lives on the repo only — NOT in txMethods, where a call
    // through the locked `tx` handle would be the pool-vs-lock deadlock shape.
    jobPostingExists: vi.fn(async (_id: string) => opts.postingRowExists ?? true),
    // #1899: the payer-scoped ownership read — also global-pool, also repo-only.
    findOwnedJobRef: vi.fn(async (refId: string, payerId: string) => {
      const owned = opts.ownedRefs?.[refId];
      return owned && owned.payerId === payerId ? { kind: owned.kind, id: refId } : null;
    }),
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
      workerExists
        ? {
            id: WORKER,
            fullName: "enc:" + REAL_NAME,
            phoneE164: opts.phoneE164 ?? null,
            deletionScheduledAt,
            resumeNightShiftReady: opts.nightShiftReady ?? false,
            currentCity: opts.currentCity ?? null,
            currentState: opts.currentState ?? null,
          }
        : undefined,
    ),
  };

  const pii = {
    decrypt: vi.fn((token: string) => {
      if (opts.phoneDecryptThrows && opts.phoneE164 != null && token === opts.phoneE164) {
        throw new Error("bad/rotated key");
      }
      if (opts.nameDecryptThrows && token === "enc:" + REAL_NAME) {
        throw new Error("bad/rotated key");
      }
      return token.replace(/^enc:/, "");
    }),
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

  // The trade capability block — read-only, and it degrades to absence if it throws.
  // exercises that degrade: the failure must cost this section and nothing else on the sheet.
  const attributes = {
    loadTradeSheet: vi.fn(async () => {
      if (opts.attrThrows) throw new Error("attr boom");
      return opts.tradeSheet ?? { packId: null, attributes: {} };
    }),
  };
  // Zone 4 — read-only on the same terms. Empty for every worker today.
  const employments = {
    loadForResume: vi.fn(async () => {
      if (opts.empThrows) throw new Error("employment boom");
      return opts.employments ?? [];
    }),
  };
  // Zone 5 (migration 0098) — read-only, degrades to absence. Empty by default, which
  // `qualificationFactsFrom` turns into `undefined`, so every assertion below sees exactly the
  // masked sheet it saw before this repository existed.
  const qualifications = {
    loadForResume: vi.fn(async () => opts.qualifications ?? { certificates: [], educations: [] }),
  };
  // Layer A (f)/(i) — the declared secondary occupations. Read-only, degrades to absence; empty
  // by default so the "Also works as" row is absent unless a case opts in.
  const occupations = {
    loadForWorker: vi.fn(async () => opts.occupations ?? []),
  };
  const generalRoads =
    opts.generalRoads === undefined
      ? undefined
      : {
          forResume: vi.fn(async (_resume: { id: string; workerId: string }) => {
            if (opts.generalRoads === "throws") throw new Error("road boom " + REAL_NAME);
            return (opts.generalRoads as { answer: { road: "general" } | null }).answer;
          }),
        };

  const service = new ResumeDisclosureService(
    repo as unknown as ResumeDisclosureRepository,
    consents as unknown as ConsentRepository,
    workers as unknown as WorkersRepository,
    pii as unknown as PiiCryptoService,
    renderer as unknown as ResumeRenderer,
    storage as unknown as StorageService,
    attributes as unknown as WorkerAttributesRepository,
    employments as unknown as WorkerEmploymentRepository,
    qualifications as unknown as WorkerQualificationsRepository,
    occupations as never,
    events as unknown as EventsService,
    CONFIG,
    opts.tenancy ?? tenancyService("off"),
    // `tierScopes` — absent here; its own suite covers it.
    undefined,
    generalRoads as never,
  );

  return {
    service,
    repo,
    txMethods,
    consents,
    workers,
    pii,
    renderer,
    storage,
    attributes,
    events,
    emitted,
    generalRoads,
    getRenderInput: () => renderInput,
  };
}

const NEUTRAL = { status: "unavailable" };

describe("ResumeDisclosureService — happy path (B-G masked render + B-E fact-only event)", () => {
  it("grants + discloses: returns the signed URL and renders with MASKED initials", async () => {
    const t = setup();
    const res = await t.service.requestDisclosure(
      { payerId: PAYER, workerId: WORKER, jobPostingId: null },
      CTX,
    );

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
    expect(t.repo.markDisclosed).toHaveBeenCalledWith(
      "disc-1",
      expect.objectContaining({ resumeRef: "resume-1" }),
    );
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
    await t.service.requestDisclosure(
      { payerId: PAYER, workerId: WORKER, jobPostingId: null },
      CTX,
    );
    expect(t.pii.decrypt).toHaveBeenCalledOnce();
  });

  it("#947: the worker's night-shift toggle DOES reach the payer — it is a preference, not identity", async () => {
    // THE AUDIENCE CALL, PINNED HERE BECAUSE THIS IS WHERE IT COULD GO WRONG QUIETLY. The three
    // things this path withholds — the real name (masked two assertions up), the photo
    // (structurally null) and the expected salary — are identity and negotiating position.
    // Willingness to work nights is neither: it is the signal that puts the worker in front of a
    // night-shift posting, and `fromResumeProfile` already settled the same question the same
    // way for the model-extracted `shift`. It crosses only when the worker deliberately ticked
    // it, so the only thing a payer can ever see here is a claim its author actually made.
    const t = setup({ nightShiftReady: true });
    await t.service.requestDisclosure(
      { payerId: PAYER, workerId: WORKER, jobPostingId: null },
      CTX,
    );
    expect(t.getRenderInput()?.availability).toBe("Night shift ke liye taiyaar");
    // The masking around it is untouched — the toggle crossing is not a hole in the gate.
    expect(t.getRenderInput()?.displayName).toBe(MASKED);
    expect(t.getRenderInput()?.photoDataUri).toBeNull();
  });

  it("2026-09-08: the worker's registered location reaches the payer, and the masking holds", async () => {
    // THE AUDIENCE CALL, PINNED HERE FOR THE SAME REASON THE TOGGLE ABOVE IS. A city is on the
    // owner's never-redact list (2026-07-31: "cities as PII → a 20-point matching input"), the
    // Verdict Line has composed one on this copy since the sheet shipped, and a supervisor hires
    // for one plant. The three things this surface withholds stay exactly three.
    const t = setup({ currentCity: "Faridabad", currentState: "Haryana" });
    await t.service.requestDisclosure(
      { payerId: PAYER, workerId: WORKER, jobPostingId: null },
      CTX,
    );
    expect(t.getRenderInput()?.locationLine).toBe("Faridabad, Haryana");
    expect(t.getRenderInput()?.displayName).toBe(MASKED);
    expect(t.getRenderInput()?.photoDataUri).toBeNull();
    expect(t.getRenderInput()?.expectedSalary).toBeNull();
  });

  it("2026-09-08: the location survives a failed trade-attribute load", async () => {
    // The regression this pins. The context is built by MERGING onto whatever `loadTradeSheet`
    // returned, and that call has its own degrade — so a location merged inside one of the
    // conditional blocks would vanish for a worker with no employments and no credentials, or
    // whenever that query threw. It is set unconditionally; this is what says so.
    const t = setup({ attrThrows: true, currentCity: "Rajkot", currentState: null });
    await t.service.requestDisclosure(
      { payerId: PAYER, workerId: WORKER, jobPostingId: null },
      CTX,
    );
    expect(t.getRenderInput()?.locationLine).toBe("Rajkot");
  });

  it("2026-09-08: a failed work-history read does not turn the worker into a fresher", async () => {
    // THE SAME FAIL-CLOSED RULE THE RENDER WORKER HOLDS, asserted separately because this path
    // builds its context by MERGING rather than by constructing it once — and the merge that
    // carries the flag is the one that runs unconditionally. A twelve-year turner whose history
    // could not be read must reach the payer as an unknown tenure, never as a fresher.
    const t = setup({
      empThrows: true,
      tradeSheet: {
        packId: "qp_cnc_turning",
        attributes: { turning_experience: 0, turning_machine: ["cnc_lathe"] },
      },
    });
    await t.service.requestDisclosure(
      { payerId: PAYER, workerId: WORKER, jobPostingId: null },
      CTX,
    );
    // FILL-GAP PHASE 4 changed the SHAPE of the guarantee without weakening it: with no role the
    // whole headline strip is now omitted (`""` here), where it used to print a subject-less
    // system phrase. Both outcomes are pinned: never the word "Fresher", and when a strip DOES
    // print it can only be the licensed unknown-tenure phrasing.
    const line = t.getRenderInput()?.headlineLine ?? "";
    expect(line).not.toMatch(/fresher/i);
    if (line.length > 0) expect(line).toMatch(/duration not stated/i);
  });

  it("the payer DOES see the trade capability block, and the masking around it holds", async () => {
    // THE AUDIENCE DECISION, PINNED. What a worker can do on a machine is trade information and
    // the most decisive thing on the sheet for a hiring supervisor — neither identity nor
    // negotiating position, so it sits with `shift` rather than with the three things this
    // surface withholds. Withholding it would hand the payer a masked sheet whose capability
    // section is empty, which is the disclosure they unlocked in the first place.
    const t = setup({
      tradeSheet: {
        packId: "qp_cnc_turning",
        attributes: { turning_machine: ["cnc_lathe"], tolerance_band: "0.02" },
      },
    });
    await t.service.requestDisclosure(
      { payerId: PAYER, workerId: WORKER, jobPostingId: null },
      CTX,
    );
    expect(t.attributes.loadTradeSheet).toHaveBeenCalledWith(WORKER);
    expect(t.getRenderInput()?.capSectionTitle).toBe("Machines, controllers & capability");
    expect(t.getRenderInput()?.capChipRows).toEqual([
      {
        label: "Machines",
        values: ["CNC lathe / turning centre"],
        key: "turning_machine",
        rank: 21,
      },
    ]);
    expect(t.getRenderInput()?.capFactRows).toEqual([
      { label: "Tolerance held", value: "±0.02 mm", key: "tolerance_band", rank: 62 },
    ]);
    // The three withheld things are still withheld — the capability block is not a hole in the gate.
    expect(t.getRenderInput()?.displayName).toBe(MASKED);
    expect(t.getRenderInput()?.photoDataUri).toBeNull();
    expect(t.getRenderInput()?.expectedSalary).toBeNull();
  });

  it("#947: a worker on the column default has nothing said about them either way", async () => {
    // `notNull().default(false)` means "never answered" and "answered No" are one byte. Printing
    // a No onto a PAYER-facing document would be the worst version of that mistake: a refusal
    // the worker never gave, read by the person deciding whether to call them.
    const t = setup();
    await t.service.requestDisclosure(
      { payerId: PAYER, workerId: WORKER, jobPostingId: null },
      CTX,
    );
    expect(t.getRenderInput()?.availability).toBeNull();
  });
});

describe("2026-09-18 reversal — the worker's number reaches the payer copy", () => {
  // THE AUDIENCE CALL, PINNED HERE BECAUSE THE OLD BEHAVIOR WAS SILENCE. The 2026-08-28
  // ruling said "both copies" but this surface never passed the number, so the employer
  // sheet silently carried no contact line. The 2026-09-18 ruling reverses the
  // withholding (post-unlock only — the consent/cap/deletion gates above are untouched).
  // The worker-copy half is pinned in `resume-render.processor.test.ts` ("decrypts the
  // phone SERVER-SIDE and puts it on the worker's own sheet"); this file pins the payer
  // half. Name/photo/salary/WhatsApp/licence gating is identical — the "three withheld
  // things" assertions above stay green as-is.
  it("the employer render input carries the number, formatted", async () => {
    const t = setup({ phoneE164: "enc:" + SENTINEL_PHONE });
    await t.service.requestDisclosure(
      { payerId: PAYER, workerId: WORKER, jobPostingId: null },
      CTX,
    );
    expect(t.getRenderInput()?.phone).toBe("+91 98765 00000");
    // The masking around it holds — the number crossing is not a hole in the gate.
    expect(t.getRenderInput()?.displayName).toBe(MASKED);
    expect(t.getRenderInput()?.photoDataUri).toBeNull();
    expect(t.getRenderInput()?.expectedSalary).toBeNull();
  });

  it("name and number are each decrypted exactly once (two PII touches, F-5)", async () => {
    // DELIBERATE UPDATE of the old "EXACTLY once" pin two describes up: that test's
    // default setup carries no phoneE164, so it still observes exactly one decrypt and
    // stays green untouched. With a number on file there are two touches — one per
    // secret — and the count below is what keeps a third from arriving quietly.
    const t = setup({ phoneE164: "enc:" + SENTINEL_PHONE });
    await t.service.requestDisclosure(
      { payerId: PAYER, workerId: WORKER, jobPostingId: null },
      CTX,
    );
    expect(t.pii.decrypt).toHaveBeenCalledTimes(2);
  });

  it("withheld-vs-missing parity: absent and undecryptable both collapse to the same null", async () => {
    // A caller holding this input cannot tell "no number on file" from "decrypt
    // failed" — both are the missing line, never a placeholder, an error string, or a
    // partial digit run. Same collapse the worker copy takes (processor test).
    const absent = setup();
    await absent.service.requestDisclosure(
      { payerId: PAYER, workerId: WORKER, jobPostingId: null },
      CTX,
    );
    expect(absent.getRenderInput()?.phone).toBeNull();

    const broken = setup({ phoneE164: "enc:" + SENTINEL_PHONE, phoneDecryptThrows: true });
    await broken.service.requestDisclosure(
      { payerId: PAYER, workerId: WORKER, jobPostingId: null },
      CTX,
    );
    expect(broken.getRenderInput()?.phone).toBeNull();
  });
});

describe("B-D / B-E — no raw PII (name, phone, signed URL) in the event or any log arg", () => {
  it("never passes the real name, phone, or signed URL into events.emit", async () => {
    const t = setup();
    await t.service.requestDisclosure(
      { payerId: PAYER, workerId: WORKER, jobPostingId: null },
      CTX,
    );
    const blob = JSON.stringify(t.emitted);
    expect(blob).not.toContain(REAL_NAME);
    expect(blob).not.toContain("Ramesh");
    expect(blob).not.toContain(SENTINEL_PHONE);
    expect(blob).not.toContain(SIGNED_URL); // the link is RETURNED, never EVENTED (B-D)
  });

  it("the signed URL is returned to the payer but never persisted on the row", async () => {
    const t = setup();
    const res = await t.service.requestDisclosure(
      { payerId: PAYER, workerId: WORKER, jobPostingId: null },
      CTX,
    );
    expect((res as { resume_url: string }).resume_url).toBe(SIGNED_URL);
    // markDisclosed stores only the opaque resume_ref + timestamps — never the URL.
    const markArg = t.repo.markDisclosed.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(JSON.stringify(markArg)).not.toContain(SIGNED_URL);
  });
});

describe("B-A — employer_sharing consent gate (fail closed, no oracle)", () => {
  it("no consent row → neutral; no render, no event", async () => {
    const t = setup({ consentPurposes: null });
    const res = await t.service.requestDisclosure(
      { payerId: PAYER, workerId: WORKER, jobPostingId: null },
      CTX,
    );
    expect(res).toEqual(NEUTRAL);
    expect(t.renderer.renderPdf).not.toHaveBeenCalled();
    expect(t.emitted).toHaveLength(0);
  });

  it("only profiling consent (no employer_sharing) → neutral", async () => {
    const t = setup({ consentPurposes: ["profiling", "resume_generation"] });
    const res = await t.service.requestDisclosure(
      { payerId: PAYER, workerId: WORKER, jobPostingId: null },
      CTX,
    );
    expect(res).toEqual(NEUTRAL);
  });

  it("revoked employer_sharing → neutral", async () => {
    const t = setup({ consentPurposes: ["employer_sharing"], consentRevoked: true });
    const res = await t.service.requestDisclosure(
      { payerId: PAYER, workerId: WORKER, jobPostingId: null },
      CTX,
    );
    expect(res).toEqual(NEUTRAL);
  });

  it("no-consent but worker EXISTS → records an internal denied row (no_consent)", async () => {
    const t = setup({ consentPurposes: null, workerExists: true });
    await t.service.requestDisclosure(
      { payerId: PAYER, workerId: WORKER, jobPostingId: null },
      CTX,
    );
    expect(t.txMethods.insertRow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "denied", denyReason: "no_consent" }),
    );
  });

  it("UNKNOWN worker → NO row written (FK-oracle avoidance) but identical neutral body", async () => {
    const t = setup({ consentPurposes: null, workerExists: false });
    const res = await t.service.requestDisclosure(
      { payerId: PAYER, workerId: WORKER, jobPostingId: null },
      CTX,
    );
    expect(res).toEqual(NEUTRAL);
    expect(t.txMethods.insertRow).not.toHaveBeenCalled();
  });
});

describe("B-B — SHARED per-worker cap (spans unlock reveals + disclosures), atomic", () => {
  it("daily shared ceiling reached → neutral + denied(capped); no render/event", async () => {
    const t = setup({ dailyCount: 5 }); // == UNLOCK_MAX_REVEALS_PER_WORKER_PER_DAY
    const res = await t.service.requestDisclosure(
      { payerId: PAYER, workerId: WORKER, jobPostingId: null },
      CTX,
    );
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
    const res = await t.service.requestDisclosure(
      { payerId: PAYER, workerId: WORKER, jobPostingId: null },
      CTX,
    );
    expect(res).toEqual(NEUTRAL);
  });

  it("takes the worker advisory lock before the cap read (atomicity)", async () => {
    const t = setup();
    await t.service.requestDisclosure(
      { payerId: PAYER, workerId: WORKER, jobPostingId: null },
      CTX,
    );
    expect(t.txMethods.lockWorker).toHaveBeenCalledWith(expect.anything(), WORKER);
  });
});

describe("B-C — single neutral body, byte-identical across every deny branch", () => {
  it("no_consent / capped / no-resume / unknown all return the identical object", async () => {
    const a = await setup({ consentPurposes: null }).service.requestDisclosure(
      { payerId: PAYER, workerId: WORKER, jobPostingId: null },
      CTX,
    );
    const b = await setup({ dailyCount: 5 }).service.requestDisclosure(
      { payerId: PAYER, workerId: WORKER, jobPostingId: null },
      CTX,
    );
    const c = await setup({ hasResume: false }).service.requestDisclosure(
      { payerId: PAYER, workerId: WORKER, jobPostingId: null },
      CTX,
    );
    const d = await setup({ consentPurposes: null, workerExists: false }).service.requestDisclosure(
      { payerId: PAYER, workerId: WORKER, jobPostingId: null },
      CTX,
    );
    expect(a).toEqual(NEUTRAL);
    expect(b).toEqual(NEUTRAL);
    expect(c).toEqual(NEUTRAL);
    expect(d).toEqual(NEUTRAL);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(b)).toBe(JSON.stringify(c));
    expect(JSON.stringify(c)).toBe(JSON.stringify(d));
  });

  it("the deny_reason never crosses the response boundary", async () => {
    const res = await setup({ dailyCount: 5 }).service.requestDisclosure(
      { payerId: PAYER, workerId: WORKER, jobPostingId: null },
      CTX,
    );
    expect(JSON.stringify(res)).not.toContain("capped");
    expect(JSON.stringify(res)).not.toContain("reason");
  });
});

describe("fail-closed render — degrade to neutral, disclose nothing", () => {
  it("renderPdf null (render disabled / WeasyPrint missing) → neutral, no markDisclosed, no event", async () => {
    const t = setup({ renderNull: true });
    const res = await t.service.requestDisclosure(
      { payerId: PAYER, workerId: WORKER, jobPostingId: null },
      CTX,
    );
    expect(res).toEqual(NEUTRAL);
    expect(t.repo.markDisclosed).not.toHaveBeenCalled();
    expect(t.emitted).toHaveLength(0);
  });
});

describe("idempotency — a live disclosed grant is reused, not re-rendered", () => {
  it("existing live 'disclosed' row → re-signs the link; no insert, no render, no new event", async () => {
    const future = new Date(Date.now() + 60_000);
    const t = setup({ existing: { id: "disc-existing", status: "disclosed", expiresAt: future } });
    const res = await t.service.requestDisclosure(
      { payerId: PAYER, workerId: WORKER, jobPostingId: null },
      CTX,
    );
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
    const res = await t.service.requestDisclosure(
      { payerId: PAYER, workerId: WORKER, jobPostingId: null },
      CTX,
    );
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
    const pending = await setup({ pendingDeletion: true }).service.requestDisclosure(
      { payerId: PAYER, workerId: WORKER, jobPostingId: null },
      CTX,
    );
    const noConsent = await setup({ consentPurposes: null }).service.requestDisclosure(
      { payerId: PAYER, workerId: WORKER, jobPostingId: null },
      CTX,
    );
    expect(JSON.stringify(pending)).toBe(JSON.stringify(noConsent));
  });

  it("the in-tx RE-CHECK closes the schedule-vs-disclosure race AND blocks the live-reuse re-mint", async () => {
    const future = new Date(Date.now() + 60_000);
    // Active at the pre-lock read; a LIVE disclosed row exists (the re-mint path).
    const t = setup({ existing: { id: "disc-existing", status: "disclosed", expiresAt: future } });
    // The tx-scoped marker read sees the schedule land after the pre-lock read.
    t.txMethods.getWorkerDeletionMarker.mockResolvedValue({ deletionScheduledAt: new Date() });
    const res = await t.service.requestDisclosure(
      { payerId: PAYER, workerId: WORKER, jobPostingId: null },
      CTX,
    );
    expect(JSON.stringify(res)).toBe(JSON.stringify(neutralUnavailable()));
    // No fresh signed URL is minted during grace (a re-mint IS a new disclosure).
    expect(t.storage.createSignedUrl).not.toHaveBeenCalled();
    expect(t.renderer.renderPdf).not.toHaveBeenCalled();
    expect(t.emitted).toHaveLength(0);
  });
});

/**
 * ADR-0045 PHASE 5 — THE GENERAL ROAD ON THE EMPLOYER'S COPY.
 *
 * R6 puts the worker's own line on BOTH copies, and this copy hides his name: so the line is
 * re-checked here against his CURRENT name (it may have changed since he wrote it) and the money
 * wall, off the SAME single decrypt that derives the mask. A line that fails prints the fixed
 * fallback line — on both copies, which then agree (owner ruling 2026-09-27). The reader degrades
 * like every other load here: a failure is today's sheet, never a failed disclosure.
 */
describe("ADR-0045 — the general road on the employer's copy", () => {
  const OWN = "Ghar aur dukaan ki wiring karta hoon.";
  const REQUEST = { payerId: PAYER, workerId: WORKER, jobPostingId: null };
  const ON_ROAD = { answer: { road: "general" as const } };
  const road = (over: SetupOpts = {}, brief: unknown = { status: "answered", text: OWN }) =>
    setup({
      templateId: "bb_general",
      snapshot: roadSnapshot(),
      tradeSheet: { packId: null, attributes: { profile_brief: brief } },
      generalRoads: ON_ROAD,
      ...over,
    });
  /** The context the leak guard scanned on the latest disclosure. */
  const scanned = () => guardCalls.contexts.at(-1) as TradeSheetContext;

  it("asks about THE DISCLOSED résumé, and prints his own line under a masked name", async () => {
    const t = road();
    const res = await t.service.requestDisclosure(REQUEST, CTX);
    expect(res).toMatchObject({ ok: true, status: "disclosed" });
    expect(t.generalRoads!.forResume).toHaveBeenCalledWith({ id: "resume-1", workerId: WORKER });
    expect(t.getRenderInput()?.profileBrief).toBe(OWN);
    expect(t.getRenderInput()?.displayName).toBe(MASKED);
    expect(t.getRenderInput()?.expectedSalary).toBeNull();
    // MERGED BEFORE THE GUARD, a marker and one verdict — and the real name is nowhere in it.
    expect(scanned().generalRoad).toEqual({ ownBriefUsable: true });
    expect(JSON.stringify(scanned())).not.toContain(REAL_NAME);
    // One PII touch, as before the road: the re-check rides the mask's decrypt.
    expect(t.pii.decrypt).toHaveBeenCalledOnce();
    // The event is exactly what it was: ids only, no brief, no road.
    expect(t.emitted).toHaveLength(1);
    expect(JSON.stringify(t.emitted)).not.toContain(OWN);
  });

  it("a line carrying his CURRENT name prints the fixed line — decrypted exactly once", async () => {
    const t = road({}, { status: "answered", text: "Ramesh bhai ka wiring ka kaam" });
    await t.service.requestDisclosure(REQUEST, CTX);
    expect(t.getRenderInput()?.profileBrief).toBe(ROAD_FALLBACK_FRESHER);
    expect(scanned().generalRoad).toEqual({ ownBriefUsable: false });
    expect(t.pii.decrypt).toHaveBeenCalledOnce();
    expect(JSON.stringify(t.getRenderInput())).not.toContain("Ramesh");
  });

  it("a stored line that talks money prints the fixed line — the figure never reaches the payer", async () => {
    // Saved before the write wall existed, or under a looser build.
    const t = road({}, { status: "answered", text: "Wiring karta hoon, 15000 rupaye chahiye" });
    await t.service.requestDisclosure(REQUEST, CTX);
    expect(t.getRenderInput()?.profileBrief).toBe(ROAD_FALLBACK_FRESHER);
    expect(JSON.stringify(t.getRenderInput())).not.toContain("15000");
  });

  it("a name that could not be decrypted fails every line (fail closed), and still discloses", async () => {
    const t = road({ nameDecryptThrows: true });
    const res = await t.service.requestDisclosure(REQUEST, CTX);
    expect(res).toMatchObject({ ok: true, status: "disclosed" });
    expect(t.getRenderInput()?.profileBrief).toBe(ROAD_FALLBACK_FRESHER);
    expect(t.getRenderInput()?.displayName).toBeNull();
  });

  it("a payer cannot tell a rejected line from a declined one — the two copies are identical", async () => {
    const rejected = road({}, { status: "answered", text: "Ramesh bhai ka wiring ka kaam" });
    await rejected.service.requestDisclosure(REQUEST, CTX);
    const declined = road({}, { status: "declined" });
    await declined.service.requestDisclosure(REQUEST, CTX);
    expect(JSON.stringify(rejected.getRenderInput())).toBe(
      JSON.stringify(declined.getRenderInput()),
    );
  });

  it("sets a clock on EVERY road copy — a fresher's too — before the guard scans it", async () => {
    const t = road();
    await t.service.requestDisclosure(REQUEST, CTX);
    expect(scanned().asOf).toBeInstanceOf(Date);
    // Off the road a fresher's copy keeps today's shape: no clock without an employment.
    const off = road({ generalRoads: { answer: null } });
    await off.service.requestDisclosure(REQUEST, CTX);
    expect(scanned().asOf).toBeUndefined();
    expect("generalRoad" in scanned()).toBe(false);
  });

  it("never asks on another layout, nor on a bb_general row a role pack now draws as bb_trade", async () => {
    const classic = road({ templateId: "classic" });
    await classic.service.requestDisclosure(REQUEST, CTX);
    expect(classic.generalRoads!.forResume).not.toHaveBeenCalled();
    expect(classic.getRenderInput()?.profileBrief).toBeUndefined();

    const upgraded = road({ tradeSheet: { packId: "qp_cnc_turning", attributes: {} } });
    await upgraded.service.requestDisclosure(REQUEST, CTX);
    expect(upgraded.generalRoads!.forResume).not.toHaveBeenCalled();
    // RESOLVED ONCE: the value the gate read is the value the mapper drew with.
    expect(upgraded.getRenderInput()?.templateId).toBe("bb_trade");
  });

  it("is optional, and a reader that says no or THROWS is today's disclosure — never a failed one", async () => {
    for (const generalRoads of [undefined, { answer: null }, "throws" as const]) {
      const t = road({ generalRoads });
      const res = await t.service.requestDisclosure(REQUEST, CTX);
      expect(res, String(generalRoads)).toMatchObject({ ok: true, status: "disclosed" });
      expect(t.getRenderInput()?.profileBrief).toBeUndefined();
      expect("generalRoad" in scanned()).toBe(false);
    }
  });

  it("the throw's warning names the disclosure, never the error's text or the worker's name", async () => {
    const t = road({ generalRoads: "throws" });
    const lines: string[] = [];
    const logger = (t.service as unknown as { logger: { warn: (m: string) => void } }).logger;
    logger.warn = (m: string) => void lines.push(String(m));
    await t.service.requestDisclosure(REQUEST, CTX);
    expect(lines.some((l) => l.includes("general-road provenance for disclosure=disc-1"))).toBe(
      true,
    );
    expect(lines.join("\n")).not.toMatch(/road boom|Ramesh/);
  });
});

describe("#1898 — the posting context is normalised before the lock (FK to job_postings)", () => {
  // `resume_disclosures.job_posting_id` references `job_postings.id`. An agency's applicants page
  // sends its legacy `jobs` id; storing it violated the FK. The #1903 approach: store null for any
  // id that is not a `job_postings` row — on every row AND on the event.
  const AGENCY_JOB = "66666666-6666-4666-8666-666666666666"; // a jobs id: no job_postings row
  const POSTING = "77777777-7777-4777-8777-777777777777"; // a company posting
  const req = (jobPostingId: string | null) => ({ payerId: PAYER, workerId: WORKER, jobPostingId });

  function disclosedPayload(t: ReturnType<typeof setup>): Record<string, unknown> {
    const evt = t.emitted.find(
      (e) => (e as { event_name: string }).event_name === "resume.disclosed",
    ) as { payload: Record<string, unknown> } | undefined;
    expect(evt, "resume.disclosed must be emitted").toBeDefined();
    return evt!.payload;
  }

  it("an agency jobs id DISCLOSES with a null context on the row, the lookup and the event", async () => {
    const t = setup({ postingRowExists: false });
    const res = await t.service.requestDisclosure(req(AGENCY_JOB), CTX);

    expect(res).toMatchObject({ ok: true, status: "disclosed" });
    expect(t.repo.jobPostingExists).toHaveBeenCalledOnce();
    expect(t.repo.jobPostingExists).toHaveBeenCalledWith(AGENCY_JOB);
    expect(t.txMethods.findByPayerWorkerPosting).toHaveBeenCalledWith(
      expect.anything(),
      PAYER,
      WORKER,
      null,
    );
    expect(t.txMethods.insertRow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ jobPostingId: null }),
    );
    expect(disclosedPayload(t).job_posting_id).toBeNull();
    // The jobs id reaches no write and no event.
    expect(JSON.stringify(t.txMethods.insertRow.mock.calls)).not.toContain(AGENCY_JOB);
    expect(JSON.stringify(t.emitted)).not.toContain(AGENCY_JOB);
  });

  it("a deny row (no consent) also stores the null context, never the jobs id", async () => {
    const t = setup({ postingRowExists: false, consentPurposes: [] });
    const res = await t.service.requestDisclosure(req(AGENCY_JOB), CTX);
    expect(res).toEqual(NEUTRAL);
    expect(t.txMethods.insertRow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ jobPostingId: null, status: "denied" }),
    );
    expect(JSON.stringify(t.txMethods.insertRow.mock.calls)).not.toContain(AGENCY_JOB);
  });

  it("a company posting id is KEPT on the row and the event (behaviour unchanged)", async () => {
    const t = setup({ postingRowExists: true });
    await t.service.requestDisclosure(req(POSTING), CTX);
    expect(t.repo.jobPostingExists).toHaveBeenCalledWith(POSTING);
    expect(t.txMethods.insertRow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ jobPostingId: POSTING }),
    );
    expect(disclosedPayload(t).job_posting_id).toBe(POSTING);
  });

  it("a null context stays null and costs no lookup", async () => {
    const t = setup();
    await t.service.requestDisclosure(req(null), CTX);
    expect(t.repo.jobPostingExists).not.toHaveBeenCalled();
    expect(disclosedPayload(t).job_posting_id).toBeNull();
  });

  it("a failed lookup fails the request before any lock, write or event (fail closed)", async () => {
    const t = setup();
    t.repo.jobPostingExists.mockRejectedValueOnce(new Error("connection terminated"));
    await expect(t.service.requestDisclosure(req(POSTING), CTX)).rejects.toThrow(
      "connection terminated",
    );
    expect(t.repo.withTransaction).not.toHaveBeenCalled();
    expect(t.txMethods.insertRow).not.toHaveBeenCalled();
    expect(t.emitted).toHaveLength(0);
  });
});

describe("#1899 — a payer-session posting reference must be null or the payer's own", () => {
  // POST /payer/resume-disclosures passes "payer_owned". Employers own company postings; agents
  // own agency `jobs` rows (sent from their applicants page) and may still own a pre-#1969
  // posting. Ownership is the SESSION payer's id — the role never widens or narrows it.
  const AGENT = "a9e00000-0000-4000-8000-000000000001";
  const EMPLOYER = "e3900000-0000-4000-8000-000000000002";
  const AGENT_JOB = "a9e00000-0000-4000-8000-0000000000a1"; // jobs row, payer_id = AGENT
  const AGENT_OLD_POSTING = "a9e00000-0000-4000-8000-0000000000a2"; // pre-#1969 posting
  const EMPLOYER_POSTING = "e3900000-0000-4000-8000-0000000000e1"; // job_postings, EMPLOYER
  const UNKNOWN = "deadbeef-0000-4000-8000-000000000000";
  const ownedRefs = {
    [AGENT_JOB]: { payerId: AGENT, kind: "job" as const },
    [AGENT_OLD_POSTING]: { payerId: AGENT, kind: "posting" as const },
    [EMPLOYER_POSTING]: { payerId: EMPLOYER, kind: "posting" as const },
  };

  async function discloseAs(payerId: string, jobPostingId: string | null, opts: SetupOpts = {}) {
    const t = setup({ ownedRefs, ...opts });
    const res = await t.service.requestDisclosure(
      { payerId, workerId: WORKER, jobPostingId },
      CTX,
      "payer_owned",
    );
    return { t, res };
  }

  const allowed: { who: string; payer: string; ref: string | null; stored: string | null }[] = [
    { who: "employer · own posting (kept)", payer: EMPLOYER, ref: EMPLOYER_POSTING, stored: EMPLOYER_POSTING },
    { who: "employer · null", payer: EMPLOYER, ref: null, stored: null },
    { who: "agent · own jobs row (stored null)", payer: AGENT, ref: AGENT_JOB, stored: null },
    { who: "agent · own pre-#1969 posting (kept)", payer: AGENT, ref: AGENT_OLD_POSTING, stored: AGENT_OLD_POSTING },
    { who: "agent · null", payer: AGENT, ref: null, stored: null },
  ];

  it.each(allowed)("$who → discloses", async ({ payer, ref, stored }) => {
    const { t, res } = await discloseAs(payer, ref);
    expect(res).toMatchObject({ ok: true, status: "disclosed" });
    expect(t.txMethods.insertRow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ payerId: payer, jobPostingId: stored }),
    );
    if (ref === null) expect(t.repo.findOwnedJobRef).not.toHaveBeenCalled();
    else expect(t.repo.findOwnedJobRef).toHaveBeenCalledWith(ref, payer);
    // The ownership read replaces the #1898 existence read on this route.
    expect(t.repo.jobPostingExists).not.toHaveBeenCalled();
  });

  const refused: { who: string; payer: string; ref: string }[] = [
    { who: "agent · employer's posting (foreign)", payer: AGENT, ref: EMPLOYER_POSTING },
    { who: "agent · unknown id", payer: AGENT, ref: UNKNOWN },
    { who: "employer · agent's jobs row (foreign)", payer: EMPLOYER, ref: AGENT_JOB },
    { who: "employer · agent's posting (foreign)", payer: EMPLOYER, ref: AGENT_OLD_POSTING },
    { who: "employer · unknown id", payer: EMPLOYER, ref: UNKNOWN },
  ];

  it.each(refused)("$who → the neutral body, and nothing is read, written or emitted", async ({ payer, ref }) => {
    const { t, res } = await discloseAs(payer, ref);
    expect(res).toEqual(NEUTRAL);
    expect(t.repo.findOwnedJobRef).toHaveBeenCalledWith(ref, payer);
    expect(t.consents.findLatestByWorker).not.toHaveBeenCalled();
    expect(t.repo.withTransaction).not.toHaveBeenCalled();
    expect(t.txMethods.insertRow).not.toHaveBeenCalled();
    expect(t.renderer.renderPdf).not.toHaveBeenCalled();
    expect(t.emitted).toHaveLength(0);
  });

  it("unknown vs foreign vs an existing deny (no consent) are byte-identical (no id oracle)", async () => {
    const foreign = (await discloseAs(AGENT, EMPLOYER_POSTING)).res;
    const unknown = (await discloseAs(AGENT, UNKNOWN)).res;
    const noConsent = (await discloseAs(AGENT, AGENT_JOB, { consentPurposes: null })).res;
    expect(JSON.stringify(foreign)).toBe(JSON.stringify(unknown));
    expect(JSON.stringify(unknown)).toBe(JSON.stringify(noConsent));
  });

  it("an ownership read error fails closed before any lock, write or event", async () => {
    const t = setup({ ownedRefs });
    t.repo.findOwnedJobRef.mockRejectedValueOnce(new Error("connection terminated"));
    await expect(
      t.service.requestDisclosure(
        { payerId: EMPLOYER, workerId: WORKER, jobPostingId: EMPLOYER_POSTING },
        CTX,
        "payer_owned",
      ),
    ).rejects.toThrow("connection terminated");
    expect(t.repo.withTransaction).not.toHaveBeenCalled();
    expect(t.emitted).toHaveLength(0);
  });

  it("the ops default ('normalise') is unchanged: no ownership read, an unknown id stores null", async () => {
    const t = setup({ ownedRefs, postingRowExists: false });
    const res = await t.service.requestDisclosure(
      { payerId: AGENT, workerId: WORKER, jobPostingId: UNKNOWN },
      CTX,
    );
    expect(res).toMatchObject({ ok: true, status: "disclosed" });
    expect(t.repo.findOwnedJobRef).not.toHaveBeenCalled();
    expect(t.txMethods.insertRow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ jobPostingId: null }),
    );
  });
});

// ---------------------------------------------------------------------------------------------
// ADR-0053 (PAY-DB-01) Phase 2b — disclosures belong to the ORG; the event names the actor.
// ---------------------------------------------------------------------------------------------

describe("ResumeDisclosureService — ADR-0053 org tenancy", () => {
  const ANCHOR = PAYER; // A — the org's founder
  const MEMBER = "33333333-3333-4333-8333-333333333333"; // B — an active recruiter in A's org
  const OUTSIDER = "55555555-5555-4555-8555-555555555555"; // C — a solo payer
  const POSTING = "77777777-7777-4777-8777-777777777777";

  const facts = (anchor: string, orgRole: "owner" | "recruiter"): ActiveMembershipFacts => ({
    orgId: `0${anchor.slice(1)}`,
    orgRole,
    acceptedAt: new Date(orgRole === "owner" ? "2026-05-01" : "2026-07-01"),
    orgStatus: "active",
    anchorPayerId: anchor,
    anchorRole: "employer",
    anchorStatus: "active",
    memberRole: "employer",
  });
  const MEMBERSHIPS: Record<string, ActiveMembershipFacts[]> = {
    [ANCHOR]: [facts(ANCHOR, "owner")],
    [MEMBER]: [facts(MEMBER, "owner"), facts(ANCHOR, "recruiter")],
    [OUTSIDER]: [facts(OUTSIDER, "owner")],
  };
  const on = () => tenancyService("on", MEMBERSHIPS);
  const off = () => tenancyService("off", MEMBERSHIPS);

  type Emitted = { event_name: string; actor: { actor_id: string }; payload: { payer_id: string } };

  it("on: a teammate's disclosure is read and stamped under the ORG key; resume.disclosed names the teammate and the org", async () => {
    const tenancy = on();
    const resolve = vi.spyOn(tenancy, "resolve");
    const t = setup({ tenancy });
    const out = await t.service.requestDisclosure(
      { payerId: MEMBER, workerId: WORKER, jobPostingId: null },
      CTX,
    );
    expect(out).toMatchObject({ ok: true, status: "disclosed" });
    expect(t.txMethods.findByPayerWorkerPosting).toHaveBeenCalledWith(
      expect.anything(),
      ANCHOR,
      WORKER,
      null,
    );
    expect(t.txMethods.insertRow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ payerId: ANCHOR, status: "granted" }),
    );
    const ev = t.emitted[0] as Emitted;
    expect(ev.event_name).toBe("resume.disclosed");
    expect(ev.actor.actor_id).toBe(MEMBER);
    expect(ev.payload.payer_id).toBe(ANCHOR);
    // ONE resolution for the whole request, at its entry point (review L-1).
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith(MEMBER);
  });

  it("off: the same teammate is keyed to themself, and the event names them twice — identical to before", async () => {
    const t = setup({ tenancy: off() });
    await t.service.requestDisclosure({ payerId: MEMBER, workerId: WORKER, jobPostingId: null }, CTX);
    expect(t.txMethods.insertRow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ payerId: MEMBER }),
    );
    const ev = t.emitted[0] as Emitted;
    expect(ev.actor.actor_id).toBe(MEMBER);
    expect(ev.payload.payer_id).toBe(MEMBER);
  });

  it("on: a deny row (no consent) is stamped under the ORG key too", async () => {
    const t = setup({ tenancy: on(), consentPurposes: ["profiling"] });
    expect(
      await t.service.requestDisclosure(
        { payerId: MEMBER, workerId: WORKER, jobPostingId: null },
        CTX,
      ),
    ).toEqual(NEUTRAL);
    expect(t.txMethods.insertRow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ payerId: ANCHOR, status: "denied", denyReason: "no_consent" }),
    );
  });

  it("on: the payer-session posting context must be the ORG's — a teammate may use it, an outsider is refused", async () => {
    const ownedRefs = { [POSTING]: { payerId: ANCHOR, kind: "posting" as const } };
    const mine = setup({ tenancy: on(), ownedRefs });
    const granted = await mine.service.requestDisclosure(
      { payerId: MEMBER, workerId: WORKER, jobPostingId: POSTING },
      CTX,
      "payer_owned",
    );
    expect(granted).toMatchObject({ ok: true });
    expect(mine.txMethods.insertRow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ payerId: ANCHOR, jobPostingId: POSTING }),
    );

    const foreign = setup({ tenancy: on(), ownedRefs });
    expect(
      await foreign.service.requestDisclosure(
        { payerId: OUTSIDER, workerId: WORKER, jobPostingId: POSTING },
        CTX,
        "payer_owned",
      ),
    ).toEqual(NEUTRAL);
    expect(foreign.repo.withTransaction).not.toHaveBeenCalled();
    expect(foreign.emitted).toEqual([]);
  });

  it("on: the disclosure list and the per-posting count are the ORG's", async () => {
    const tenancy = on();
    const resolve = vi.spyOn(tenancy, "resolve");
    const t = setup({ tenancy });
    await t.service.listByPayer(MEMBER);
    expect(t.repo.listByPayer).toHaveBeenCalledWith(ANCHOR);
    expect(resolve).toHaveBeenCalledTimes(1); // one resolution per entry point (review L-1)
    // The single-posting count reads in the scope its caller resolved — it never resolves.
    const scope = await tenancy.resolve(MEMBER);
    resolve.mockClear();
    expect(await t.service.countDownloadsForPostingInScope(POSTING, scope)).toBe(3);
    expect(t.repo.countDisclosedForPosting).toHaveBeenCalledWith(POSTING, ANCHOR);
    expect(resolve).not.toHaveBeenCalled();

    const solo = setup({ tenancy: on() });
    await solo.service.listByPayer(OUTSIDER);
    expect(solo.repo.listByPayer).toHaveBeenCalledWith(OUTSIDER);
  });

  it("on: the postings page's download counts are ONE grouped read in the caller's scope (no resolution of their own); unknown ids read 0", async () => {
    const tenancy = on();
    const t = setup({ tenancy });
    const scope = await tenancy.resolve(MEMBER);
    const resolve = vi.spyOn(tenancy, "resolve"); // spied AFTER the caller's one resolution
    const OTHER = "88888888-8888-4888-8888-888888888888";
    t.repo.countDisclosedForPostings.mockResolvedValueOnce(new Map([[POSTING, 4]]));
    const counts = await t.service.countDownloadsInScope([POSTING, OTHER], scope);
    expect(counts).toEqual(
      new Map([
        [POSTING, 4],
        [OTHER, 0],
      ]),
    );
    expect(t.repo.countDisclosedForPostings).toHaveBeenCalledTimes(1);
    expect(t.repo.countDisclosedForPostings).toHaveBeenCalledWith([POSTING, OTHER], ANCHOR);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("on: a refused tenancy is the resolver's 403 before any read, write or event", async () => {
    const t = setup({
      tenancy: tenancyService("on", {
        [MEMBER]: [...MEMBERSHIPS[MEMBER]!, facts("66666666-6666-4666-8666-666666666666", "recruiter")],
      }),
    });
    await expect(
      t.service.requestDisclosure({ payerId: MEMBER, workerId: WORKER, jobPostingId: null }, CTX),
    ).rejects.toMatchObject({ status: 403 });
    expect(t.consents.findLatestByWorker).not.toHaveBeenCalled();
    expect(t.repo.withTransaction).not.toHaveBeenCalled();
    expect(t.emitted).toEqual([]);
  });
});
