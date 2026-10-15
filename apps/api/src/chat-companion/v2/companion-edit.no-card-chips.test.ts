import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";
import { RESUME_SECTIONS } from "../../chat/resume-menu";
import { COMPANION_NEW_JOBS_KEY } from "../companion-keys";
import { V2_EDIT_IDENTITY, V2_EDIT_NONE, V2_EDIT_PLACEHOLDER } from "../companion-replies";
import { COMPANION_TASK_EDIT_RESUME_KEY } from "../companion-task-keys";
import type { CompanionTurn } from "../chat-companion.dto";
import { profileRow, setup, WORKER_ID } from "./companion-edit.fake";

/**
 * #2295 — AN EDIT TURN THAT ENDS WITH NO CARD OFFERS THE RÉSUMÉ'S EDIT SECTIONS (ADR-0055 R1 as
 * amended). The worker asked to change the résumé; whether chat could not make the change (the
 * Profile-screen line) or did not understand it (the clarify line), the next step is the section.
 * On the brain those two lines carry the edit menu's six section chips instead of the task chips.
 * The lines are unchanged; the identity line and every line under the kill switch keep the task
 * chips.
 */

const CTX = { correlationId: "c-1", requestId: "r-1" } as never;

const parse = (rows: Record<string, unknown>[], unsupported: string[] = []) => ({
  rows,
  unsupported,
});

/** An edit with no value — dropped by the gates (the shape the model gave "experience 6 saal"). */
const NULL_VALUE_EDIT = {
  op: "edit",
  section: "preferences",
  ref: "pref",
  field: "shift",
  value: null,
};
/** A whole-job delete — "Never from chat" drops it, and the worker is pointed at the Profile screen. */
const JOB_DELETE = {
  op: "delete",
  section: "employment",
  ref: "e1",
  field: "employer_name",
  value: null,
};

const keys = (turn: CompanionTurn) => turn.suggested_options.map((option) => option.option_key);
const SECTION_KEYS = RESUME_SECTIONS.map((section) => section.key);
const TASK_KEYS = [COMPANION_TASK_EDIT_RESUME_KEY, COMPANION_NEW_JOBS_KEY];

async function propose(h: ReturnType<typeof setup>, text: string) {
  return h.service.propose(WORKER_ID, profileRow(), text, CTX);
}

const CASES = [
  ["every row dropped", parse([NULL_VALUE_EDIT]), V2_EDIT_NONE, "clarify"],
  ["no row at all", parse([]), V2_EDIT_NONE, "clarify"],
  ["an unreachable edit parse", null, V2_EDIT_NONE, "clarify"],
  ["a change the model filed as other", parse([], ["other"]), V2_EDIT_PLACEHOLDER, "served"],
  ["a whole-job delete", parse([JOB_DELETE]), V2_EDIT_PLACEHOLDER, "served"],
] as const;

beforeEach(() => {
  for (const level of ["log", "warn", "error"] as const) {
    vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  }
});
afterEach(() => vi.restoreAllMocks());

describe("#2295 — the no-card lines' chips", () => {
  it.each(CASES)(
    "on the brain, %s → its line with the EDIT SECTION chips",
    async (_why, parsed, line, outcome) => {
      const h = setup({ parse: parsed, brain: "on" });
      const result = await propose(h, "kuch badal do");
      expect(result.outcome).toBe(outcome);
      expect(result.turn.reply).toBe(line.latin);
      expect(keys(result.turn)).toEqual(SECTION_KEYS);
      expect(result.turn.suggested_followups).toEqual(RESUME_SECTIONS.map((s) => s.label));
    },
  );

  it.each(CASES)(
    "under the kill switch, %s → its line with the TASK chips, as today",
    async (_why, parsed, line, outcome) => {
      const h = setup({ parse: parsed, brain: "kill_switch" });
      const result = await propose(h, "kuch badal do");
      expect(result.outcome).toBe(outcome);
      expect(result.turn.reply).toBe(line.latin);
      expect(keys(result.turn)).toEqual(TASK_KEYS);
    },
  );

  it("the identity line keeps the task chips on the brain", async () => {
    const h = setup({ parse: parse([], ["identity"]), brain: "on" });
    const result = await propose(h, "mera naam badal do");
    expect(result.turn.reply).toBe(V2_EDIT_IDENTITY.latin);
    expect(keys(result.turn)).toEqual(TASK_KEYS);
  });
});
