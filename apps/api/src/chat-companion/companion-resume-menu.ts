/**
 * The résumé menu as the Bada Bhai chat serves it on the free-chat brain (ADR-0055, #2275) —
 * deterministic, stateless, no model. Two additions to the shipped menu, and nothing else:
 *
 *   - THE FORM ROAD in the redo submenu ("Form se resume banayein"), between upload and chat;
 *   - THE DOWNLOAD CHIP after a résumé question the classifier could not place, when a rendered
 *     résumé exists to hand over.
 *
 * NOT IN `resume-menu.ts`. That module is shared with the ended-interview path
 * (`ChatService.terminalResponse`) and pinned by the worker app's parity test (see
 * `companion-v3-keys.ts`), so the menu it builds stays byte-for-byte what it was. These helpers
 * decorate its output, and the companion applies them only while the brain is on — under
 * `CHAT_FREE_CHAT_DISABLED` the companion serves the shipped menu exactly.
 */
import {
  RESUME_MENU_UPLOAD_KEY,
  normalizeResumeMenuText,
  type ResumeMenuChoice,
} from "../chat/resume-menu";
import {
  COMPANION_RESUME_DOWNLOAD_KEY,
  COMPANION_RESUME_DOWNLOAD_LABEL,
  RESUME_MENU_FORM_ACK,
  RESUME_MENU_FORM_CREATE_KEY,
  RESUME_MENU_FORM_CREATE_LABEL,
} from "./companion-v3-keys";

type MenuOption = ResumeMenuChoice["options"][number];

const FORM_OPTION: MenuOption = {
  option_key: RESUME_MENU_FORM_CREATE_KEY,
  label_text: RESUME_MENU_FORM_CREATE_LABEL,
  is_none_of_above: false,
};

const DOWNLOAD_OPTION: MenuOption = {
  option_key: COMPANION_RESUME_DOWNLOAD_KEY,
  label_text: COMPANION_RESUME_DOWNLOAD_LABEL,
  is_none_of_above: false,
};

/** A menu with `options` as its chips — the labels ARE the follow-ups, in the same order. */
function withOptions(menu: ResumeMenuChoice, options: readonly MenuOption[]): ResumeMenuChoice {
  return {
    reply: menu.reply,
    followups: options.map((o) => o.label_text),
    options: options.map((o) => ({ ...o })),
  };
}

/**
 * Which road made the profile / résumé — the form road (`form`), the LLM-chat road (`chat`), or
 * unknown (`null`, pre-road rows). A chat-made profile is never offered the form road.
 */
export function isChatRoad(source: string | null | undefined): boolean {
  return source === "chat";
}

/**
 * The redo submenu (the one menu that offers the upload road) with the form road inserted right
 * after upload: "Resume upload karein · Form se resume banayein · Chat se resume banayein". Every
 * other menu is returned unchanged, so this can wrap any menu the companion serves.
 *
 * CHAT-ROAD PROFILES SEE ONLY TWO OPTIONS. When `opts` names a chat road — the profile's own
 * `source` OR the current résumé's `source` (either is enough, per owner ruling) — the menu is
 * returned unchanged: "Resume upload karein · Chat se resume banayein". Form-road and unknown
 * sources keep all three, exactly as before. Omitted `opts` is today's behaviour (adds the road).
 */
export function withFormCreateOption(
  menu: ResumeMenuChoice,
  opts?: { readonly profileSource?: string | null; readonly resumeSource?: string | null },
): ResumeMenuChoice {
  if (isChatRoad(opts?.profileSource) || isChatRoad(opts?.resumeSource)) return menu;
  const at = menu.options.findIndex((o) => o.option_key === RESUME_MENU_UPLOAD_KEY);
  if (at < 0 || menu.options.some((o) => o.option_key === RESUME_MENU_FORM_CREATE_KEY)) return menu;
  return withOptions(menu, [
    ...menu.options.slice(0, at + 1),
    FORM_OPTION,
    ...menu.options.slice(at + 1),
  ]);
}

/** The same menu with the download chip last — the root menu after an unplaced résumé question. */
export function withDownloadOption(menu: ResumeMenuChoice): ResumeMenuChoice {
  return withOptions(menu, [...menu.options, DOWNLOAD_OPTION]);
}

/** The download chip on its own, for the "your résumé is ready" line. */
export function downloadOption(): MenuOption {
  return { ...DOWNLOAD_OPTION };
}

/**
 * Is this message a tap on the form road — its label (what the app posts) or its key? Exact, after
 * the menu's own normalisation, never a substring: "form se resume banana hai" typed by hand is
 * free text and goes through the normal flow.
 */
export function isFormCreateChoice(text: string): boolean {
  const normalized = normalizeResumeMenuText(text);
  return (
    normalized === normalizeResumeMenuText(RESUME_MENU_FORM_CREATE_LABEL) ||
    normalized === RESUME_MENU_FORM_CREATE_KEY
  );
}

/** The form road's acknowledgement — no chips, the way the menu acks upload and chat. */
export function formCreateAck(): ResumeMenuChoice {
  return { reply: RESUME_MENU_FORM_ACK, followups: [], options: [] };
}
