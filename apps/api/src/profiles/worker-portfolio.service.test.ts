import "reflect-metadata";
import { ServiceUnavailableException, NotFoundException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import type { ServerConfig } from "@badabhai/config";

import type { RequestContext } from "../common/request-context";
import { PortfolioUploadUrlSchema, SetMyPortfolioSchema } from "./worker-portfolio.dto";
import { WorkerPortfolioService } from "./worker-portfolio.service";

const WORKER = "11111111-1111-4111-8111-111111111111";
const CTX = { correlationId: "corr", requestId: "req" } as RequestContext;
const KEY = `portfolio/${WORKER}/3c4d5e6f-3333-4333-8333-000000000003.jpg`;

function setup(opts: { bucket?: string; rows?: Record<string, unknown>[] } = {}) {
  const replaceForWorker = vi.fn(
    async (
      _workerId: string,
      items: readonly { kind: string; storageKey: string | null; url: string | null }[],
    ) => ({ itemsWritten: items.length, replacedExisting: false }),
  );
  const loadForWorker = vi.fn(async (_workerId: string) => opts.rows ?? []);
  const findById = vi.fn(async (_id: string) => ({ id: WORKER }));
  const emit = vi.fn(async (_event: unknown) => undefined);
  const storage = {
    createSignedUploadUrl: vi.fn(async (_key: string, _bucket?: string) => ({
      url: "https://storage.example/signed-upload",
      expiresIn: 7200,
    })),
    createSignedUrl: vi.fn(
      async (_key: string, _ttl: number, _bucket?: string) => "https://storage.example/signed-read",
    ),
  };
  const config = { WORKER_PORTFOLIO_BUCKET: opts.bucket ?? "" } as ServerConfig;
  const svc = new WorkerPortfolioService(
    { replaceForWorker, loadForWorker } as never,
    { findById } as never,
    { emit } as never,
    storage as never,
    config,
  );
  return { svc, replaceForWorker, loadForWorker, emit, storage };
}

const parse = (body: unknown) => SetMyPortfolioSchema.parse(body);

describe("WorkerPortfolioService.replaceForWorker (Layer A (e))", () => {
  it("replaces the list, keeping the submitted order, and emits counts only", async () => {
    const h = setup();
    const res = await h.svc.replaceForWorker(
      WORKER,
      parse({
        items: [
          { kind: "link", url: "https://youtu.be/abc123", caption: "Meri welding clip" },
          { kind: "photo", storage_key: KEY },
        ],
      }),
      CTX,
    );
    expect(res).toEqual({ worker_id: WORKER, item_count: 2 });
    expect(h.replaceForWorker).toHaveBeenCalledWith(WORKER, [
      {
        kind: "link",
        storageKey: null,
        url: "https://youtu.be/abc123",
        caption: "Meri welding clip",
      },
      { kind: "photo", storageKey: KEY, url: null, caption: null },
    ]);
    const event = h.emit.mock.calls[0]![0] as { event_name: string; payload: unknown };
    expect(event.event_name).toBe("worker.portfolio_recorded");
    expect(event.payload).toEqual({ worker_id: WORKER, item_count: 2, replaced_existing: false });
    expect(JSON.stringify(event)).not.toContain("youtu.be");
    expect(JSON.stringify(event)).not.toContain("Meri");
  });

  it("REFUSES a storage key this server did not mint for this worker", async () => {
    const h = setup();
    await expect(
      h.svc.replaceForWorker(
        WORKER,
        parse({ items: [{ kind: "photo", storage_key: "portfolio/someone-else/key.jpg" }] }),
        CTX,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(h.replaceForWorker).not.toHaveBeenCalled();
    expect(h.emit).not.toHaveBeenCalled();
  });

  it("an empty list is a real answer — it clears the rows", async () => {
    const h = setup();
    await h.svc.replaceForWorker(WORKER, parse({ items: [] }), CTX);
    expect(h.replaceForWorker).toHaveBeenCalledWith(WORKER, []);
    const event = h.emit.mock.calls[0]![0] as { payload: unknown };
    expect(event.payload).toMatchObject({ item_count: 0 });
  });
});

describe("WorkerPortfolioService.createUploadUrl", () => {
  it("503s while the bucket is dormant — the shipped contract", async () => {
    const h = setup({ bucket: "" });
    await expect(
      h.svc.createUploadUrl(
        WORKER,
        PortfolioUploadUrlSchema.parse({ kind: "photo", content_type: "image/jpeg" }),
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it("mints a server-chosen key under the worker's own prefix", async () => {
    const h = setup({ bucket: "worker-portfolio" });
    const res = await h.svc.createUploadUrl(
      WORKER,
      PortfolioUploadUrlSchema.parse({ kind: "photo", content_type: "image/jpeg" }),
    );
    expect(res.storage_key).toMatch(new RegExp(`^portfolio/${WORKER}/[0-9a-f-]{36}\\.jpg$`));
    expect(h.storage.createSignedUploadUrl).toHaveBeenCalledWith(
      res.storage_key,
      "worker-portfolio",
    );
  });

  it("refuses a video declared as an image", async () => {
    const h = setup({ bucket: "worker-portfolio" });
    await expect(
      h.svc.createUploadUrl(
        WORKER,
        PortfolioUploadUrlSchema.parse({ kind: "video", content_type: "image/jpeg" }),
      ),
    ).rejects.toThrow();
  });
});

describe("WorkerPortfolioService.getForWorker", () => {
  it("signs media keys and returns link URLs raw", async () => {
    const h = setup({
      bucket: "worker-portfolio",
      rows: [
        { kind: "photo", storageKey: KEY, url: null, caption: "Meri lathe" },
        { kind: "link", storageKey: null, url: "https://drive.google.com/x", caption: null },
      ],
    });
    const res = await h.svc.getForWorker(WORKER);
    expect(res.items).toEqual([
      { kind: "photo", url: "https://storage.example/signed-read", caption: "Meri lathe" },
      { kind: "link", url: "https://drive.google.com/x", caption: null },
    ]);
  });

  it("returns media unlinked (url null) when the bucket is dormant — never a crash", async () => {
    const h = setup({
      bucket: "",
      rows: [{ kind: "video", storageKey: KEY, url: null, caption: null }],
    });
    const res = await h.svc.getForWorker(WORKER);
    expect(res.items).toEqual([{ kind: "video", url: null, caption: null }]);
  });
});
