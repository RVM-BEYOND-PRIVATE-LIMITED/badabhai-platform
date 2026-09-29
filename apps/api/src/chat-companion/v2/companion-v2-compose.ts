import type { ServerConfig } from "@badabhai/config";
import type { CompanionV2EditSection } from "@badabhai/types";
import type { ResumeMenuChoice } from "../../chat/resume-menu";
import { ttsField } from "../../profiling/question-tts-text";
import type { CompanionTurn, EditProposal } from "../chat-companion.dto";
import type { CopyPair } from "../companion-replies";
import { render } from "../companion-replies";
import { COMPANION_NEW_JOBS_KEY, COMPANION_NEW_JOBS_LABEL } from "../companion-keys";
import {
  COMPANION_TASK_EDIT_RESUME_KEY,
  COMPANION_TASK_EDIT_RESUME_LABEL,
  COMPANION_TASK_NEW_RESUME_KEY,
  COMPANION_TASK_NEW_RESUME_LABEL,
} from "../companion-task-keys";

/** One suggested option on a v2 turn — the wire shape the v1 composer already emits. */
export interface V2Option {
  readonly option_key: string;
  readonly label_text: string;
  readonly is_none_of_above: boolean;
}

/**
 * Every field a v2 companion turn fixes, so each builder spells out only what differs.
 *
 * THE SAME BASE AS V1 (`ChatCompanionService.baseTurn`), restated rather than imported: the v1
 * method is private, and the two turns are built by different layers. If a field is added to the
 * wire shape, both must gain it — the strict outbound schema is what catches a miss.
 */
function baseTurn(): Omit<
  CompanionTurn,
  "mode" | "reply" | "suggested_followups" | "suggested_options" | "question_kind"
> {
  return {
    blocked: false,
    is_mock: false,
    asked_question_id: null,
    extraction_ready: false,
    unanswered_essentials: [],
    session_ended: false,
    input_mode: "text",
    answer_type: null,
    progress: null,
    occupation_label: null,
    lookahead: null,
    form_offer: null,
    resume_update: null,
  };
}

/** A fixed-copy turn: Latin shown, Devanagari read aloud. No digest key (nothing varies). */
export function v2CopyTurn(
  pair: CopyPair,
  options: readonly V2Option[] = [],
): CompanionTurn {
  const line = render(pair);
  return {
    mode: "companion",
    ...baseTurn(),
    reply: line.text,
    tts_text: line.tts,
    suggested_followups: options.map((o) => o.label_text),
    suggested_options: [...options],
    question_kind: options.length > 0 ? "disambiguate" : "close",
  };
}

/** The edit card: intro copy plus the proposal the app renders with checkboxes. */
export function v2EditCardTurn(pair: CopyPair, proposal: EditProposal): CompanionTurn {
  const line = render(pair);
  return {
    mode: "companion",
    ...baseTurn(),
    reply: line.text,
    tts_text: line.tts,
    edit_proposal: proposal,
    suggested_followups: [],
    suggested_options: [],
    question_kind: "disambiguate",
  };
}

/**
 * A résumé-menu turn, served VERBATIM (ADR-0046 P2/N1) — the same fields the v1 `menuTurn`
 * builds from a `ResumeMenuChoice`, restated here for the same reason `baseTurn` is: the v1
 * method is private to another service, and the redo flow must be byte-identical to what the
 * résumé menu already serves. `resolveResumeMenu` remains the single source of the copy and the
 * options; this only shapes them onto the wire.
 */
export function v2MenuTurn(menu: ResumeMenuChoice): CompanionTurn {
  return {
    mode: "companion",
    ...baseTurn(),
    reply: menu.reply,
    ...ttsField(menu.reply),
    suggested_followups: [...menu.followups],
    suggested_options: menu.options.map((o) => ({ ...o })),
    question_kind: menu.followups.length > 0 ? "disambiguate" : "close",
  };
}

/**
 * The task chips a v2 turn may offer (contracts §5.3): a chip exists only while its phase's flag
 * is on, so a worker is never offered a door that opens onto "abhi aana baaki hai". The jobs chip
 * is v1's existing server-answered chip and is always available.
 */
export function taskChips(config: ServerConfig): V2Option[] {
  const chips: V2Option[] = [];
  if (config.CHAT_COMPANION_V2_EDIT_ENABLED) {
    chips.push({
      option_key: COMPANION_TASK_EDIT_RESUME_KEY,
      label_text: COMPANION_TASK_EDIT_RESUME_LABEL,
      is_none_of_above: false,
    });
  }
  // P2 — the new-résumé door, open only while its phase flag is on (contracts §5.3).
  if (config.CHAT_COMPANION_V2_NEW_RESUME_ENABLED) {
    chips.push({
      option_key: COMPANION_TASK_NEW_RESUME_KEY,
      label_text: COMPANION_TASK_NEW_RESUME_LABEL,
      is_none_of_above: false,
    });
  }
  chips.push({
    option_key: COMPANION_NEW_JOBS_KEY,
    label_text: COMPANION_NEW_JOBS_LABEL,
    is_none_of_above: false,
  });
  return chips;
}

/** The sections a proposal touched, deduped and in catalogue order, for the edit events. */
export function sectionsOf(rows: readonly { section: CompanionV2EditSection }[]): CompanionV2EditSection[] {
  return [...new Set(rows.map((r) => r.section))];
}
