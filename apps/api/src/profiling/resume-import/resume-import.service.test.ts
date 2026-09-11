import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { ResumeImportService } from "./resume-import.service";
import type { ResumeImportRepository } from "./resume-import.repository";
import type { EventsService } from "../../events/events.service";
import type { StorageService } from "../../storage/storage.service";
import type { RequestContext } from "../../common/request-context";

const CTX = { correlationId: "c", requestId: "r" } as RequestContext;
const WORKER = "11111111-1111-4111-8111-111111111111";
const OTHER = "99999999-9999-4999-8999-999999999999";
const UUID = "abcdef01-2345-4678-8901-234567890abc";
const KEY = `resume-uploads/${WORKER}/${UUID}.pdf`;

const BUCKET = "worker-resume-uploads";
const PDF = "application/pdf";

function setup(configOverrides: Partial<ServerConfig> = {}) {
  const imports = {
    create: vi.fn(async (i: Record<string, unknown>) => ({
      id: "import-1",
      status: "uploaded",
      route: null,
      formKind: null,
      failureReason: null,
      ...i,
    })),
    findForWorker: vi.fn(async () => undefined as Record<string, unknown> | undefined),
    findLatestForWorker: vi.fn(async () => undefined as Record<string, unknown> | undefined),
    findByStorageKey: vi.fn(async () => undefined as Record<string, unknown> | undefined),
  };
  const events = {
    emit: vi.fn(async (p: { event_name: string; payload: Record<string, unknown> }) => p),
  };
  const storage = {
    createSignedUploadUrl: vi.fn(async () => ({
      url: "https://supabase.example/storage/v1/object/upload/sign/resume-uploads/k?token=t",
      expiresIn: 7200,
    })),
    // Defaults to "a policy-clean PDF really is there". Tests that care override explicitly.
    getObjectInfo: vi.fn(async () => ({ contentType: PDF, sizeBytes: 84_213 })),
    deletePdf: vi.fn(async () => undefined),
  };
  const config = {
    RESUME_UPLOADS_BUCKET: BUCKET,
    RESUME_UPLOAD_MAX_BYTES: 10 * 1024 * 1024,
    ...configOverrides,
  } as ServerConfig;
  // ADR-0041 RI-4 — the parse queue the confirm path enqueues onto. A spy, because what these
  // tests assert is the CONFIRM's behaviour; that the enqueue happened is asserted directly.
  const parseQueue = { add: vi.fn(async () => ({ id: "job-1" })) };
  const svc = new ResumeImportService(
    imports as unknown as ResumeImportRepository,
    events as unknown as EventsService,
    storage as unknown as StorageService,
    config,
    parseQueue as never,
  );
  return { parseQueue, svc, imports, events, storage };
}

describe("ResumeImportService — dormancy covers EVERY door, not just the mint", () => {
  // THE #1245 LESSON, PAID FOR ON THE VOICE SEAM. There, only `createUploadUrl` read the
  // bucket, so with it unset a client could still POST the confirm and register durable rows
  // describing audio that had nowhere to live — and everything downstream treated those rows as
  // real. Both write doors are asserted here because "off" has to mean off at every one.
  it("503s the mint while the bucket is unset", async () => {
    const { svc } = setup({ RESUME_UPLOADS_BUCKET: "" } as Partial<ServerConfig>);
    await expect(svc.createUploadUrl(WORKER, { mime: PDF })).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it("503s the confirm while the bucket is unset — a valid key is not enough", async () => {
    const { svc, imports } = setup({ RESUME_UPLOADS_BUCKET: "" } as Partial<ServerConfig>);
    await expect(svc.confirm(WORKER, { storage_path: KEY }, CTX)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(imports.create).not.toHaveBeenCalled();
  });

  it("still serves the READ route while dormant — withdrawal must not hide a worker's own data", async () => {
    // `VoiceController`'s reasoning, and it holds here: a read that processes nothing must not
    // be gated on the processing switch, or a worker loses sight of his own upload the moment
    // the feature is turned off.
    const { svc, imports } = setup({ RESUME_UPLOADS_BUCKET: "" } as Partial<ServerConfig>);
    imports.findForWorker.mockResolvedValueOnce({
      id: "import-1",
      status: "uploaded",
      route: null,
      formKind: null,
      failureReason: null,
    });
    await expect(svc.get(WORKER, "import-1")).resolves.toMatchObject({ status: "uploaded" });
  });
});

describe("ResumeImportService — the minted key is checked, never trusted", () => {
  it("mints a server-chosen key under the caller's own prefix", async () => {
    const { svc, storage } = setup();
    const res = await svc.createUploadUrl(WORKER, { mime: PDF });
    expect(res.storage_path).toMatch(
      new RegExp(`^resume-uploads/${WORKER}/[0-9a-f-]{36}\\.pdf$`),
    );
    expect(storage.createSignedUploadUrl).toHaveBeenCalledWith(res.storage_path, BUCKET);
  });

  it("maps each accepted mime onto its own extension", async () => {
    const { svc } = setup();
    const cases: [string, string][] = [
      [PDF, "pdf"],
      ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"],
      ["image/jpeg", "jpg"],
      ["image/png", "png"],
    ];
    for (const [mime, ext] of cases) {
      const res = await svc.createUploadUrl(WORKER, {
        mime: mime as "application/pdf",
      });
      expect(res.storage_path.endsWith(`.${ext}`)).toBe(true);
    }
  });

  it("REFUSES a forged key WITHOUT touching storage — no existence oracle", async () => {
    // THE ORDER OF THE CHECKS IS THE SECURITY ARGUMENT. The shape test runs before any storage
    // call, so a caller probing another worker's prefix learns nothing about what is stored
    // there. If these two were reversed, the 400-vs-400 timing and the storage call itself
    // would answer a question the caller has no business asking.
    const { svc, storage, imports } = setup();
    const forged = [
      `resume-uploads/${OTHER}/${UUID}.pdf`, // another worker's prefix
      `resume-uploads/${WORKER}/../${OTHER}/${UUID}.pdf`, // traversal
      `resume-uploads/${WORKER}/${UUID}.pdf.exe`, // suffix smuggling
      `resume-uploads/${WORKER}/${UUID}.svg`, // extension outside the closed set
      `resume-uploads/${WORKER}/nested/${UUID}.pdf`, // nested path
      `resume-uploads/${WORKER}/not-a-uuid.pdf`, // free text in the key
      `photos/${WORKER}/${UUID}.pdf`, // right worker, wrong feature's bucket prefix
    ];
    for (const storage_path of forged) {
      await expect(svc.confirm(WORKER, { storage_path }, CTX)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    }
    expect(storage.getObjectInfo).not.toHaveBeenCalled();
    expect(imports.create).not.toHaveBeenCalled();
  });
});

describe("ResumeImportService — the OBJECT is measured, the client's word is not", () => {
  it("registers a policy-clean object and emits a PII-free event", async () => {
    const { svc, imports, events } = setup();
    await svc.confirm(WORKER, { storage_path: KEY }, CTX);

    // The row records what STORAGE said, not what the client declared at mint time.
    expect(imports.create).toHaveBeenCalledWith(
      expect.objectContaining({ workerId: WORKER, storageKey: KEY, mime: PDF, byteSize: 84_213 }),
    );

    const emitted = events.emit.mock.calls[0]?.[0];
    expect(emitted?.event_name).toBe("profile.resume_imported");
    // No filename, no key, no URL. Workers name these files after themselves, so a filename is
    // a full name arriving on the spine through a field nobody would think to review.
    expect(JSON.stringify(emitted?.payload)).not.toContain("resume-uploads");
    expect(Object.keys(emitted?.payload ?? {}).sort()).toEqual([
      "byte_size",
      "import_id",
      "mime",
      "worker_id",
    ]);
  });

  it("REFUSES an object whose real mime is not in the allowlist, and deletes it", async () => {
    // The signed URL cannot constrain what the client actually PUTs. A worker who declared a
    // PDF and uploaded markup is refused HERE, on the object's real content type, and the bytes
    // are removed rather than left in a private bucket behind an unreferenced key.
    const { svc, storage, imports } = setup();
    storage.getObjectInfo.mockResolvedValueOnce({ contentType: "text/html", sizeBytes: 12 });
    await expect(svc.confirm(WORKER, { storage_path: KEY }, CTX)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(storage.deletePdf).toHaveBeenCalledWith(KEY, BUCKET);
    expect(imports.create).not.toHaveBeenCalled();
  });

  it("REFUSES an oversized object, and deletes it", async () => {
    const { svc, storage, imports } = setup();
    storage.getObjectInfo.mockResolvedValueOnce({
      contentType: PDF,
      sizeBytes: 10 * 1024 * 1024 + 1,
    });
    await expect(svc.confirm(WORKER, { storage_path: KEY }, CTX)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(storage.deletePdf).toHaveBeenCalledWith(KEY, BUCKET);
    expect(imports.create).not.toHaveBeenCalled();
  });

  it("FAILS CLOSED on absent metadata — a PII class is never guessed at", async () => {
    // `getObjectInfo` returning null means "storage could not tell us what this is". Treating
    // that as acceptable would register a row for an object of unknown type and unknown size.
    const { svc, storage, imports } = setup();
    storage.getObjectInfo.mockResolvedValueOnce(
      null as unknown as { contentType: string; sizeBytes: number },
    );
    await expect(svc.confirm(WORKER, { storage_path: KEY }, CTX)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(imports.create).not.toHaveBeenCalled();
  });

  it("a cleanup failure does not mask the 400", async () => {
    // The object is unreferenced either way and stays prefix-sweepable on account deletion.
    // Swallowing the 400 to report a delete failure would tell the worker his upload succeeded.
    const { svc, storage } = setup();
    storage.getObjectInfo.mockResolvedValueOnce({ contentType: "text/html", sizeBytes: 12 });
    storage.deletePdf.mockRejectedValueOnce(new Error("storage down"));
    await expect(svc.confirm(WORKER, { storage_path: KEY }, CTX)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe("ResumeImportService — retries and ownership", () => {
  it("is idempotent per key: a retried confirm returns the original row, not a 500", async () => {
    // The workers this is built for are on weak connections. A client that PUTs, loses our
    // response and retries is the ORDINARY case; colliding with the unique index and 500ing
    // would show him a failure for an upload that actually succeeded.
    const { svc, imports, events } = setup();
    imports.findByStorageKey.mockResolvedValueOnce({
      id: "import-1",
      workerId: WORKER,
      status: "uploaded",
      route: null,
      formKind: null,
      failureReason: null,
    });
    const res = await svc.confirm(WORKER, { storage_path: KEY }, CTX);
    expect(res).toMatchObject({ import_id: "import-1", status: "uploaded" });
    expect(imports.create).not.toHaveBeenCalled();
    // And no SECOND event for one physical upload.
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("404s another worker's import — and does not distinguish it from a missing one", async () => {
    const { svc, imports } = setup();
    imports.findForWorker.mockResolvedValueOnce(undefined);
    await expect(svc.get(WORKER, "someone-elses")).rejects.toBeInstanceOf(NotFoundException);
    expect(imports.findForWorker).toHaveBeenCalledWith("someone-elses", WORKER);
  });

  it("never returns the storage key on the wire", async () => {
    // The client already has it — the mint handed it over — so echoing it back buys nothing,
    // and a response field is a thing that ends up in a client log or a crash report.
    const { svc } = setup();
    const res = await svc.confirm(WORKER, { storage_path: KEY }, CTX);
    expect(JSON.stringify(res)).not.toContain("resume-uploads");
    expect(JSON.stringify(res)).not.toContain(WORKER);
  });
});

describe("ResumeImportService — the reading happens off the request path (RI-4)", () => {
  it("a confirmed upload ENQUEUES the parse, carrying refs and the tracing pair only", async () => {
    const { svc, parseQueue } = setup();
    await svc.confirm(WORKER, { storage_path: KEY }, CTX);

    expect(parseQueue.add).toHaveBeenCalledTimes(1);
    const [, payload] = parseQueue.add.mock.calls[0]! as unknown as [string, Record<string, unknown>];
    expect(payload).toEqual({
      importId: "import-1",
      workerId: WORKER,
      correlationId: CTX.correlationId,
      requestId: CTX.requestId,
    });
    // NOTHING ABOUT THE DOCUMENT SITS IN REDIS. No storage key, no mime, no byte size — the
    // processor loads the row itself, which is also what makes the job safe to retry.
    expect(Object.keys(payload).sort()).toEqual([
      "correlationId",
      "importId",
      "requestId",
      "workerId",
    ]);
  });

  it("a queue outage does NOT fail the confirm — the upload really did succeed", async () => {
    // Turning a Redis outage into a 500 here would tell a worker his upload failed when the
    // object is stored, the row is registered and the event is emitted. He would re-upload a
    // document we already hold. The import simply stays at `uploaded` and he continues in chat.
    const { svc, parseQueue, imports, events } = setup();
    parseQueue.add.mockRejectedValueOnce(new Error("redis unreachable"));

    const result = await svc.confirm(WORKER, { storage_path: KEY }, CTX);

    expect(result).toBeDefined();
    expect(imports.create).toHaveBeenCalledTimes(1);
    expect(events.emit).toHaveBeenCalledTimes(1);
  });

  it("a RETRIED confirm does not enqueue a second reading of the same document", async () => {
    // The row already exists, so the early return fires before the enqueue. A second job would pay
    // for a second model call on one document — the duplicate charge `markParsing` exists to
    // stop, caught one layer earlier and for free.
    const { svc, parseQueue, imports } = setup();
    imports.findByStorageKey.mockResolvedValueOnce({
      id: "existing",
      workerId: WORKER,
      status: "uploaded",
      storageKey: KEY,
      mime: "application/pdf",
      byteSize: 1000,
    });

    await svc.confirm(WORKER, { storage_path: KEY }, CTX);
    expect(parseQueue.add).not.toHaveBeenCalled();
  });
});
