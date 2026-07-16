import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { InterviewKitService } from "./interview-kit.service";
import type { StorageService } from "../storage/storage.service";
import type { InterviewKitRenderer } from "./interview-kit-renderer.service";
import type { EventsService } from "../events/events.service";
import type { RequestContext } from "../common/request-context";

const CTX = { correlationId: "c", requestId: "r" } as RequestContext;
const PDF = Buffer.from("%PDF kit");

function setup(opts: { exists?: boolean; renderResult?: Buffer | null } = {}) {
  const storage = {
    objectExists: vi.fn(async (_key: string, _bucket?: string) => opts.exists ?? false),
    uploadPdf: vi.fn(async (_key: string, _bytes: Buffer, _bucket?: string) => undefined),
    createSignedUrl: vi.fn(
      async (_key: string, _ttl: number, _bucket?: string) => "https://signed.example/kit.pdf?token=x",
    ),
  };
  const renderer = {
    renderPdf: vi.fn(async () => (opts.renderResult === undefined ? PDF : opts.renderResult)),
  };
  const events = {
    emit: vi.fn(async (p: { event_name: string; payload: Record<string, unknown> }) => p),
  };
  const config = {
    INTERVIEW_KIT_BUCKET: "interview-kits",
    INTERVIEW_KIT_CONTENT_VERSION: 1,
    RESUME_SIGNED_URL_TTL_SECONDS: 900,
  } as ServerConfig;

  const svc = new InterviewKitService(
    config,
    storage as unknown as StorageService,
    renderer as unknown as InterviewKitRenderer,
    events as unknown as EventsService,
  );
  return { svc, storage, renderer, events };
}

function emitted(events: { emit: ReturnType<typeof vi.fn> }, name: string) {
  return events.emit.mock.calls.map((c) => c[0]).find((p) => p.event_name === name);
}

describe("InterviewKitService — render-once (Task 4)", () => {
  it("404s for an unknown trade", async () => {
    const { svc } = setup();
    await expect(svc.getDownload("not_a_trade", CTX)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("first request: renders, uploads, emits render_completed + downloaded(cache_hit=false)", async () => {
    const { svc, storage, renderer, events } = setup({ exists: false });
    const out = await svc.getDownload("cnc_operator", CTX, { source: "worker_app" });

    expect(renderer.renderPdf).toHaveBeenCalledOnce();
    expect(storage.uploadPdf).toHaveBeenCalledOnce();
    // Stored privately under the deterministic key + version.
    const [key, , bucket] = storage.uploadPdf.mock.calls[0]!;
    expect(key).toBe("interview-kits/cnc_operator/v1/interview-kit.pdf");
    expect(bucket).toBe("interview-kits");

    expect(emitted(events, "interview_kit.render_completed")).toBeTruthy();
    const dl = emitted(events, "interview_kit.downloaded");
    expect(dl!.payload.cache_hit).toBe(false);
    expect(out.cache_hit).toBe(false);
    expect(out.kit_id).toBe("cnc_operator:v1");
    expect(out.url).toContain("https://");
  });

  it("second request: reuses the stored file (no render, no upload), downloaded(cache_hit=true)", async () => {
    const { svc, storage, renderer, events } = setup({ exists: true });
    const out = await svc.getDownload("cnc_operator", CTX);

    expect(renderer.renderPdf).not.toHaveBeenCalled();
    expect(storage.uploadPdf).not.toHaveBeenCalled();
    expect(emitted(events, "interview_kit.render_completed")).toBeUndefined();
    expect(emitted(events, "interview_kit.downloaded")!.payload.cache_hit).toBe(true);
    expect(out.cache_hit).toBe(true);
  });

  it("503s + emits render_failed when rendering is unavailable and no cache exists", async () => {
    const { svc, storage, events } = setup({ exists: false, renderResult: null });
    await expect(svc.getDownload("vmc_operator", CTX)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(storage.uploadPdf).not.toHaveBeenCalled();
    expect(emitted(events, "interview_kit.render_failed")).toBeTruthy();
    expect(emitted(events, "interview_kit.downloaded")).toBeUndefined();
  });

  it("emits PII-FREE payloads (no worker id / name; only trade + version + kit id)", async () => {
    const { svc, events } = setup({ exists: true });
    await svc.getDownload("cad_designer", CTX, { source: "web" });
    const dl = emitted(events, "interview_kit.downloaded")!;
    expect(Object.keys(dl.payload).sort()).toEqual(
      ["cache_hit", "content_version", "kit_id", "source", "trade_key"].sort(),
    );
    expect(JSON.stringify(dl.payload)).not.toMatch(/worker|name|phone/i);
  });
});

describe("InterviewKitService — WA-5: storage failures map to 503, never 500", () => {
  // The regression: StorageService throws PLAIN Errors (not HttpExceptions) when
  // storage is unconfigured / Supabase non-2xx / timeout. Before WA-5 these escaped
  // getDownload unhandled → Nest default filter → 500. The contract is 404/429/503.

  it("503s (ServiceUnavailableException) when storage is UNCONFIGURED (objectExists throws)", async () => {
    const { svc, storage, events } = setup();
    storage.objectExists.mockRejectedValueOnce(
      new Error("Supabase Storage is not configured (SUPABASE_URL / SERVICE_ROLE_KEY)"),
    );
    const err = await svc.getDownload("cnc_operator", CTX).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect((err as ServiceUnavailableException).getStatus()).toBe(503);
    expect(emitted(events, "interview_kit.downloaded")).toBeUndefined();
  });

  it("503s when the post-render UPLOAD fails (storage non-2xx)", async () => {
    const { svc, storage } = setup({ exists: false });
    storage.uploadPdf.mockRejectedValueOnce(new Error("storage upload failed with status 500"));
    await expect(svc.getDownload("cnc_operator", CTX)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it("503s when SIGNING the url fails, even for a cached kit", async () => {
    const { svc, storage, events } = setup({ exists: true });
    storage.createSignedUrl.mockRejectedValueOnce(
      new Error("storage sign-url failed with status 503"),
    );
    await expect(svc.getDownload("cnc_operator", CTX)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(emitted(events, "interview_kit.downloaded")).toBeUndefined();
  });

  it("503s on a storage TRANSPORT failure (fetch abort/TypeError), not 500", async () => {
    const { svc, storage } = setup();
    storage.objectExists.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(svc.getDownload("vmc_operator", CTX)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it("the 503 body is generic: no signed URL, no storage detail, no PII", async () => {
    const { svc, storage } = setup({ exists: true });
    storage.createSignedUrl.mockRejectedValueOnce(
      new Error("storage sign-url failed with status 500"),
    );
    const err = (await svc.getDownload("cnc_operator", CTX).then(
      () => null,
      (e: unknown) => e,
    )) as ServiceUnavailableException;
    const body = JSON.stringify(err.getResponse());
    expect(body).toContain("try again later");
    expect(body).not.toMatch(/https?:\/\/|token|signedURL|SUPABASE|storage|status 5/i);
    expect(body).not.toMatch(/worker|phone|\+91|\d{10}/i);
  });

  it("emits interview_kit.render_failed (reason=storage_unavailable) on the outage path", async () => {
    const { svc, storage, events } = setup();
    storage.objectExists.mockRejectedValueOnce(new Error("storage object-info failed with status 500"));
    await expect(svc.getDownload("cnc_operator", CTX)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    const failed = emitted(events, "interview_kit.render_failed");
    expect(failed).toBeTruthy();
    expect(failed!.payload.reason).toBe("storage_unavailable");
  });

  it("still 503 (never 500) when the events store is ALSO down (best-effort emit)", async () => {
    const { svc, storage, events } = setup();
    storage.objectExists.mockRejectedValueOnce(new Error("storage object-info failed with status 500"));
    events.emit.mockRejectedValue(new Error("events insert failed"));
    await expect(svc.getDownload("cnc_operator", CTX)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it("UNCHANGED: unknown trade is still 404 and storage is never touched", async () => {
    const { svc, storage } = setup();
    storage.objectExists.mockRejectedValue(new Error("must not be reached"));
    await expect(svc.getDownload("not_a_trade", CTX)).rejects.toBeInstanceOf(NotFoundException);
    expect(storage.objectExists).not.toHaveBeenCalled();
  });

  it("UNCHANGED: the render-unavailable 503 (renderer → null) passes through the catch untouched", async () => {
    const { svc, events } = setup({ exists: false, renderResult: null });
    await expect(svc.getDownload("vmc_operator", CTX)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    // Its ORIGINAL reason is preserved — the catch didn't re-emit storage_unavailable.
    const failed = emitted(events, "interview_kit.render_failed");
    expect(failed!.payload.reason).toBe("render_unavailable");
  });
});
