/**
 * Post-completion resume menu for the worker chat (backend-only, deterministic).
 *
 * CONTEXT. After the interview finalizes, every POST to that session hits the
 * terminal path (`ChatService.terminalResponse`, `session.status !== "active"`).
 * It used to serve one fixed closing line with no chips, so "resume firse
 * banana hai" died there. This module turns that dead end into a stateless
 * menu WITHOUT touching any live-interview flow:
 *
 *   root  -> [Apna resume edit karein, Apna resume dobara banayein]
 *   dobara -> [Resume upload karein, Chat se resume banayein]
 *   edit   -> the 6 resume-section labels the worker app already renders
 *             (`ResumeSectionsView`: General Info, Technical Skills, Work
 *             History, Education & Certifications, Location, Availability &
 *             Salary) + ack per section.
 *
 * DESIGN RULES (BadaBhai invariants):
 *   - DETERMINISTIC ONLY. Normalized string matching, no LLM, no DB, no PII in
 *     logs. AI never owns this decision; it only classifies elsewhere.
 *   - STATELESS. Each ended-session POST is classified standalone, so the menu
 *     survives the client dropping its cached session id (`session_ended: true`
 *     re-resumes the same ended session via `GET /session/latest`).
 *   - ADDITIVE WIRE. Served through the existing `suggested_followups` +
 *     `suggested_options` fields with stable `option_key`s the new client
 *     routes on. Old clients render the same labels as plain chips.
 *   - FAIL CLOSED. Anything unrecognized falls back to the root menu, never an
 *     error, never a write.
 */

export const RESUME_MENU_EDIT_LABEL = "Apna resume edit karein";
export const RESUME_MENU_REDO_LABEL = "Apna resume dobara banayein";
export const RESUME_MENU_UPLOAD_LABEL = "Resume upload karein";
export const RESUME_MENU_CHAT_LABEL = "Chat se resume banayein";

export const RESUME_MENU_ROOT_REPLY =
  "Aap kya karna chahte hain. Neeche se chunein.";
export const RESUME_MENU_REDO_REPLY =
  "Naya resume kaise banana chahte hain. Neeche se chunein.";
export const RESUME_MENU_EDIT_REPLY =
  "Resume ka kaun sa hissa theek karna hai. Neeche se chunein.";
export const RESUME_MENU_UPLOAD_ACK =
  "Theek hai. Resume upload wali screen kholkar apna resume chunein. Upload hote hi naya resume ban jayega.";
export const RESUME_MENU_CHAT_ACK =
  "Theek hai. Nayi chat shuru karke apne baare me batayein. Baat poori hote hi naya resume ban jayega.";

/** Stable routing keys for the new client; labels stay the render contract. */
export const RESUME_MENU_EDIT_KEY = "resume_edit";
export const RESUME_MENU_REDO_KEY = "resume_redo";
export const RESUME_MENU_UPLOAD_KEY = "resume_upload";
export const RESUME_MENU_CHAT_CREATE_KEY = "resume_chat_create";

export interface ResumeSectionOption {
  readonly key: string;
  readonly label: string;
}

/**
 * The 6 sections in the worker app's own order and spelling
 * (`resume_sections.dart` `_sections` titles). Labels match byte-for-byte so
 * the client can route without string-matching copy of its own.
 */
export const RESUME_SECTIONS: readonly ResumeSectionOption[] = [
  { key: "section_general_info", label: "General Info" },
  { key: "section_technical_skills", label: "Technical Skills" },
  { key: "section_work_history", label: "Work History" },
  { key: "section_education", label: "Education & Certifications" },
  { key: "section_location", label: "Location" },
  { key: "section_availability_salary", label: "Availability & Salary" },
] as const;

export interface ResumeMenuChoice {
  readonly reply: string;
  readonly followups: string[];
  readonly options: { option_key: string; label_text: string; is_none_of_above: boolean }[];
}

/** Normalize worker input for matching: case/space/punctuation-insensitive. */
export function normalizeResumeMenuText(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[.!?।]+$/u, "")
    .replace(/\s+/g, " ");
}

function opt(key: string, label: string) {
  return { option_key: key, label_text: label, is_none_of_above: false };
}

function rootMenu(): ResumeMenuChoice {
  return {
    reply: RESUME_MENU_ROOT_REPLY,
    followups: [RESUME_MENU_EDIT_LABEL, RESUME_MENU_REDO_LABEL],
    options: [
      opt(RESUME_MENU_EDIT_KEY, RESUME_MENU_EDIT_LABEL),
      opt(RESUME_MENU_REDO_KEY, RESUME_MENU_REDO_LABEL),
    ],
  };
}

function redoMenu(): ResumeMenuChoice {
  return {
    reply: RESUME_MENU_REDO_REPLY,
    followups: [RESUME_MENU_UPLOAD_LABEL, RESUME_MENU_CHAT_LABEL],
    options: [
      opt(RESUME_MENU_UPLOAD_KEY, RESUME_MENU_UPLOAD_LABEL),
      opt(RESUME_MENU_CHAT_CREATE_KEY, RESUME_MENU_CHAT_LABEL),
    ],
  };
}

function editMenu(): ResumeMenuChoice {
  return {
    reply: RESUME_MENU_EDIT_REPLY,
    followups: RESUME_SECTIONS.map((s) => s.label),
    options: RESUME_SECTIONS.map((s) => opt(s.key, s.label)),
  };
}

function sectionAck(label: string): ResumeMenuChoice {
  return {
    reply: `${label} chuna. Resume tab me Edit kholkar wahi hissa badlein.`,
    followups: RESUME_SECTIONS.map((s) => s.label),
    options: RESUME_SECTIONS.map((s) => opt(s.key, s.label)),
  };
}

/**
 * Classify one post-completion message into the menu to serve. Pure function
 * of the text; never throws, never logs the text (PII-free by construction —
 * only fixed labels leave this module).
 */
export function resolveResumeMenu(text: string): ResumeMenuChoice {
  const t = normalizeResumeMenuText(text);

  if (t.length === 0) return rootMenu();

  // Exact label hits first (what the client's own chips submit byte-identically).
  if (t === normalizeResumeMenuText(RESUME_MENU_EDIT_LABEL)) return editMenu();
  if (t === normalizeResumeMenuText(RESUME_MENU_REDO_LABEL)) return redoMenu();
  if (t === normalizeResumeMenuText(RESUME_MENU_UPLOAD_LABEL)) {
    return { reply: RESUME_MENU_UPLOAD_ACK, followups: [], options: [] };
  }
  if (t === normalizeResumeMenuText(RESUME_MENU_CHAT_LABEL)) {
    return { reply: RESUME_MENU_CHAT_ACK, followups: [], options: [] };
  }
  for (const s of RESUME_SECTIONS) {
    if (t === normalizeResumeMenuText(s.label) || t === s.key) return sectionAck(s.label);
  }

  // Aliases (Hinglish, typed free-text). Narrow on purpose: this path only runs
  // on ENDED sessions, so a broad match cannot hijack a live interview.
  const has = (...words: string[]) => words.some((w) => t.includes(w));
  if (has("upload")) {
    return { reply: RESUME_MENU_UPLOAD_ACK, followups: [], options: [] };
  }
  if (has("dobara", "firse", "phir se", "naya resume", "dubara")) return redoMenu();
  if (has("edit", "theek karna", "sudhar", "badalna", "correction", "update")) return editMenu();
  if (has("chat se")) {
    return { reply: RESUME_MENU_CHAT_ACK, followups: [], options: [] };
  }
  for (const s of RESUME_SECTIONS) {
    if (t.includes(s.label.toLowerCase())) return sectionAck(s.label);
  }

  return rootMenu();
}
