import "reflect-metadata";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import type { Job } from "bullmq";
import type { ServerConfig } from "@badabhai/config";
import { ResumeRenderProcessor } from "./resume-render.processor";
import type { ResumeRenderInput } from "./resume-renderer.service";
import type { ResumeRepository } from "./resume.repository";
import type { WorkersRepository } from "../workers/workers.repository";
import type { PiiCryptoService } from "../common/pii-crypto.service";
import type { ResumeRenderer } from "./resume-renderer.service";
import type { StorageService } from "../storage/storage.service";
import type { WorkerAttributesRepository } from "../profiles/worker-attributes.repository";
import type { WorkerEmploymentRepository } from "../profiles/worker-employment.repository";
import type { WorkerQualificationsRepository } from "../profiles/worker-qualifications.repository";
import type { WorkerTranscriptRepository } from "../profiles/worker-transcript.repository";
import type { WorkerEmploymentRecord } from "./resume-employment-rows";
import type { WorkerCertificateRecord, WorkerEducationRecord } from "./resume-qualification-rows";
import type { ResumeRenderJobData } from "../queue/queue.constants";

const RESUME_ID = "res-1";
const WORKER_ID = "w-1";
const REAL_NAME = "Asha Kumari";
const NAME_TOKEN = "v1.ciphertext";
const PHONE_TOKEN = "v1.phone-ciphertext";
const REAL_PHONE = "+91 98765 43210";

// A valid (name-free) DraftProfile snapshot. The name lives nowhere in here.
// Uses PROPER taxonomy IDs (skill_*, mach_*) so labelForTaxonomyId resolution is tested.
const SNAPSHOT = {
  canonical_role_id: "role_vmc_operator",
  canonical_trade_id: "dom_vmc_machining",
  skills: ["skill_fanuc", "skill_milling"],
  machines: ["mach_vmc", "mach_cnc_lathe"],
  experience: { total_years: 5, summary: "5 years on Fanuc" },
};

const PDF = Buffer.from("%PDF-1.7 fake bytes");

function makeJob(
  over: {
    attemptsMade?: number;
    attempts?: number;
    force?: boolean;
    failClosed?: boolean;
  } = {},
): Job<ResumeRenderJobData> {
  return {
    data: {
      resumeId: RESUME_ID,
      workerId: WORKER_ID,
      ...(over.force === undefined ? {} : { force: over.force }),
      ...(over.failClosed === undefined ? {} : { failClosed: over.failClosed }),
      correlationId: "c",
      requestId: "r",
    },
    attemptsMade: over.attemptsMade ?? 0,
    opts: { attempts: over.attempts ?? 3 },
  } as unknown as Job<ResumeRenderJobData>;
}

const DEFAULT_ROW = {
  id: RESUME_ID,
  workerId: WORKER_ID,
  version: 1,
  renderStatus: "pending",
  sourceProfileSnapshot: SNAPSHOT,
};

function setup(
  opts: {
    // Pass `null` to simulate a missing row; omit to use the default pending row.
    resume?: Record<string, unknown> | null;
    fullName?: string | null;
    decryptThrows?: boolean;
    renderResult?: Buffer | null;
    renderThrows?: boolean;
    renderEnabled?: boolean;
    // #947 — the worker's own "Night shift ke liye taiyaar" toggle, as the column stores it.
    // Undefined here means the column DEFAULT, which is what nearly every real row holds.
    nightShiftReady?: boolean;
    // The worker's settled pack answers, and the failure mode of reading them.
    tradeSheet?: { packId: string | null; attributes: Record<string, unknown> };
    attrThrows?: boolean;
    // `null` simulates a worker row with no phone ciphertext; omit for the normal case.
    phoneToken?: string | null;
    // Zone 4 — seeded `worker_employment` rows, and the failure mode of reading them.
    employments?: WorkerEmploymentRecord[];
    empThrows?: boolean;
    // Zone 5 (0098) — seeded credentials, and the failure mode of reading them.
    qualifications?: {
      certificates: WorkerCertificateRecord[];
      educations: WorkerEducationRecord[];
    };
    qualThrows?: boolean;
    // R8 §2/§4 — the worker's own turns, and the failure mode of reading them.
    workerSaid?: string[];
    transcriptThrows?: boolean;
  } = {},
) {
  const resumeRow = opts.resume === undefined ? DEFAULT_ROW : (opts.resume ?? undefined);

  const resumes = {
    findById: vi.fn(async () => resumeRow),
    markRendered: vi.fn(async () => undefined),
    markRenderFailed: vi.fn(async () => undefined),
  };
  const workers = {
    findById: vi.fn(async () => ({
      id: WORKER_ID,
      fullName: opts.fullName ?? null,
      phoneE164: opts.phoneToken === undefined ? PHONE_TOKEN : opts.phoneToken,
      resumeNightShiftReady: opts.nightShiftReady ?? false,
    })),
  };
  const pii = {
    decrypt: vi.fn((token: string) => {
      if (opts.decryptThrows) throw new Error("GCM auth failed");
      return token === PHONE_TOKEN ? REAL_PHONE : REAL_NAME;
    }),
  };
  const renderer = {
    renderPdf: vi.fn(async (_input: ResumeRenderInput): Promise<Buffer | null> => {
      if (opts.renderThrows) throw new Error("spawn boom");
      return opts.renderResult === undefined ? PDF : opts.renderResult;
    }),
    buildResumeHtml: vi.fn((_input: ResumeRenderInput) => "<html></html>"),
  };
  const storage = { uploadPdf: vi.fn(async () => undefined) };
  // The trade capability block. `attrThrows` exercises the degrade: a failed attribute read must
  // cost the worker the section, never the whole PDF.
  const attributes = {
    loadTradeSheet: vi.fn(async () => {
      if (opts.attrThrows) throw new Error("attr boom");
      return opts.tradeSheet ?? { packId: null, attributes: {} };
    }),
  };
  // Zone 4. `empThrows` exercises the same degrade the attribute read has: a failed history read
  // must cost the worker the employer blocks, never the whole PDF.
  const employments = {
    loadForResume: vi.fn(async () => {
      if (opts.empThrows) throw new Error("employment boom");
      return opts.employments ?? [];
    }),
  };
  // Zone 5 (migration 0098). Same degrade contract again: a failed credential read must cost the
  // Education and Certificates rows, never the PDF. Empty by default, which is `undefined` after
  // `qualificationFactsFrom` — i.e. no override, and every assertion below sees exactly the sheet
  // it saw before this repository existed.
  const qualifications = {
    loadForResume: vi.fn(async () => {
      if (opts.qualThrows) throw new Error("qualification boom");
      return opts.qualifications ?? { certificates: [], educations: [] };
    }),
  };
  // R8 §2/§4. Same degrade contract as the two reads above: a failed transcript load must cost
  // the quote block and the veto, never the PDF.
  const transcript = {
    loadWorkerTurns: vi.fn(async () => {
      if (opts.transcriptThrows) throw new Error("transcript boom");
      return opts.workerSaid ?? [];
    }),
  };
  const config = {
    RESUME_RENDER_ENABLED: opts.renderEnabled ?? true,
  } as ServerConfig;

  const proc = new ResumeRenderProcessor(
    resumes as unknown as ResumeRepository,
    workers as unknown as WorkersRepository,
    pii as unknown as PiiCryptoService,
    renderer as unknown as ResumeRenderer,
    storage as unknown as StorageService,
    attributes as unknown as WorkerAttributesRepository,
    employments as unknown as WorkerEmploymentRepository,
    qualifications as unknown as WorkerQualificationsRepository,
    transcript as unknown as WorkerTranscriptRepository,
    // #1350 — a pass-through by default. These tests are about the render lifecycle, and the
    // polish is off unless WORK_HISTORY_POLISH_ENABLED is set; its own behaviour has its own
    // suite. Returning the records unchanged is exactly what the disabled path does.
    { polish: async (_w: string, r: unknown) => r } as never,
    config,
  );
  return { proc, resumes, workers, pii, renderer, storage, attributes, employments, transcript };
}

/**
 * #947 — THE WIRING, which is the half of the fix `resume-render-input.test.ts` cannot see.
 *
 * The mapper composes the line correctly whatever it is handed; these two assert that what it
 * is HANDED is the worker's actual column and not a hardcoded literal. That is the failure mode
 * #947 asks to be protected against for good ("value must never be dropped in future") — a
 * silent `false` at the call site looks exactly like a worker who never set the toggle.
 */
describe("ResumeRenderProcessor — the worker's night-shift toggle (#947)", () => {
  it("reads the toggle off the worker row and puts it on the worker's own PDF", async () => {
    // The snapshot mentions no shift and no availability, which is the point: before this the
    // toggle had no route onto the page, so `{{availability}}` rendered empty for a worker who
    // had explicitly said they would work nights. No extra query — this is the same row already
    // fetched for the name and the photo.
    const { proc, renderer } = setup({ fullName: NAME_TOKEN, nightShiftReady: true });
    await proc.process(makeJob());
    expect(renderer.renderPdf.mock.calls[0]![0].availability).toBe("Night shift ke liye taiyaar");
  });

  it("says nothing at all for a worker still on the column default", async () => {
    // `resume_night_shift_ready` is `notNull().default(false)`, so this row is indistinguishable
    // from one whose owner answered No — and it is what every worker who has never opened the
    // Edit-Resume screen carries. Their PDF must not acquire a refusal they never gave.
    const { proc, renderer } = setup({ fullName: NAME_TOKEN });
    expect(renderer.renderPdf).not.toHaveBeenCalled();
    await proc.process(makeJob());
    expect(renderer.renderPdf.mock.calls[0]![0].availability).toBeNull();
  });
});

/**
 * THE TRADE CAPABILITY BLOCK — the wiring, not the mapping.
 *
 * `trade-resume-map.test.ts` proves the dictionary turns slugs into English. These prove the
 * values REACH it: before this, `worker_attributes` was written by every interview and read by
 * nothing, so the `bb_trade` sheet's first and most-scanned section rendered empty for every
 * worker while the data sat in Postgres.
 */
describe("ResumeRenderProcessor — the trade capability block", () => {
  it("reads the worker's pack answers and puts them on the sheet", async () => {
    const { proc, renderer, attributes } = setup({
      fullName: NAME_TOKEN,
      tradeSheet: {
        packId: "qp_cnc_turning",
        attributes: { turning_machine: ["cnc_lathe"], controller_brand: ["fanuc"] },
      },
    });
    await proc.process(makeJob());
    expect(attributes.loadTradeSheet).toHaveBeenCalledWith(WORKER_ID);
    const input = renderer.renderPdf.mock.calls[0]![0];
    expect(input.capSectionTitle).toBe("Machines, controllers & capability");
    expect(input.capChipRows).toEqual([
      {
        label: "Machines",
        values: ["CNC lathe / turning centre"],
        key: "turning_machine",
        rank: 21,
      },
      { label: "Controllers", values: ["Fanuc"], key: "controller_brand", rank: 22 },
    ]);
  });

  it("renders the PDF anyway when the attribute read THROWS", async () => {
    // A capability section is worth having; it is not worth a worker losing their resume over.
    // Same degrade the photo fetch and the name decrypt already take, and for the same reason.
    const { proc, renderer, storage } = setup({ fullName: NAME_TOKEN, attrThrows: true });
    const res = await proc.process(makeJob());
    expect(res).toEqual({ rendered: true });
    expect(storage.uploadPdf).toHaveBeenCalledOnce();
    const input = renderer.renderPdf.mock.calls[0]![0];
    expect(input.capSectionTitle).toBeNull();
    expect(input.capChipRows).toEqual([]);
  });

  it("leaves the section absent for a worker with no pack answers", async () => {
    // The common case today: 140-odd trades have no map, and every profile predating the role
    // packs has no attributes. The section must collapse, not print an empty heading.
    const { proc, renderer } = setup({ fullName: NAME_TOKEN });
    await proc.process(makeJob());
    const input = renderer.renderPdf.mock.calls[0]![0];
    expect(input.capSectionTitle).toBeNull();
    expect([...input.capChipRows!, ...input.capTickRows!, ...input.capFactRows!]).toEqual([]);
  });
});

/**
 * THE SHEET'S IDENTITY AND FOOTER SLOTS. Every one of these is a thing a supervisor holds in
 * their hand: the number they ring, the code they quote back, the square they scan. All of them
 * degrade to absence and none of them may cost the worker a render.
 */
describe("ResumeRenderProcessor — the bb_trade footer and identity slots", () => {
  it("decrypts the phone SERVER-SIDE and puts it on the worker's own sheet", async () => {
    const { proc, pii, renderer } = setup({ fullName: NAME_TOKEN });
    await proc.process(makeJob());
    expect(pii.decrypt).toHaveBeenCalledWith(PHONE_TOKEN);
    expect(renderer.renderPdf.mock.calls[0]![0].phone).toBe(REAL_PHONE);
  });

  it("renders without a phone rather than failing when the row has none", async () => {
    const { proc, renderer } = setup({ fullName: NAME_TOKEN, phoneToken: null });
    const res = await proc.process(makeJob());
    expect(res).toEqual({ rendered: true });
    expect(renderer.renderPdf.mock.calls[0]![0].phone).toBeNull();
  });

  it("embeds the QR as a self-contained data: URI — never a network reference", async () => {
    // WeasyPrint blocks on a remote fetch. A URL here would hang or silently blank the footer.
    const { proc, renderer } = setup({ fullName: NAME_TOKEN });
    await proc.process(makeJob());
    const input = renderer.renderPdf.mock.calls[0]![0];
    expect(input.qrDataUri).toMatch(/^data:image\/svg\+xml,/);
    expect(input.shortLink).toBe("badabhai.ai");
  });

  it("stamps a footer carrying the date and a stable ref code", async () => {
    const { proc, renderer } = setup({ fullName: NAME_TOKEN });
    await proc.process(makeJob());
    const meta = renderer.renderPdf.mock.calls[0]![0].footerMeta!;
    expect(meta).toMatch(/^Generated \d{1,2} \w+ \d{4}/);
    expect(meta).toMatch(/Ref [ACDEFGHJKLMNPQRTUVWXY34679]{6}$/);
    // No verification tier exists yet, so the badge collapses rather than printing a warning.
    expect(renderer.renderPdf.mock.calls[0]![0].trustBadge).toBeNull();
    expect(meta).not.toMatch(/·\s*·/);
  });
});

describe("ResumeRenderProcessor — security (TD5)", () => {
  it("decrypts the name SERVER-SIDE and feeds it to the renderer as displayName", async () => {
    const { proc, pii, renderer } = setup({ fullName: NAME_TOKEN });
    await proc.process(makeJob());
    expect(pii.decrypt).toHaveBeenCalledWith(NAME_TOKEN);
    const input = renderer.renderPdf.mock.calls[0]![0];
    expect(input.displayName).toBe(REAL_NAME);
  });

  it("emits NO event on render completion (success path)", async () => {
    // The processor has no EventsService dependency by design — assert that the
    // success path completes purely via repo/storage, never via events.
    const { proc, resumes, storage } = setup({ fullName: NAME_TOKEN });
    const res = await proc.process(makeJob());
    expect(res).toEqual({ rendered: true });
    expect(storage.uploadPdf).toHaveBeenCalledOnce();
    expect(resumes.markRendered).toHaveBeenCalledOnce();
  });

  it("never references EventsService (no events.emit reachable from this processor)", () => {
    // Static guard: a future refactor that wires events into the render processor would break the
    // 'render emits no event' guarantee. The constructor arity must stay at exactly the
    // NON-EVENT deps, currently eleven:
    //   resumes · workers · pii · renderer · storage · attributes · employments · qualifications
    //   · transcript · polish · config
    // `attributes` (WorkerAttributesRepository) joined in 2026-08-28 for the trade sheet's
    // capability block, and `employments` (WorkerEmploymentRepository) the same day for Zone 4.
    // `transcript` (WorkerTranscriptRepository) joined for R8 §2/§4 — the worker's own turns,
    // which §8.4's quote block and the over-claim veto both read. All three are read-only
    // repositories, none with an event surface.
    //
    // `polish` (WorkHistoryPolishService) joined for #1350 — the owner ruling that lets the
    // model rephrase a work-history description. It reaches AiService and
    // WorkerEmploymentRepository; NEITHER has an event surface, which is the property this
    // test actually protects and which was checked before the number below was bumped.
    //
    // `qualifications` (WorkerQualificationsRepository) joined for migration 0098 — Zone 5's
    // Education and Certificates rows, the second of which had never had a writer. Its ONLY
    // dependency is the @Global DATABASE; it holds no ciphertext and reaches no service, so it
    // has no event surface either. Checked before the number below was bumped, exactly as the
    // three above were.
    //
    // ARITY ALONE IS A PROXY, so the real property is asserted directly below it: a number can be
    // bumped to make this pass while wiring in exactly the dependency it exists to keep out.
    expect(ResumeRenderProcessor.length).toBe(11);
    const source = readFileSync(join(__dirname, "resume-render.processor.ts"), "utf8");
    expect(source, "an events dependency reached the render processor").not.toMatch(
      /EventsService|events\.emit/,
    );
  });

  it("degrades to a name-less render WITHOUT throwing when decrypt fails", async () => {
    const { proc, renderer, storage } = setup({ fullName: NAME_TOKEN, decryptThrows: true });
    // Must NOT throw despite the tampered/rotated token.
    const res = await proc.process(makeJob());
    expect(res).toEqual({ rendered: true });
    const input = renderer.renderPdf.mock.calls[0]![0];
    expect(input.displayName).toBeNull(); // name-less fallback
    expect(storage.uploadPdf).toHaveBeenCalledOnce();
  });

  it("never logs the token or the real name (decrypt-failure path)", async () => {
    const { proc } = setup({ fullName: NAME_TOKEN, decryptThrows: true });

    // Capture every line the processor's instance Logger writes.
    const lines: string[] = [];
    const instLogger = (
      proc as unknown as { logger: { warn: (m: string) => void; log: (m: string) => void } }
    ).logger;
    instLogger.warn = (m: string) => void lines.push(String(m));
    instLogger.log = (m: string) => void lines.push(String(m));

    await proc.process(makeJob());

    const joined = lines.join("\n");
    expect(joined).not.toContain(NAME_TOKEN);
    expect(joined).not.toContain(REAL_NAME);
  });
});

describe("ResumeRenderProcessor — lifecycle (TD5)", () => {
  it("idempotent: skips when renderStatus is already 'rendered'", async () => {
    const { proc, renderer, storage, resumes } = setup({
      resume: {
        id: RESUME_ID,
        workerId: WORKER_ID,
        version: 1,
        renderStatus: "rendered",
        sourceProfileSnapshot: SNAPSHOT,
      },
    });
    const res = await proc.process(makeJob());
    expect(res).toEqual({ rendered: true });
    expect(renderer.renderPdf).not.toHaveBeenCalled();
    expect(storage.uploadPdf).not.toHaveBeenCalled();
    expect(resumes.markRendered).not.toHaveBeenCalled();
  });

  // TD77 — `force` is what lets a photo added AFTER the first render reach the PDF.
  it("force: RE-renders an already-'rendered' resume, in place (same version + key)", async () => {
    const { proc, renderer, storage, resumes } = setup({
      resume: {
        id: RESUME_ID,
        workerId: WORKER_ID,
        version: 1,
        renderStatus: "rendered",
        sourceProfileSnapshot: SNAPSHOT,
      },
    });
    const res = await proc.process(makeJob({ force: true }));

    expect(res).toEqual({ rendered: true });
    expect(renderer.renderPdf).toHaveBeenCalledTimes(1);
    // Overwrites the SAME object key — no new version is minted, so the existing
    // PDF stays downloadable until the fresh one lands (no 409 window).
    expect(storage.uploadPdf).toHaveBeenCalledWith(
      `resumes/${WORKER_ID}/${RESUME_ID}/v1.pdf`,
      expect.anything(),
    );
    expect(resumes.markRendered).toHaveBeenCalledWith(
      RESUME_ID,
      `resumes/${WORKER_ID}/${RESUME_ID}/v1.pdf`,
      // The re-render replaces the document too: a forced re-render that left the previous
      // document in place would leave the app screen describing the PDF it just overwrote.
      expect.objectContaining({ format: expect.any(String) }),
    );
  });

  // TD77 REGRESSION — the forced re-render must never be able to take a working
  // resume away. `force` is the only path that re-processes an already-'rendered'
  // row, so without these guards a photo change + a render/upload hiccup would flip
  // the row to 'failed' and 409 a resume that downloaded fine a second earlier.
  it("force + render fails: KEEPS the existing rendered PDF (never marks it failed)", async () => {
    const { proc, resumes } = setup({
      resume: {
        id: RESUME_ID,
        workerId: WORKER_ID,
        version: 1,
        renderStatus: "rendered",
        sourceProfileSnapshot: SNAPSHOT,
      },
      renderResult: null, // WeasyPrint hiccup on the forced re-render
    });
    const res = await proc.process(makeJob({ force: true, attemptsMade: 2, attempts: 3 }));

    expect(res).toEqual({ rendered: false });
    // The row must STAY 'rendered' — the old PDF is still valid + downloadable.
    expect(resumes.markRenderFailed).not.toHaveBeenCalled();
  });

  it("force + upload fails on the final attempt: KEEPS the existing rendered PDF", async () => {
    const { proc, resumes, storage } = setup({
      resume: {
        id: RESUME_ID,
        workerId: WORKER_ID,
        version: 1,
        renderStatus: "rendered",
        sourceProfileSnapshot: SNAPSHOT,
      },
    });
    storage.uploadPdf = vi.fn(async () => {
      throw new Error("storage upload failed with status 500");
    });
    const res = await proc.process(makeJob({ force: true, attemptsMade: 2, attempts: 3 }));

    expect(res).toEqual({ rendered: false });
    expect(resumes.markRenderFailed).not.toHaveBeenCalled();
  });

  it("force + failClosed (photo REMOVED) + render fails: marks failed rather than serve the erased face", async () => {
    // §2/DPDP: the existing PDF still embeds the face the worker just erased, so
    // degrading open here would keep SERVING removed PII. A 409 is the honest cost.
    const { proc, resumes } = setup({
      resume: {
        id: RESUME_ID,
        workerId: WORKER_ID,
        version: 1,
        renderStatus: "rendered",
        sourceProfileSnapshot: SNAPSHOT,
      },
      renderResult: null,
    });
    const res = await proc.process(
      makeJob({ force: true, failClosed: true, attemptsMade: 2, attempts: 3 }),
    );

    expect(res).toEqual({ rendered: false });
    expect(resumes.markRenderFailed).toHaveBeenCalledWith(RESUME_ID);
  });

  it("force + failClosed + the RENDER KILL-SWITCH OFF: STILL marks failed (erasure outranks the kill-switch)", async () => {
    // REGRESSION (PR #402 review, High): the kill-switch branch used to be tested
    // BEFORE the failClosed branch, so with RESUME_RENDER_ENABLED=false the row was
    // left untouched — i.e. still 'rendered' — and the download gate happily kept
    // serving the PDF embedding the face the worker had just erased. It never
    // self-healed either: a later DELETE /workers/me/photo skips the re-render once
    // show_photo is already off. When we CANNOT re-render the face off the PDF, taking
    // it out of service matters MORE, not less.
    const { proc, resumes } = setup({
      resume: {
        id: RESUME_ID,
        workerId: WORKER_ID,
        version: 1,
        renderStatus: "rendered",
        sourceProfileSnapshot: SNAPSHOT,
      },
      renderResult: null,
      renderEnabled: false,
    });
    const res = await proc.process(
      makeJob({ force: true, failClosed: true, attemptsMade: 2, attempts: 3 }),
    );

    expect(res).toEqual({ rendered: false });
    expect(resumes.markRenderFailed).toHaveBeenCalledWith(RESUME_ID);
  });

  it("failClosed on a NOT-yet-rendered row + kill-switch OFF: stays pending, NOT failed", async () => {
    // Guard the fix above: `failClosed` outranks the kill-switch only when a PDF
    // actually exists to keep serving. With nothing rendered there is no face to
    // erase, so the kill-switch steady state must survive — leave the row pending so
    // it renders once rendering is switched back on, rather than 409ing it forever.
    const { proc, resumes } = setup({ renderResult: null, renderEnabled: false });
    await proc.process(makeJob({ force: true, failClosed: true, attemptsMade: 2, attempts: 3 }));
    expect(resumes.markRenderFailed).not.toHaveBeenCalled();
  });

  it("a FIRST render (not forced) that fails IS still marked failed (unchanged)", async () => {
    // Guard the guard: the wasRendered exemption must not swallow a genuine
    // first-render failure on a pending row.
    const { proc, resumes } = setup({ renderResult: null });
    await proc.process(makeJob({ attemptsMade: 2, attempts: 3 }));
    expect(resumes.markRenderFailed).toHaveBeenCalledWith(RESUME_ID);
  });

  it("force:false is still idempotent (only an explicit force overrides the skip)", async () => {
    const { proc, renderer } = setup({
      resume: {
        id: RESUME_ID,
        workerId: WORKER_ID,
        version: 1,
        renderStatus: "rendered",
        sourceProfileSnapshot: SNAPSHOT,
      },
    });
    const res = await proc.process(makeJob({ force: false }));
    expect(res).toEqual({ rendered: true });
    expect(renderer.renderPdf).not.toHaveBeenCalled();
  });

  it("no-ops (no throw) when the resume row is missing", async () => {
    const { proc, renderer } = setup({ resume: null });
    const res = await proc.process(makeJob());
    expect(res).toEqual({ rendered: false });
    expect(renderer.renderPdf).not.toHaveBeenCalled();
  });

  it("on success uploads + markRendered with key resumes/{worker}/{resume}/v{version}.pdf", async () => {
    const { proc, storage, resumes } = setup({
      fullName: NAME_TOKEN,
      resume: {
        id: RESUME_ID,
        workerId: WORKER_ID,
        version: 3,
        renderStatus: "pending",
        sourceProfileSnapshot: SNAPSHOT,
      },
    });
    await proc.process(makeJob());
    const expectedKey = `resumes/${WORKER_ID}/${RESUME_ID}/v3.pdf`;
    expect(storage.uploadPdf).toHaveBeenCalledWith(expectedKey, PDF);
    expect(resumes.markRendered).toHaveBeenCalledWith(
      RESUME_ID,
      expectedKey,
      // ONE WRITE. The document and the PDF describe the same render, so a row that says
      // 'rendered' can never carry the previous render's document.
      expect.objectContaining({ format: expect.any(String) }),
    );
  });

  it("renderer returning null: stays PENDING (not failed) when render is DISABLED, even on final attempt", async () => {
    const { proc, resumes } = setup({ renderResult: null, renderEnabled: false });
    const res = await proc.process(makeJob({ attemptsMade: 2, attempts: 3 })); // final attempt
    expect(res).toEqual({ rendered: false });
    expect(resumes.markRenderFailed).not.toHaveBeenCalled();
  });

  it("renderer returning null on a NON-final attempt: stays pending, not marked failed", async () => {
    const { proc, resumes } = setup({ renderResult: null, renderEnabled: true });
    const res = await proc.process(makeJob({ attemptsMade: 0, attempts: 3 }));
    expect(res).toEqual({ rendered: false });
    expect(resumes.markRenderFailed).not.toHaveBeenCalled();
  });

  it("renderer returning null on the FINAL attempt (render enabled): marks failed exactly once", async () => {
    const { proc, resumes } = setup({ renderResult: null, renderEnabled: true });
    const res = await proc.process(makeJob({ attemptsMade: 2, attempts: 3 }));
    expect(res).toEqual({ rendered: false });
    expect(resumes.markRenderFailed).toHaveBeenCalledOnce();
    expect(resumes.markRenderFailed).toHaveBeenCalledWith(RESUME_ID);
  });

  it("renderer THROWING degrades to no-PDF (treated as null), does not bubble", async () => {
    const { proc, resumes, storage } = setup({ renderThrows: true, renderEnabled: true });
    const res = await proc.process(makeJob({ attemptsMade: 2, attempts: 3 }));
    expect(res).toEqual({ rendered: false });
    expect(storage.uploadPdf).not.toHaveBeenCalled();
    expect(resumes.markRenderFailed).toHaveBeenCalledOnce(); // final attempt, render enabled
  });
});
