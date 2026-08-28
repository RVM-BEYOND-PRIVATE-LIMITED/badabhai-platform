import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "@badabhai/config";

import { FontResolutionError } from "./font-resolution";
import { PdfRenderer } from "./pdf-renderer.service";
import { RESUME_FONT_CONTRACT } from "../../resume/resume-fonts";

// vi.mock is hoisted; the factory must not close over out-of-scope vars.
const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

const FIXTURES = join(__dirname, "..", "..", "resume", "__fixtures__", "font-probe");
const pdf = (name: string): Buffer => readFileSync(join(FIXTURES, `${name}.pdf`));

/** A `weasyprint` that writes `out` to stdout and exits 0. */
function spawnsPdf(out: Buffer): () => unknown {
  return () => {
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { on: () => undefined, end: () => undefined };
    child.kill = () => undefined;
    setImmediate(() => {
      (child.stdout as EventEmitter).emit("data", out);
      child.emit("close", 0);
    });
    return child;
  };
}

/** A `weasyprint` that is not installed. */
function spawnsEnoent(): () => unknown {
  return () => {
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { on: () => undefined, end: () => undefined };
    child.kill = () => undefined;
    setImmediate(() => {
      const err: NodeJS.ErrnoException = new Error("spawn weasyprint ENOENT");
      err.code = "ENOENT";
      child.emit("error", err);
    });
    return child;
  };
}

const renderer = (over: Partial<ServerConfig> = {}): PdfRenderer =>
  new PdfRenderer({ RESUME_RENDER_ENABLED: true, ...over } as ServerConfig);

/**
 * FAIL CLOSED ON FONTS.
 *
 * The behaviour under test is a refusal: this pipeline has twice produced a PDF that
 * rendered in the wrong font at exit 0, and neither the caller nor the logs could
 * tell. The assertion is therefore that `assertFontsResolve` REJECTS on the real
 * bytes those two containers produced - not that it notices something about them.
 */
describe("PdfRenderer.assertFontsResolve", () => {
  // Block body, NOT `() => spawnMock.mockReset()`: mockReset returns the mock for
  // chaining, an arrow with an expression body returns it, and vitest treats a value
  // returned from beforeEach as a teardown function — so it CALLS the mock once more
  // after the test, with nothing listening to the child it hands back.
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it("does not spawn anything when the kill-switch is off", async () => {
    // Nothing is being rendered, so there is nothing to vouch for - and local dev
    // deliberately has no weasyprint to probe with.
    await expect(
      renderer({ RESUME_RENDER_ENABLED: false }).assertFontsResolve(RESUME_FONT_CONTRACT),
    ).resolves.toBeUndefined();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("resolves against the shipped image, and probes only ONCE per process", async () => {
    spawnMock.mockImplementation(spawnsPdf(pdf("full-fonts")));
    const r = renderer();
    await r.assertFontsResolve(RESUME_FONT_CONTRACT);
    await r.assertFontsResolve(RESUME_FONT_CONTRACT);
    await r.assertFontsResolve(RESUME_FONT_CONTRACT);
    // Fonts cannot appear in a running container, so a proven contract stays proven.
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("REJECTS when fonts-noto-core is absent - the Devanagari name line", async () => {
    spawnMock.mockImplementation(spawnsPdf(pdf("no-noto")));
    await expect(renderer().assertFontsResolve(RESUME_FONT_CONTRACT)).rejects.toThrow(
      FontResolutionError,
    );
    await expect(renderer().assertFontsResolve(RESUME_FONT_CONTRACT)).rejects.toThrow(
      /Noto-Sans-Devanagari/,
    );
  });

  it("REJECTS the serif fallback, which loses no glyphs at all", async () => {
    spawnMock.mockImplementation(spawnsPdf(pdf("no-sans")));
    await expect(renderer().assertFontsResolve(RESUME_FONT_CONTRACT)).rejects.toThrow(
      /DejaVu-Serif/,
    );
  });

  it("REJECTS when it could not measure, rather than passing by default", async () => {
    spawnMock.mockImplementation(spawnsEnoent());
    await expect(renderer().assertFontsResolve(RESUME_FONT_CONTRACT)).rejects.toThrow(
      FontResolutionError,
    );
  });

  it("does NOT memoise a failure - a transient probe error is not a font verdict", async () => {
    const r = renderer();
    spawnMock.mockImplementation(spawnsEnoent());
    await expect(r.assertFontsResolve(RESUME_FONT_CONTRACT)).rejects.toThrow();
    // A missing binary or a timeout says nothing about the fonts. Caching that as
    // "fonts are broken" would keep a healthy deployment refusing to render.
    spawnMock.mockImplementation(spawnsPdf(pdf("full-fonts")));
    await expect(r.assertFontsResolve(RESUME_FONT_CONTRACT)).resolves.toBeUndefined();
  });

  it("sends the probe through the same invocation as a real render", async () => {
    // If the probe took a different argv it would be vouching for a render nobody runs.
    spawnMock.mockImplementation(spawnsPdf(pdf("full-fonts")));
    const r = renderer();
    await r.assertFontsResolve(RESUME_FONT_CONTRACT);
    await r.renderHtmlToPdf("<p>hi</p>", "resume");
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock.mock.calls[0]).toEqual(spawnMock.mock.calls[1]);
  });
});
