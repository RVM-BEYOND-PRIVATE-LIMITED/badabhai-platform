import type { ServerConfig } from "@badabhai/config";
import type { CompanionV2EditSection } from "@badabhai/types";
import {
  RESUME_MENU_EDIT_LABEL,
  resolveResumeMenu,
  type ResumeMenuChoice,
} from "../../chat/resume-menu";
import { ttsField } from "../../profiling/question-tts-text";
import type { FreeChatNewsLinkWire } from "../../profiling/free-chat/free-chat-news-links";
import type { CompanionTurn, EditProposal } from "../chat-companion.dto";
import type { CopyPair } from "../companion-replies";
import { render, V2_FALTU_COOLDOWN } from "../companion-replies";
import {
  COMPANION_JOBS_TAB_KEY,
  COMPANION_JOBS_TAB_LABEL,
  COMPANION_NEW_JOBS_KEY,
  COMPANION_NEW_JOBS_LABEL,
} from "../companion-keys";
import { openTaskChips } from "./companion-task-chips";

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
 * is on, so a worker is never offered a door that opens onto "abhi aana baaki hai". The chips
 * come from the same table the tap recogniser reads (`companion-task-chips.ts`), so a chip is
 * shown exactly while a tap on it is routed. The jobs chip is v1's existing server-answered chip
 * and is always available.
 */
export function taskChips(config: ServerConfig): V2Option[] {
  const chips: V2Option[] = openTaskChips(config).map((chip) => ({
    option_key: chip.key,
    label_text: chip.label,
    is_none_of_above: false,
  }));
  chips.push({
    option_key: COMPANION_NEW_JOBS_KEY,
    label_text: COMPANION_NEW_JOBS_LABEL,
    is_none_of_above: false,
  });
  return chips;
}

/**
 * #2295 — the résumé's EDIT SECTION chips, read from the shipped edit menu itself
 * (`resolveResumeMenu`), so a tap is the menu's own exact chip and is answered as one. What an edit
 * turn that ends with no card offers on the brain: the worker picks the section instead of guessing
 * another phrasing.
 */
export function editSectionChips(): V2Option[] {
  return resolveResumeMenu(RESUME_MENU_EDIT_LABEL).options.map((option) => ({ ...option }));
}

/**
 * A MODEL-WRITTEN career answer (ADR-0046 P3). `read_aloud: false` is the contract with the
 * app (O9): the model's text has no reviewed Devanagari twin and must never be spoken, so the
 * field is present and false rather than absent — an absent field would let a shipped client
 * fall back to reading `reply` aloud. The follow-up chips ride `suggested_followups` only:
 * they are model text with no server option key, and a tap posts the label as ordinary text.
 */
export function v2CareerAnswerTurn(
  lines: readonly string[],
  chips: readonly string[],
): CompanionTurn {
  return {
    mode: "companion",
    ...baseTurn(),
    reply: lines.join("\n"),
    read_aloud: false,
    suggested_followups: [...chips],
    suggested_options: [],
    question_kind: chips.length > 0 ? "disambiguate" : "close",
  };
}

/**
 * "Sabhi jobs dekhein" (ADR-0055) — v1's existing APP-ROUTED Jobs-tab chip, the one way forward
 * from the brain's jobs line. The shipped app already routes the key to the Jobs tab and never posts it.
 */
export function jobsTabChip(): V2Option {
  return {
    option_key: COMPANION_JOBS_TAB_KEY,
    label_text: COMPANION_JOBS_TAB_LABEL,
    is_none_of_above: false,
  };
}

/**
 * A MODEL-WRITTEN LIVE-NEWS ANSWER on the Bada Bhai chat (ADR-0054 through ADR-0055): the gate's
 * lines, never read aloud (the career answer's contract), and its 1-3 checked "read more" tiles as
 * `news_links` — the field the profiling chat's wire already carries, which the companion turn
 * inherits. No chips: the tiles are the turn's way forward.
 */
export function v3NewsAnswerTurn(
  lines: readonly string[],
  links: readonly FreeChatNewsLinkWire[],
): CompanionTurn {
  return { ...v2CareerAnswerTurn(lines, []), news_links: links.map((link) => ({ ...link })) };
}

/**
 * The cool-down turn (ADR-0046 P2, O11): the fixed line, the still-open chips — the cool-down
 * blocks free text, never the worker — and the ISO instant the composer may reopen. The app
 * reads `cooldown_until` to disable the composer with a countdown (F1).
 */
export function v2CooldownTurn(until: string, options: readonly V2Option[]): CompanionTurn {
  return { ...v2CopyTurn(V2_FALTU_COOLDOWN, options), cooldown_until: until };
}

/** The sections a proposal touched, deduped and in catalogue order, for the edit events. */
export function sectionsOf(rows: readonly { section: CompanionV2EditSection }[]): CompanionV2EditSection[] {
  return [...new Set(rows.map((r) => r.section))];
}
