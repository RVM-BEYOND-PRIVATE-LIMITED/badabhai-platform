import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";
import { CompanionTurnSchema } from "../chat-companion.dto";
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
    // Queued: the new entry renders the live tables itself, so no separate re-render.
    expect(h.rerender.enqueueLatest).not.toHaveBeenCalled();
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

  it("the rolled-back answer CARRIES the same card, so Haan can be tapped again (BUG-F1)", async () => {
    const h = setup({ proposal: storedProposal(), languageEntries: [LANGUAGE_HINDI], writerThrows: true });
    const result = await h.service.confirm(WORKER_ID, profileRow(), PROPOSAL_ID, [ROW_ID], CTX);
    if (result.kind !== "failed") throw new Error("expected failed");
    // The same proposal id and row ids the app already holds — its one turn-to-state path shows
    // the card again, with no app change. The labels are computed at wire time from the stored
    // row, so a card stored before they existed is served labelled too.
    expect(result.turn.edit_proposal).toEqual({
      proposal_id: PROPOSAL_ID,
      expires_at: storedProposal().expires_at,
      rows: [
        {
          row_id: ROW_ID,
          section_label: "Bhasha",
          field_label: "Bhasha",
          op: "delete",
          before: "hindi",
          after: null,
          before_display: "Hindi",
          after_display: null,
        },
      ],
    });
    expect(CompanionTurnSchema.safeParse(result.turn).success).toBe(true);
  });

  it("…and that second Haan applies: the rollback handed the claim back", async () => {
    const h = setup({
      proposal: storedProposal(),
      languageEntries: [LANGUAGE_HINDI],
      failingWriters: ["languages"],
    });
    expect((await h.service.confirm(WORKER_ID, profileRow(), PROPOSAL_ID, [ROW_ID], CTX)).kind).toBe("failed");
    expect(h.proposals.release).toHaveBeenCalledWith(WORKER_ID, PROPOSAL_ID);

    h.languages.replaceForWorker.mockImplementation(async (...args: unknown[]) => {
      h.tx.staged.push({ writer: "languages", args });
      return { worker_id: WORKER_ID, language_count: 0 };
    });
    expect((await h.service.confirm(WORKER_ID, profileRow(), PROPOSAL_ID, [ROW_ID], CTX)).kind).toBe("applied");
    expect(h.committed.map((w) => w.writer)).toEqual(["languages"]);
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

  describe("NO REGENERATION QUEUED → the form path's LLM-free re-render (EDIT-RERENDER)", () => {
    // The section writers skip their own forced re-render on the joined transaction, because a
    // regeneration is to follow. When none does, the confirm must run that re-render itself, or
    // the PDF keeps printing the old values the form path would have replaced for free.
    const SHIFT_NIGHT: StoredEditProposalRow = {
      row_id: SKILL_ROW_ID,
      section: "preferences",
      op: "edit",
      field: "shift",
      value: "night",
      before: "day",
      section_label: "Pasand",
      target: null,
    };

    it.each(["capped", "failed"] as const)(
      "%s: one re-render of the latest résumé, AFTER commit",
      async (regen) => {
        const h = setup({ proposal: storedProposal(), languageEntries: [LANGUAGE_HINDI], regen });
        let committedAtRerender = -1;
        h.rerender.enqueueLatest.mockImplementation(async () => {
          committedAtRerender = h.committed.length;
          return "55555555-5555-4555-8555-555555555555";
        });
        const result = await h.service.confirm(WORKER_ID, profileRow(), PROPOSAL_ID, [ROW_ID], CTX);
        if (result.kind !== "applied") throw new Error("expected applied");
        expect(result.resumeRegen).toBe(regen);
        expect(h.rerender.enqueueLatest).toHaveBeenCalledTimes(1);
        expect(h.rerender.enqueueLatest).toHaveBeenCalledWith(WORKER_ID, CTX);
        expect(committedAtRerender).toBe(1);
        // The event is unchanged: the re-render is not a regeneration and records nothing.
        expect(confirmedPayload(h)).toMatchObject({ resume_regen: regen });
      },
    );

    it("no consent: the regeneration is refused, the re-render still runs (it calls no model)", async () => {
      vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
      const h = setup({ proposal: storedProposal(), languageEntries: [LANGUAGE_HINDI], consent: null });
      const result = await h.service.confirm(WORKER_ID, profileRow(), PROPOSAL_ID, [ROW_ID], CTX);
      if (result.kind !== "applied") throw new Error("expected applied");
      expect(h.resumes.queueChatEditRegeneration).not.toHaveBeenCalled();
      expect(h.rerender.enqueueLatest).toHaveBeenCalledTimes(1);
    });

    it("two live-printed sections on one card: still ONE re-render", async () => {
      const h = setup({
        proposal: storedProposal({ rows: [DELETE_HINDI, SHIFT_NIGHT] }),
        languageEntries: [LANGUAGE_HINDI],
        preferenceValues: { shift: "day" },
        regen: "capped",
      });
      const result = await h.service.confirm(
        WORKER_ID,
        profileRow(),
        PROPOSAL_ID,
        [ROW_ID, SKILL_ROW_ID],
        CTX,
      );
      expect(result.kind).toBe("applied");
      expect(h.committed.map((w) => w.writer).sort()).toEqual(["languages", "preferences"]);
      expect(h.rerender.enqueueLatest).toHaveBeenCalledTimes(1);
    });

    it("queued: NO re-render — the new history entry renders the live tables itself", async () => {
      const h = setup({ proposal: storedProposal(), languageEntries: [LANGUAGE_HINDI] });
      const result = await h.service.confirm(WORKER_ID, profileRow(), PROPOSAL_ID, [ROW_ID], CTX);
      if (result.kind !== "applied") throw new Error("expected applied");
      expect(result.resumeRegen).toBe("queued");
      expect(h.rerender.enqueueLatest).not.toHaveBeenCalled();
    });

    it("a skills-only card: NO re-render — the render prints the skills stored with the résumé", async () => {
      const h = setup({ proposal: storedProposal({ rows: [ADD_WELDING] }), regen: "capped" });
      const result = await h.service.confirm(WORKER_ID, profileRow(), PROPOSAL_ID, [SKILL_ROW_ID], CTX);
      if (result.kind !== "applied") throw new Error("expected applied");
      expect(h.committed.map((w) => w.writer)).toEqual(["skills"]);
      expect(h.rerender.enqueueLatest).not.toHaveBeenCalled();
    });

    it("a rolled-back apply: NO re-render — nothing changed", async () => {
      vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
      const h = setup({
        proposal: storedProposal(),
        languageEntries: [LANGUAGE_HINDI],
        regen: "capped",
        writerThrows: true,
      });
      const result = await h.service.confirm(WORKER_ID, profileRow(), PROPOSAL_ID, [ROW_ID], CTX);
      expect(result.kind).toBe("failed");
      expect(h.rerender.enqueueLatest).not.toHaveBeenCalled();
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

describe("CompanionEditService.confirm — a card applies AT MOST ONCE (BUG-DOUBLE-CONFIRM)", () => {
  it("two concurrent Haans: one applies, the other is the already-confirmed 404", async () => {
    const h = setup({
      proposal: storedProposal({ rows: [DELETE_HINDI, ADD_WELDING] }),
      languageEntries: [LANGUAGE_HINDI],
    });
    const results = await Promise.all([
      h.service.confirm(WORKER_ID, profileRow(), PROPOSAL_ID, [ROW_ID, SKILL_ROW_ID], CTX),
      h.service.confirm(WORKER_ID, profileRow(), PROPOSAL_ID, [ROW_ID, SKILL_ROW_ID], CTX),
    ]);
    expect(results.map((r) => r.kind).sort()).toEqual(["applied", "not_found"]);
    // One apply, one regeneration (one cap slot), one skill label appended.
    expect(h.db.transaction).toHaveBeenCalledTimes(1);
    expect(h.profiles.setResumeSkillLabels).toHaveBeenCalledTimes(1);
    expect(h.resumes.queueChatEditRegeneration).toHaveBeenCalledTimes(1);
  });

  it("a retry after the proposal's delete failed finds the claim held — nothing is applied twice", async () => {
    const h = setup({
      proposal: storedProposal({ rows: [ADD_WELDING] }),
      deleteFails: true,
    });
    expect((await h.service.confirm(WORKER_ID, profileRow(), PROPOSAL_ID, [SKILL_ROW_ID], CTX)).kind).toBe(
      "applied",
    );
    // The card is still in Redis (the DEL was lost) — the claim is what refuses it.
    expect(await h.proposals.load(WORKER_ID)).not.toBeNull();
    expect((await h.service.confirm(WORKER_ID, profileRow(), PROPOSAL_ID, [SKILL_ROW_ID], CTX)).kind).toBe(
      "not_found",
    );
    expect(h.profiles.setResumeSkillLabels).toHaveBeenCalledTimes(1);
    expect(h.resumes.queueChatEditRegeneration).toHaveBeenCalledTimes(1);
  });

  it("Redis refusing the claim applies NOTHING and serves the card again", async () => {
    const h = setup({ proposal: storedProposal(), languageEntries: [LANGUAGE_HINDI], claimUnavailable: true });
    const result = await h.service.confirm(WORKER_ID, profileRow(), PROPOSAL_ID, [ROW_ID], CTX);
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.turn.edit_proposal?.proposal_id).toBe(PROPOSAL_ID);
    expect(h.db.transaction).not.toHaveBeenCalled();
    expect(h.proposals.delete).not.toHaveBeenCalled();
  });

  it("a Nahi racing a Haan: whichever claimed first is the answer", async () => {
    const h = setup({ proposal: storedProposal(), languageEntries: [LANGUAGE_HINDI] });
    await h.proposals.claim(WORKER_ID, PROPOSAL_ID); // a confirm is in flight
    expect((await h.service.cancel(WORKER_ID, PROPOSAL_ID, CTX)).kind).toBe("not_found");
    expect(h.proposals.delete).not.toHaveBeenCalled();
    expect(h.events.emit).not.toHaveBeenCalled();
  });

  it("a section that cannot be re-read is not 'stale': nothing written, card kept and served, claim released", async () => {
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const h = setup({ proposal: storedProposal(), languageEntries: [LANGUAGE_HINDI] });
    h.languages.getForWorker.mockRejectedValueOnce(new Error("db hiccup"));
    const result = await h.service.confirm(WORKER_ID, profileRow(), PROPOSAL_ID, [ROW_ID], CTX);
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.turn.edit_proposal?.proposal_id).toBe(PROPOSAL_ID);
    expect(h.proposals.delete).not.toHaveBeenCalled();
    expect(h.db.transaction).not.toHaveBeenCalled();
    expect(h.events.emit).not.toHaveBeenCalled();
    // The retry, once the read recovers, applies.
    expect((await h.service.confirm(WORKER_ID, profileRow(), PROPOSAL_ID, [ROW_ID], CTX)).kind).toBe("applied");
  });
});

describe("CompanionEditService — a tap on an EXPIRED card is recorded as expired (CON-4d)", () => {
  const EXPIRES = "2026-09-30T12:00:00.000Z";
  const LATE = new Date("2026-09-30T12:00:01.000Z");
  const EARLY = new Date("2026-09-30T11:59:59.000Z");

  function cancelledReasons(h: ReturnType<typeof setup>): string[] {
    return h.events.emit.mock.calls
      .map((c) => c[0] as { event_name: string; payload: { reason?: string } })
      .filter((e) => e.event_name === "chat.companion_edit_cancelled")
      .map((e) => e.payload.reason ?? "");
  }

  it("a Haan past expires_at: the same 404, cancelled{expired}, nothing claimed or written", async () => {
    const h = setup({ proposal: storedProposal({ expires_at: EXPIRES }), languageEntries: [LANGUAGE_HINDI] });
    const result = await h.service.confirm(WORKER_ID, profileRow(), PROPOSAL_ID, [ROW_ID], CTX, LATE);
    expect(result.kind).toBe("not_found");
    expect(cancelledReasons(h)).toEqual(["expired"]);
    const event = h.events.emit.mock.calls[0]![0] as { payload: unknown; idempotencyKey: string };
    // The spine's own schema (ids + a closed reason) — deduped on the proposal, so a second late
    // tap adds nothing.
    expect(event.payload).toEqual({ proposal_id: PROPOSAL_ID, reason: "expired" });
    expect(event.idempotencyKey).toBe(`chat.companion_edit_cancelled:${PROPOSAL_ID}`);
    expect(h.proposals.claim).not.toHaveBeenCalled();
    expect(h.db.transaction).not.toHaveBeenCalled();
    // Left to lapse, never deleted: a delete could race a newer card saved meanwhile.
    expect(h.proposals.delete).not.toHaveBeenCalled();
  });

  it("a Nahi past expires_at is recorded the same way", async () => {
    const h = setup({ proposal: storedProposal({ expires_at: EXPIRES }) });
    expect((await h.service.cancel(WORKER_ID, PROPOSAL_ID, CTX, LATE)).kind).toBe("not_found");
    expect(cancelledReasons(h)).toEqual(["expired"]);
  });

  it("a Haan a second before expires_at still applies", async () => {
    const h = setup({ proposal: storedProposal({ expires_at: EXPIRES }), languageEntries: [LANGUAGE_HINDI] });
    const result = await h.service.confirm(WORKER_ID, profileRow(), PROPOSAL_ID, [ROW_ID], CTX, EARLY);
    expect(result.kind).toBe("applied");
    expect(cancelledReasons(h)).toEqual([]);
  });

  it("an id that is NOT the worker's card records nothing — a URL id never reaches the spine", async () => {
    const h = setup({ proposal: storedProposal({ expires_at: EXPIRES }) });
    const other = "66666666-6666-4666-8666-666666666666";
    expect((await h.service.confirm(WORKER_ID, profileRow(), other, [ROW_ID], CTX, LATE)).kind).toBe("not_found");
    expect((await h.service.cancel(WORKER_ID, other, CTX, LATE)).kind).toBe("not_found");
    expect(h.events.emit).not.toHaveBeenCalled();
  });
});

describe("CompanionEditService.confirm — a stored whole-job delete is never applied ('Never from chat')", () => {
  // Defence in depth for the owner's 2026-10-01 ruling: `propose` no longer cards a whole-job
  // delete, but a card stored before the deploy lives up to its TTL (600 s) and the app shows its
  // rows pre-ticked.
  const JOB_ROW_ID = "77777777-7777-4777-8777-777777777777";
  const EMPLOYMENT_ID = "66666666-6666-4666-8666-666666666666";
  const DELETE_JOB: StoredEditProposalRow = {
    row_id: JOB_ROW_ID,
    section: "employment",
    op: "delete",
    field: "employer_name",
    value: null,
    before: "Tata Motors",
    section_label: "Kaam",
    target: { employment_id: EMPLOYMENT_ID },
  };
  const TATA = {
    employment_id: EMPLOYMENT_ID,
    employer_name: "Tata Motors",
    employer_city: "Pune",
    employer_state: null,
    start_ym: "2019-01",
    end_ym: null,
    roles: [
      {
        role_label: "Welder",
        start_ym: "2019-01",
        end_ym: null,
        work_done: null,
        work_done_voice_note_id: null,
        description_source: null,
      },
    ],
  };

  it("a TICKED job delete: retired as stale — nothing written, card deleted, cancelled(stale)", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    warn.mockClear();
    const h = setup({
      proposal: storedProposal({ rows: [DELETE_JOB, DELETE_HINDI] }),
      employmentViews: [TATA],
      languageEntries: [LANGUAGE_HINDI],
    });
    const result = await h.service.confirm(WORKER_ID, profileRow(), PROPOSAL_ID, [JOB_ROW_ID, ROW_ID], CTX);

    expect(result.kind).toBe("stale");
    if (result.kind === "stale") expect(result.turn.reply).toBe(V2_EDIT_STALE.latin);
    // Nothing at all is written — not even the language row ticked beside it.
    expect(h.db.transaction).not.toHaveBeenCalled();
    expect(h.employment.replaceForWorker).not.toHaveBeenCalled();
    expect(h.languages.replaceForWorker).not.toHaveBeenCalled();
    expect(h.committed).toEqual([]);
    expect(h.resumes.queueChatEditRegeneration).not.toHaveBeenCalled();
    expect(h.proposals.delete).toHaveBeenCalledTimes(1);
    expect(confirmedPayload(h)).toBeUndefined();
    const cancelled = h.events.emit.mock.calls.find(
      (c) => (c[0] as { event_name: string }).event_name === "chat.companion_edit_cancelled",
    )![0] as { payload: unknown };
    expect(cancelled.payload).toEqual({ proposal_id: PROPOSAL_ID, reason: "stale" });
    // Observable with a closed reason, ids only — never the employer.
    const lines = warn.mock.calls.map((c) => String(c[0]));
    expect(lines.filter((line) => line.includes("reason=job_delete_from_chat"))).toHaveLength(1);
    expect(lines.join("\n")).not.toContain("Tata");
    warn.mockRestore();
  });

  it("an UNTICKED job delete is inert: the other ticked row applies", async () => {
    const h = setup({
      proposal: storedProposal({ rows: [DELETE_JOB, DELETE_HINDI] }),
      employmentViews: [TATA],
      languageEntries: [LANGUAGE_HINDI],
    });
    const result = await h.service.confirm(WORKER_ID, profileRow(), PROPOSAL_ID, [ROW_ID], CTX);
    expect(result.kind).toBe("applied");
    expect(h.employment.replaceForWorker).not.toHaveBeenCalled();
    expect(h.committed.map((w) => w.writer)).toEqual(["languages"]);
  });
});
