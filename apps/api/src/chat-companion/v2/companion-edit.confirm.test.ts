import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { FALLBACK, V2_EDIT_DONE, V2_EDIT_DONE_CAPPED, V2_EDIT_STALE } from "../companion-replies";
import { profileRow, setup, storedProposal, WORKER_ID } from "./companion-edit.fake";

const CTX = { correlationId: "c-1", requestId: "r-1" } as never;
const PROPOSAL_ID = "33333333-3333-4333-8333-333333333333";
const ROW_ID = "44444444-4444-4444-8444-444444444444";
const LANGUAGE_HINDI = { language: "hindi", can_speak: true, can_read: true, can_write: false };

describe("CompanionEditService.confirm", () => {
  it("is a 404 (not_found) for an unknown or other-worker proposal — no cross-worker oracle", async () => {
    const h = setup({ proposal: null });
    const result = await h.service.confirm(WORKER_ID, profileRow(), PROPOSAL_ID, [ROW_ID], CTX);
    expect(result.kind).toBe("not_found");
    expect(h.proposals.delete).not.toHaveBeenCalled();
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

  it("applies every ticked row in ONE transaction, then regenerates with chat_edit", async () => {
    const h = setup({
      proposal: storedProposal({
        rows: [
          {
            row_id: ROW_ID,
            section: "languages",
            op: "delete",
            field: "language",
            value: null,
            before: "hindi",
            section_label: "Bhasha",
            target: { language: "hindi" },
          },
          {
            row_id: "55555555-5555-4555-8555-555555555555",
            section: "skills",
            op: "add",
            field: "skill",
            value: "welding",
            before: null,
            section_label: "Skills",
            target: null,
          },
        ],
      }),
      languageEntries: [LANGUAGE_HINDI],
    });

    const result = await h.service.confirm(
      WORKER_ID,
      profileRow(),
      PROPOSAL_ID,
      [ROW_ID, "55555555-5555-4555-8555-555555555555"],
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

    expect(h.proposals.delete).toHaveBeenCalledTimes(1);
    expect(h.resumes.generate).toHaveBeenCalledWith(
      { worker_id: WORKER_ID, profile_id: profileRow().id },
      CTX,
      { systemInitiated: true, trigger: "chat_edit" },
    );
    const confirmed = h.events.emit.mock.calls.find(
      (c) => (c[0] as { event_name: string }).event_name === "chat.companion_edit_confirmed",
    )![0] as { payload: { applied_count: number; resume_regen: string; sections: string[] } };
    expect(confirmed.payload).toMatchObject({ applied_count: 2, resume_regen: "queued" });
    expect([...confirmed.payload.sections].sort()).toEqual(["languages", "skills"]);
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
    expect(h.resumes.generate).not.toHaveBeenCalled();
    expect(
      h.events.emit.mock.calls.some(
        (c) => (c[0] as { event_name: string }).event_name === "chat.companion_edit_confirmed",
      ),
    ).toBe(false);
  });

  it("a capped regeneration still leaves the edits written and says so", async () => {
    const h = setup({
      proposal: storedProposal(),
      languageEntries: [LANGUAGE_HINDI],
      generateThrows: { status: 429 },
    });
    const result = await h.service.confirm(WORKER_ID, profileRow(), PROPOSAL_ID, [ROW_ID], CTX);
    expect(result.kind).toBe("applied");
    if (result.kind !== "applied") throw new Error("expected applied");
    expect(result.resumeRegen).toBe("capped");
    expect(result.turn.reply).toBe(V2_EDIT_DONE_CAPPED.latin);
    expect(h.languages.replaceForWorker).toHaveBeenCalledTimes(1);
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
