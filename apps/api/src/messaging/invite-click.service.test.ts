import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { InviteClickService } from "./invite-click.service";
import type { InviteService } from "./invite.service";
import type { AgencyService } from "../agency/agency.service";

const CODE = "abcdef012345";

function make() {
  const workerInvites = { recordClick: vi.fn() };
  const agency = { recordInviteClick: vi.fn().mockResolvedValue({ ok: true }) };
  const svc = new InviteClickService(
    workerInvites as unknown as InviteService,
    agency as unknown as AgencyService,
  );
  return { svc, workerInvites, agency };
}

describe("InviteClickService — the ONE public click path for both funnels (TD113)", () => {
  let h: ReturnType<typeof make>;
  beforeEach(() => (h = make()));

  it("a WORKER code resolves on the first seam — the agency table is never touched", async () => {
    h.workerInvites.recordClick.mockResolvedValue({ ok: true });
    expect(await h.svc.recordPublicClick(CODE)).toEqual({ kind: "worker" });
    expect(h.agency.recordInviteClick).not.toHaveBeenCalled();
  });

  it("an unknown WORKER code FALLS THROUGH to the agency code space (the TD113 fix)", async () => {
    h.workerInvites.recordClick.mockResolvedValue({ ok: false, reason: "unknown_code" });
    expect(await h.svc.recordPublicClick(CODE)).toEqual({ kind: "agency_or_unknown" });
    // This call is the whole point: before the fix the invited worker — the only party who
    // can click — could not reach the agent-guarded agency click route at all.
    expect(h.agency.recordInviteClick).toHaveBeenCalledWith(CODE);
  });

  it("a code in NEITHER table is indistinguishable from a valid agency code (no oracle)", async () => {
    h.workerInvites.recordClick.mockResolvedValue({ ok: false, reason: "unknown_code" });
    // The agency seam returns the same {ok:true} for known and unknown, by contract.
    h.agency.recordInviteClick.mockResolvedValue({ ok: true });
    expect(await h.svc.recordPublicClick("000000000000")).toEqual({ kind: "agency_or_unknown" });
  });

  it("FAIL-SAFE: a seam throwing is neutralized, never propagated (a shared link must not 500)", async () => {
    h.workerInvites.recordClick.mockRejectedValue(new Error("db down"));
    expect(await h.svc.recordPublicClick(CODE)).toEqual({ kind: "error" });
  });

  it("never logs the code (a shareable bearer token) on the failure path", async () => {
    const warn = vi.spyOn(
      (h.svc as unknown as { logger: { warn: (m: string) => void } }).logger,
      "warn",
    );
    h.workerInvites.recordClick.mockRejectedValue(new Error("db down"));
    await h.svc.recordPublicClick(CODE);
    expect(warn).toHaveBeenCalled();
    for (const call of warn.mock.calls) expect(String(call[0])).not.toContain(CODE);
  });
});
