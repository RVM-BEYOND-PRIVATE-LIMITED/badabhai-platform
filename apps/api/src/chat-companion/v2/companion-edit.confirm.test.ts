import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";
import { FALLBACK, V2_EDIT_DONE, V2_EDIT_DONE_CAPPED, V2_EDIT_STALE } from "../companion-replies";
import { profileRow, PROFILE_ID, setup, storedProposal, WORKER_ID } from "./companion-edit.fake";
import type { StoredEditProposalRow } from "./edit-proposal.store";

const CTX = { correlationId: "c-1", requestId: "r-1" } as never;
const PROPOSAL_ID = "33333333-3333-4333-8333-333333333333";
const ROW_ID = "44444444-4444-4444-8444-444444444444";
const SKILL_ROW_ID = "55555555-5555-4555-8555-555555555555";
const LANGUAGE_HINDI = { language: "hindi", can_speak: true, can_read: true, can_write: false };

const DELETE_HINDI: StoredEditProposalRow = {
  row_id: ROW_ID,
  section: "languages",
  op: "delete",
  field: "language",
  value: null,
  before: "hindi",
  section_label: "Bhasha",
  target: { language: "hindi" },
};
const ADD_WELDING: StoredEditProposalRow = {
  row_id: SKILL_ROW_ID,
  section: "skills",
  op: "add",
  field: "skill",
  value: "welding",
  before: null,
  section_label: "Skills",
  target: null,
};

function confirmedPayload(h: ReturnType<typeof setup>): Record<string, unknown> | undefined {
  const call = h.events.emit.mock.calls.find(
    (c) => (c[0] as { event_name: string }).event_name === "chat.companion_edit_confirmed",
  );
  return (call?.[0] as { payload: Record<string, unknown> } | undefined)?.payload;
}

describe("CompanionEditService.confirm", () => {
  it("is a 404 (not_found) for an unknown or other-worker proposal — no cross-worker oracle", async () => {
    const h = setup({ proposal: null });
    const result = await h.service.confirm(WORKER_ID, profileRow(), PROPOSAL_ID, [ROW_ID], CTX);
    expect(result.kind).toBe("not_found");
    expect(h.proposals.delete).not.toHaveBeenCalled();
  });

  it("is not_found when the worker's OWN card carries a different proposal id — nothing written", async () => {
    const h = setup({ proposal: storedProposal(), languageEntries: [LANGUAGE_HINDI] });
    const result = await h.service.confirm(
      WORKER_ID,
      profileRow(),
      "66666666-6666-4666-8666-666666666666",
      [ROW_ID],
      CTX,
    );
    expect(result.kind).toBe("not_found");
    expect(h.db.transaction).not.toHaveBeenCalled();
    expect(h.proposals.delete).not.toHaveBeenCalled();
    expect(h.resumes.queueChatEditRegeneration).not.toHaveBeenCalled();
  });

  it("is not_found when none of the ticked rows belong to the card", async () => {
    const h = setup({ proposal: storedProposal(), languageEntries: [LANGUAGE_HINDI] });
    const result = await h.service.confirm(WORKER_ID, profileRow(), PROPOSAL_ID, ["99999999-9999-4999-8999-999999999999"], CTX);
    expect(result.kind).toBe("not_found");
  });

  it("a STALE card writes nothing: proposal deleted, cancelled(stale) emitted, no writer touched", async () => {
    // The card says hindi exists; the profile no longer has it (edited elsewhere).
    const h = setup({ proposal: storedProposal(), languageEntries: [] });
    const result = await h.service.confirm(WORKER_ID, profileRow(), PROPOSAL_ID, [ROW_ID], CTX);
    expect(result.kind).toBe("stale");
    if (result.kind === "stale") expect(result.turn.reply).toBe(V2_EDIT_STALE.latin);
    expect(h.proposals.delete).toHaveBeenCalledTimes(1);
    expect(h.languages.replaceForWorker).not.toHaveBeenCalled();
    expect(h.db.transaction.mock.calls.length).toBe(0);
    const cancelled = h.events.emit.mock.calls.find(
      (c) => (c[0] as { event_name: string }).event_name === "chat.companion_edit_cancelled",
    )![0] as { payload: { reason: string } };
    expect(cancelled.payload.reason).toBe("stale");
  });

  it("applies every ticked row in ONE transaction, then QUEUES the chat_edit regeneration", async () => {
    const h = setup({
      proposal: storedProposal({ rows: [DELETE_HINDI, ADD_WELDING] }),
      languageEntries: [LANGUAGE_HINDI],
    });
    // The regeneration is asked for only AFTER the transaction committed: it reads the profile the
    // edits produced, so a request made mid-transaction would generate the old résumé.
    let committedAtRequest = -1;
    h.resumes.queueChatEditRegeneration.mockImplementation(async () => {
      committedAtRequest = h.committed.length;
      return "queued";
    });

    const result = await h.service.confirm(
      WORKER_ID,
      profileRow(),
      PROPOSAL_ID,
      [ROW_ID, SKILL_ROW_ID],
      CTX,
    );

    expect(result.kind).toBe("applied");
    if (result.kind !== "applied") throw new Error("expected applied");
    expect(result.turn.reply).toBe(V2_EDIT_DONE.latin);
    expect(result.appliedCount).toBe(2);
    expect(result.resumeRegen).toBe("queued");

    // One transaction, and BOTH writers ran on its handle.
    expect(h.db.transaction.mock.calls.length).toBe(1);
    expect(h.languages.replaceForWorker).toHaveBeenCalledWith(
      WORKER_ID,
      { languages: [] },
      CTX,
      { tx: h.tx },
    );
    expect(h.profiles.setResumeSkillLabels).toHaveBeenCalledWith(
      profileRow().id,
      { skills: ["skill_milling"], skillLabels: ["MIG welding", "welding"] },
      h.tx,
    );

    expect(h.committed.map((w) => w.writer).sort()).toEqual(["languages", "skills"]);

    expect(h.proposals.delete).toHaveBeenCalledTimes(1);
    // The confirmed profile's id, the worker from the session — and nothing generated inline.
    expect(h.resumes.queueChatEditRegeneration).toHaveBeenCalledTimes(1);
    expect(h.resumes.queueChatEditRegeneration).toHaveBeenCalledWith(WORKER_ID, PROFILE_ID, CTX);
    expect(committedAtRequest).toBe(2);
    const confirmed = confirmedPayload(h) as { sections: string[] };
    expect(confirmed).toMatchObject({ applied_count: 2, resume_regen: "queued" });
    expect([...confirmed.sections].sort()).toEqual(["languages", "skills"]);
  });

  it("a writer failure ROLLS BACK everything: fallback line, proposal kept, no regeneration", async () => {
    const h = setup({
      proposal: storedProposal(),
      languageEntries: [LANGUAGE_HINDI],
      writerThrows: true,
    });
    const result = await h.service.confirm(WORKER_ID, profileRow(), PROPOSAL_ID, [ROW_ID], CTX);
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.turn.reply).toBe(FALLBACK.latin);
    // The card survives so the worker may retry until its TTL.
    expect(h.proposals.delete).not.toHaveBeenCalled();
    expect(h.resumes.queueChatEditRegeneration).not.toHaveBeenCalled();
    expect(h.committed).toEqual([]);
    expect(confirmedPayload(h)).toBeUndefined();
  });

  it("row 2's writer failing UNDOES row 1: nothing committed, fallback, card kept (spec §4)", async () => {
    // Row 1 (the skill) really is written — on the transaction — before row 2 (the language)
    // throws. The acceptance item is that it does not survive.
    vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const h = setup({
      proposal: storedProposal({ rows: [ADD_WELDING, DELETE_HINDI] }),
      languageEntries: [LANGUAGE_HINDI],
      failingWriters: ["languages"],
    });
    const result = await h.service.confirm(
      WORKER_ID,
      profileRow(),
      PROPOSAL_ID,
      [SKILL_ROW_ID, ROW_ID],
      CTX,
    );

    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.turn.reply).toBe(FALLBACK.latin);
    // Row 1 DID write, on the transaction's handle, and row 2 was attempted after it…
    expect(h.profiles.setResumeSkillLabels).toHaveBeenCalledWith(PROFILE_ID, expect.anything(), h.tx);
    expect(h.languages.replaceForWorker).toHaveBeenCalledTimes(1);
    expect(h.profiles.setResumeSkillLabels.mock.invocationCallOrder[0]!).toBeLessThan(
      h.languages.replaceForWorker.mock.invocationCallOrder[0]!,
    );
    // …and none of it survived the rollback.
    expect(h.committed).toEqual([]);
    expect(h.proposals.delete).not.toHaveBeenCalled();
    expect(h.resumes.queueChatEditRegeneration).not.toHaveBeenCalled();
    expect(confirmedPayload(h)).toBeUndefined();
  });

  it("a CAPPED regeneration leaves the edits written and says the résumé did not update", async () => {
    const h = setup({
      proposal: storedProposal(),
      languageEntries: [LANGUAGE_HINDI],
      regen: "capped",
    });
    const result = await h.service.confirm(WORKER_ID, profileRow(), PROPOSAL_ID, [ROW_ID], CTX);
    expect(result.kind).toBe("applied");
    if (result.kind !== "applied") throw new Error("expected applied");
    expect(result.resumeRegen).toBe("capped");
    expect(result.turn.reply).toBe(V2_EDIT_DONE_CAPPED.latin);
    expect(h.committed.map((w) => w.writer)).toEqual(["languages"]);
    expect(confirmedPayload(h)).toMatchObject({ resume_regen: "capped" });
  });

  it("a FAILED regeneration request is served the same truthful line, and recorded as failed", async () => {
    const h = setup({
      proposal: storedProposal(),
      languageEntries: [LANGUAGE_HINDI],
      regen: "failed",
    });
    const result = await h.service.confirm(WORKER_ID, profileRow(), PROPOSAL_ID, [ROW_ID], CTX);
    if (result.kind !== "applied") throw new Error("expected applied");
    expect(result.resumeRegen).toBe("failed");
    expect(result.turn.reply).toBe(V2_EDIT_DONE_CAPPED.latin);
    expect(h.committed.map((w) => w.writer)).toEqual(["languages"]);
    expect(confirmedPayload(h)).toMatchObject({ resume_regen: "failed" });
  });

  it("a résumé seam that THROWS still answers: edits written, failed, never the fallback", async () => {
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const h = setup({
      proposal: storedProposal(),
      languageEntries: [LANGUAGE_HINDI],
      regenThrows: true,
    });
    const result = await h.service.confirm(WORKER_ID, profileRow(), PROPOSAL_ID, [ROW_ID], CTX);
    if (result.kind !== "applied") throw new Error("expected applied");
    expect(result.resumeRegen).toBe("failed");
    expect(result.turn.reply).toBe(V2_EDIT_DONE_CAPPED.latin);
    expect(h.committed).toHaveLength(1);
  });

  describe("CONSENT GATES THE REGENERATION, FAIL CLOSED — the edits still land", () => {
    const cases: ReadonlyArray<
      readonly [string, { revokedAt: Date | null; purposes: string[] } | null]
    > = [
      ["no consent row", null],
      ["a revoked consent", { revokedAt: new Date(), purposes: ["resume_generation"] }],
      ["a consent without resume_generation", { revokedAt: null, purposes: ["profiling"] }],
    ];

    it.each(cases)("%s: no cap slot, no model call — failed, and the truthful line", async (_, consent) => {
      vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
      const h = setup({
        proposal: storedProposal(),
        languageEntries: [LANGUAGE_HINDI],
        consent,
      });
      const result = await h.service.confirm(WORKER_ID, profileRow(), PROPOSAL_ID, [ROW_ID], CTX);
      if (result.kind !== "applied") throw new Error("expected applied");
      // Nothing is asked of the résumé seam, so neither the cap nor the model is touched.
      expect(h.resumes.queueChatEditRegeneration).not.toHaveBeenCalled();
      expect(h.consents.findLatestByWorker).toHaveBeenCalledWith(WORKER_ID);
      expect(result.resumeRegen).toBe("failed");
      expect(result.turn.reply).toBe(V2_EDIT_DONE_CAPPED.latin);
      // The edit is written and reported as written.
      expect(h.committed.map((w) => w.writer)).toEqual(["languages"]);
      expect(h.proposals.delete).toHaveBeenCalledTimes(1);
      expect(confirmedPayload(h)).toMatchObject({ applied_count: 1, resume_regen: "failed" });
    });

    it("a consent read that throws is a no, not an error", async () => {
      vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
      const h = setup({ proposal: storedProposal(), languageEntries: [LANGUAGE_HINDI] });
      h.consents.findLatestByWorker.mockRejectedValue(new Error("db down"));
      const result = await h.service.confirm(WORKER_ID, profileRow(), PROPOSAL_ID, [ROW_ID], CTX);
      if (result.kind !== "applied") throw new Error("expected applied");
      expect(result.resumeRegen).toBe("failed");
      expect(h.resumes.queueChatEditRegeneration).not.toHaveBeenCalled();
    });
  });

  it("an occupations edit rebuilds the matching projection AFTER commit", async () => {
    const h = setup({
      proposal: storedProposal({
        rows: [
          {
            row_id: ROW_ID,
            section: "occupations",
            op: "delete",
            field: "role_id",
            value: null,
            before: "role_welder",
            section_label: "Aur kaam",
            target: { role_id: "role_welder" },
          },
        ],
      }),
      occupationEntries: [{ role_id: "role_welder", label: "Welder" }],
    });
    const result = await h.service.confirm(WORKER_ID, profileRow(), PROPOSAL_ID, [ROW_ID], CTX);
    expect(result.kind).toBe("applied");
    expect(h.workerSkills.rebuildQuietly).toHaveBeenCalledWith(WORKER_ID, CTX);
  });

  it("cancel deletes the card and emits cancelled(worker) — nothing was written", async () => {
    const h = setup({ proposal: storedProposal() });
    const result = await h.service.cancel(WORKER_ID, PROPOSAL_ID, CTX);
    expect(result.kind).toBe("cancelled");
    expect(h.proposals.delete).toHaveBeenCalledTimes(1);
    const cancelled = h.events.emit.mock.calls.find(
      (c) => (c[0] as { event_name: string }).event_name === "chat.companion_edit_cancelled",
    )![0] as { payload: { reason: string } };
    expect(cancelled.payload.reason).toBe("worker");
  });

  it("cancel on an unknown proposal is not_found", async () => {
    const h = setup({ proposal: null });
    expect((await h.service.cancel(WORKER_ID, PROPOSAL_ID, CTX)).kind).toBe("not_found");
  });
});
