import "reflect-metadata";
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
import type { ResumeRenderJobData } from "../queue/queue.constants";

const RESUME_ID = "res-1";
const WORKER_ID = "w-1";
const REAL_NAME = "Asha Kumari";
const NAME_TOKEN = "v1.ciphertext";

// A valid (name-free) DraftProfile snapshot. The name lives nowhere in here.
const SNAPSHOT = {
  canonical_role_id: "vmc_operator",
  skills: ["fanuc"],
  machines: ["VMC"],
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

function setup(opts: {
  // Pass `null` to simulate a missing row; omit to use the default pending row.
  resume?: Record<string, unknown> | null;
  fullName?: string | null;
  decryptThrows?: boolean;
  renderResult?: Buffer | null;
  renderThrows?: boolean;
  renderEnabled?: boolean;
} = {}) {
  const resumeRow = opts.resume === undefined ? DEFAULT_ROW : opts.resume ?? undefined;

  const resumes = {
    findById: vi.fn(async () => resumeRow),
    markRendered: vi.fn(async () => undefined),
    markRenderFailed: vi.fn(async () => undefined),
  };
  const workers = {
    findById: vi.fn(async () => ({ id: WORKER_ID, fullName: opts.fullName ?? null })),
  };
  const pii = {
    decrypt: vi.fn(() => {
      if (opts.decryptThrows) throw new Error("GCM auth failed");
      return REAL_NAME;
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
  const config = {
    RESUME_RENDER_ENABLED: opts.renderEnabled ?? true,
  } as ServerConfig;

  const proc = new ResumeRenderProcessor(
    resumes as unknown as ResumeRepository,
    workers as unknown as WorkersRepository,
    pii as unknown as PiiCryptoService,
    renderer as unknown as ResumeRenderer,
    storage as unknown as StorageService,
    config,
  );
  return { proc, resumes, workers, pii, renderer, storage };
}

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
    // Static guard: a future refactor that wires events into the render processor
    // would break the 'render emits no event' guarantee. The constructor arity must
    // stay at exactly the six non-event deps.
    expect(ResumeRenderProcessor.length).toBe(6);
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
    expect(resumes.markRendered).toHaveBeenCalledWith(RESUME_ID, expectedKey);
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
