import { describe, expect, it } from "vitest";
import type { AnswerRecord } from "@badabhai/ai-contracts";

import { emptyProfilingEnvelope, type ProfilingEnvelope } from "../conversation-state";
import {
  CHAT_EDITS_KEY,
  readChatEditsStamp,
  storedChatEdits,
  toChatEditsStatePatch,
} from "./chat-edits.stamp";

/** ADR-0057 R9 (#2313) — the confirmed-change stamp the profile build honours. */

const JOB = { role_label: "Fitter", duration_text: "2 saal", duration_months: 24, work_done: "assembly" };

const answered = (key: string, value: unknown): AnswerRecord => ({
  question_key: key,
  target_field: key,
  value_raw: String(value),
  value_normalized: value,
  status: "answered",
  evidence: null,
  turn: 1,
  history: [],
});

function envelope(over: Partial<ProfilingEnvelope> = {}): ProfilingEnvelope {
  return {
    ...emptyProfilingEnvelope(),
    llmDraft: { domain_label: null, role_label: "Fitter", skills: ["Welding"], experiences: [JOB] },
    ...over,
  };
}

describe("toChatEditsStatePatch", () => {
  it("is ABSENT for a session with no confirmed change — the state stays byte-identical", () => {
    expect(toChatEditsStatePatch(envelope())).toEqual({});
    expect(
      toChatEditsStatePatch({ ...envelope(), editLedger: undefined } as unknown as ProfilingEnvelope),
    ).toEqual({});
  });

  it("carries a settled list only for a list the worker changed", () => {
    const patch = toChatEditsStatePatch(
      envelope({ editLedger: [{ key: "experience", op: "edit", targetField: null }] }),
    );
    expect(patch.chat_edits).toEqual({
      v: 1,
      ledger: [{ field_key: "experience", op: "edit", target_field: null }],
      skills: null,
      experiences: [JOB],
      deleted_fields: [],
    });
  });

  it("names a removed field only while it is still empty", () => {
    const ledger = [{ key: "current_city", op: "delete" as const, targetField: "current_city" }];
    expect(toChatEditsStatePatch(envelope({ editLedger: ledger })).chat_edits?.deleted_fields).toEqual([
      "current_city",
    ]);
    // Asked again and answered: the answer map holds the new value, which the build already prefers.
    expect(
      toChatEditsStatePatch(
        envelope({ editLedger: ledger, answerMap: [answered("current_city", "Mumbai")] }),
      ).chat_edits?.deleted_fields,
    ).toEqual([]);
  });

  it("round-trips through the strict reader", () => {
    const patch = toChatEditsStatePatch(
      envelope({ editLedger: [{ key: "skills", op: "delete", targetField: null }] }),
    );
    expect(readChatEditsStamp(JSON.parse(JSON.stringify(patch)))).toEqual(patch.chat_edits);
  });
});

describe("reading and carrying the stamp", () => {
  const STAMP = {
    v: 1,
    ledger: [{ field_key: "experience", op: "delete", target_field: null }],
    skills: null,
    experiences: [],
    deleted_fields: [],
  };

  it("refuses a later version, an unknown key and a missing one — null is 'no confirmed change'", () => {
    expect(readChatEditsStamp({ [CHAT_EDITS_KEY]: STAMP })).toEqual(STAMP);
    expect(readChatEditsStamp({ [CHAT_EDITS_KEY]: { ...STAMP, v: 2 } })).toBeNull();
    expect(readChatEditsStamp({ [CHAT_EDITS_KEY]: { ...STAMP, before: "5 saal" } })).toBeNull();
    expect(readChatEditsStamp({ [CHAT_EDITS_KEY]: { ...STAMP, ledger: [] } })).toBeNull();
    expect(readChatEditsStamp({})).toBeNull();
    expect(readChatEditsStamp(null)).toBeNull();
  });

  it("keeps the row's own stamp for the next replacing write", () => {
    expect(storedChatEdits({ [CHAT_EDITS_KEY]: STAMP, other: 1 })).toEqual({ chat_edits: STAMP });
    expect(storedChatEdits({ other: 1 })).toEqual({});
    expect(storedChatEdits(null)).toEqual({});
  });
});
