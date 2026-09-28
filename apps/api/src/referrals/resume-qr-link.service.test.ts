import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "@badabhai/config";
import type { EventsService } from "../events/events.service";
import type { ReferralLinkRepository } from "./referral-link.repository";
import { isWellFormedReferralCode } from "./referral-resolve";
import {
  RESUME_QR_MINT_ATTEMPTS,
  ResumeQrLinkService,
  ResumeQrMintExhaustedError,
} from "./resume-qr-link.service";

/**
 * #1800 — the get-or-create of a worker's ONE `resume_qr` link, the code their own résumé QR
 * encodes. What is pinned: the flag gates every query; an existing link is reused (stable across
 * re-renders); a mint checks all three code spaces, retries a code collision a BOUNDED number of
 * times, and commits its row and its `referral.link_created` (SYSTEM actor, no code) together; a
 * lost race re-reads the winner; and every other failure propagates so the render falls back.
 */

const OWNER = "55555555-5555-4555-8555-555555555555";
const LINK_ID = "11111111-1111-4111-8111-111111111111";
const TX = { tx: "the-transaction" };

const row = (code: string, over: Record<string, unknown> = {}) => ({
  id: LINK_ID,
  code,
  kind: "resume_qr" as const,
  medium: "organic" as const,
  ownerWorkerId: OWNER,
  ...over,
});

/** A drizzle 0.45 query failure: the SQLSTATE lives on `cause`, never on the error itself. */
function queryError(sqlstate: string): Error {
  return Object.assign(new Error("Failed query: insert into referral_links … params: …"), {
    query: "insert into …",
    params: [],
    cause: Object.assign(new Error("driver"), { code: sqlstate }),
  });
}

function make(opts: { enabled?: boolean; repo?: Partial<Record<string, unknown>> } = {}) {
  const repo = {
    findResumeQrLink: vi.fn().mockResolvedValue(undefined),
    isCodeTaken: vi.fn().mockResolvedValue(false),
    insertResumeQrLink: vi
      .fn()
      .mockImplementation(async (input: { code: string }) => row(input.code)),
    withTransaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(TX)),
    ...opts.repo,
  };
  const events = { emit: vi.fn().mockResolvedValue(undefined) };
  const config = { RESUME_QR_SCAN_ENABLED: opts.enabled ?? true } as unknown as ServerConfig;
  const svc = new ResumeQrLinkService(
    repo as unknown as ReferralLinkRepository,
    events as unknown as EventsService,
    config,
  );
  return { svc, repo, events };
}

describe("ResumeQrLinkService.codeFor — the flag", () => {
  it("OFF: null, and NOT ONE query — migration 0129 need not exist", async () => {
    const h = make({ enabled: false });
    expect(h.svc.enabled).toBe(false);
    await expect(h.svc.codeFor(OWNER)).resolves.toBeNull();
    for (const fn of Object.values(h.repo)) expect(fn).not.toHaveBeenCalled();
    expect(h.events.emit).not.toHaveBeenCalled();
  });

  it("unset is off — only a literal true arms it", () => {
    const svc = new ResumeQrLinkService({} as never, {} as never, {} as never);
    expect(svc.enabled).toBe(false);
  });
});

describe("ResumeQrLinkService.codeFor — get-or-create", () => {
  it("an EXISTING link is returned as is: no mint, no event (stable across re-renders)", async () => {
    const h = make({
      repo: { findResumeQrLink: vi.fn().mockResolvedValue(row("abcdef012345")) },
    });
    await expect(h.svc.codeFor(OWNER)).resolves.toBe("abcdef012345");
    expect(h.repo.insertResumeQrLink).not.toHaveBeenCalled();
    expect(h.events.emit).not.toHaveBeenCalled();
  });

  it("mints a fresh 12-hex code for the owner and emits referral.link_created IN THE SAME TX", async () => {
    const h = make();
    const code = await h.svc.codeFor(OWNER);

    expect(code).not.toBeNull();
    expect(isWellFormedReferralCode(code!)).toBe(true);
    expect(h.repo.isCodeTaken).toHaveBeenCalledWith(code);
    expect(h.repo.insertResumeQrLink).toHaveBeenCalledWith({ code, ownerWorkerId: OWNER }, TX);

    expect(h.events.emit).toHaveBeenCalledTimes(1);
    const call = h.events.emit.mock.calls[0]![0];
    expect(call.event_name).toBe("referral.link_created");
    expect(call.actor).toEqual({ actor_type: "system", actor_id: null });
    expect(call.subject).toEqual({ subject_type: "referral_link", subject_id: LINK_ID });
    expect(call.payload).toEqual({
      referral_link_id: LINK_ID,
      kind: "resume_qr",
      medium: "organic",
    });
    // The row and its event commit or roll back together.
    expect(call.tx).toBe(TX);
    // The bearer code never rides the event.
    expect(JSON.stringify(call)).not.toContain(code!);
  });

  it("a FAILED emit fails the mint (the transaction rolls the row back) — the render falls back", async () => {
    const h = make();
    h.events.emit.mockRejectedValueOnce(new Error("events down"));
    await expect(h.svc.codeFor(OWNER)).rejects.toThrow("events down");
  });

  it("a LOST RACE (ON CONFLICT DO NOTHING → no row) re-reads the winner and emits nothing", async () => {
    const findResumeQrLink = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(row("fedcba987654"));
    const h = make({
      repo: { findResumeQrLink, insertResumeQrLink: vi.fn().mockResolvedValue(undefined) },
    });
    await expect(h.svc.codeFor(OWNER)).resolves.toBe("fedcba987654");
    expect(h.events.emit).not.toHaveBeenCalled();
  });

  it("a lost race whose winner vanished (owner erased mid-render) throws — no QR for no worker", async () => {
    const h = make({ repo: { insertResumeQrLink: vi.fn().mockResolvedValue(undefined) } });
    await expect(h.svc.codeFor(OWNER)).rejects.toThrow();
  });
});

describe("ResumeQrLinkService.codeFor — collisions, bounded", () => {
  it("a code already live in ANY of the three spaces is skipped for a fresh one", async () => {
    const isCodeTaken = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const h = make({ repo: { isCodeTaken } });
    const code = await h.svc.codeFor(OWNER);
    expect(isCodeTaken).toHaveBeenCalledTimes(2);
    const [first, second] = isCodeTaken.mock.calls.map((c) => c[0] as string);
    expect(first).not.toBe(second);
    expect(code).toBe(second);
    // The taken code was never inserted.
    expect(h.repo.insertResumeQrLink).toHaveBeenCalledTimes(1);
  });

  it("a 23505 on the code index (a race past the check) is retried — read through drizzle's wrapper", async () => {
    const insertResumeQrLink = vi
      .fn()
      .mockRejectedValueOnce(queryError("23505"))
      .mockImplementation(async (input: { code: string }) => row(input.code));
    const h = make({ repo: { insertResumeQrLink } });
    await expect(h.svc.codeFor(OWNER)).resolves.toMatch(/^[a-f0-9]{12}$/);
    expect(insertResumeQrLink).toHaveBeenCalledTimes(2);
    expect(h.events.emit).toHaveBeenCalledTimes(1);
  });

  it(`gives up after ${RESUME_QR_MINT_ATTEMPTS} attempts with a code-free error`, async () => {
    const h = make({ repo: { isCodeTaken: vi.fn().mockResolvedValue(true) } });
    const err = await h.svc.codeFor(OWNER).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResumeQrMintExhaustedError);
    expect(h.repo.isCodeTaken).toHaveBeenCalledTimes(RESUME_QR_MINT_ATTEMPTS);
    expect(h.repo.insertResumeQrLink).not.toHaveBeenCalled();
    expect((err as Error).message).not.toMatch(/[a-f0-9]{12}/);
  });

  it.each([
    ["23514", "the kind CHECK before 0129 is applied"],
    ["42P10", "no ON CONFLICT index before 0129 is applied"],
    ["57P01", "an outage"],
  ])("%s (%s) is NOT retried — it propagates so the render falls back", async (sqlstate) => {
    const insertResumeQrLink = vi.fn().mockRejectedValue(queryError(sqlstate));
    const h = make({ repo: { insertResumeQrLink } });
    await expect(h.svc.codeFor(OWNER)).rejects.toBeDefined();
    expect(insertResumeQrLink).toHaveBeenCalledTimes(1);
    expect(h.events.emit).not.toHaveBeenCalled();
  });
});

describe("ResumeQrLinkService — the one event it can emit", () => {
  it("its source names exactly one event: referral.link_created (the render processor's TD5 bound)", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(join(__dirname, "resume-qr-link.service.ts"), "utf8");
    const names = [...source.matchAll(/event_name:\s*"([a-z_.0-9]+)"/g)].map((m) => m[1]);
    expect(names).toEqual(["referral.link_created"]);
  });
});
