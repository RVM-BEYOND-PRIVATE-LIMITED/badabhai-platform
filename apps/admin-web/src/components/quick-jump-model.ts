import { ACTION_ICON, type CanonicalIconName } from "@badabhai/icons";
import type { AdminCapability } from "../lib/auth/capabilities";
import { agencyPostingHref } from "../lib/agency-posting-href";
import { customerHref } from "../lib/customer";
import { shortId } from "../lib/format";

/**
 * THE QUICK JUMP (Ctrl/⌘K, A6 #2576) — the model, plain data and pure functions, in a module
 * with no `"use client"`: the portal layout filters the kinds on the server (as it filters the
 * nav), and the palette (`quick-jump.tsx`) builds its options and addresses from the same table.
 *
 * WHAT IT JUMPS BY: A RECORD'S ID, AND ONLY THAT. A pasted id is offered as each kind of record
 * the reader may open — a candidate, a customer (Company or Agency, one page since A6), a
 * posting, an agency posting — because an id alone does not say which table it is from, and
 * there is no admin lookup that would. The address opens the record's own page, whose own gate
 * and not-found decide the rest (a wrong id shows that page's not-found). Nothing is fetched
 * here, and nothing is filtered in the browser.
 *
 * NOT BY PHONE, YET. The admin API serves no lookup by phone — the entity reads never expose one
 * (`admin-entities.dto.ts`), and the universal candidate search that will is backend #2559
 * (screen #2577). A phone number typed here is told so, rather than searched for.
 */
export type JumpKindId = "candidate" | "company" | "posting" | "agency-posting";

interface JumpKind {
  id: JumpKindId;
  /** The option's words: "Candidate 5eed…0001". */
  label: string;
  icon: CanonicalIconName;
  /** The record page's own gate — the kind is offered only to a reader who may open it. */
  capability: AdminCapability;
  href: (id: string) => string;
}

export const JUMP_KINDS: readonly JumpKind[] = [
  {
    id: "candidate",
    label: "Candidate",
    icon: ACTION_ICON.users,
    capability: "read_entities",
    href: (id) => `/candidates/${encodeURIComponent(id)}`,
  },
  {
    // One customer page for both kinds (A6): it names which one the account is.
    id: "company",
    label: "Company or agency",
    icon: "buildings",
    capability: "read_entities",
    href: (id) => customerHref(id),
  },
  {
    id: "posting",
    label: "Posting",
    icon: ACTION_ICON.posting,
    capability: "read_entities",
    href: (id) => `/jobs/${encodeURIComponent(id)}`,
  },
  {
    // An agency posting is a `jobs` row with its own page under Postings (lib/agency-posting-href).
    id: "agency-posting",
    label: "Agency posting",
    icon: "tag",
    capability: "manage_agency_match_skills",
    href: (id) => agencyPostingHref(id),
  },
];

/** The kinds a session may jump to — each record page's own gate, read off the session's grants. */
export function allowedJumpKinds(may: (capability: AdminCapability) => boolean): JumpKindId[] {
  return JUMP_KINDS.filter((k) => may(k.capability)).map((k) => k.id);
}

/** What the reader typed, as the palette reads it. */
export type JumpQuery =
  | { type: "empty" }
  | { type: "id"; id: string }
  | { type: "short-id" }
  | { type: "phone" }
  | { type: "other" };

/** A full record id anywhere in the text — a pasted id, or a pasted console address. */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/** A short id as the console prints one: "5eeded00…" (or without its ellipsis), "5eed…0001". */
const SHORT_ID = /^(?:[0-9a-f]{8}(?:…|\.\.\.)?|[0-9a-f]{4}(?:…|\.\.\.)[0-9a-f]{4})$/i;
/** A phone number: digits, with the separators people type, 10 to 15 digits long. */
const PHONE = /^\+?[\d\s().-]+$/;

export function parseJumpQuery(raw: string): JumpQuery {
  const text = raw.trim();
  if (text === "") return { type: "empty" };
  const id = UUID.exec(text);
  if (id) return { type: "id", id: id[0].toLowerCase() };
  const digits = text.replace(/\D/g, "").length;
  if (PHONE.test(text) && digits >= 10 && digits <= 15) return { type: "phone" };
  if (SHORT_ID.test(text)) return { type: "short-id" };
  return { type: "other" };
}

export interface JumpOption {
  kind: JumpKindId;
  label: string;
  icon: CanonicalIconName;
  href: string;
  /** The id as the console prints it, beside the kind. */
  shortId: string;
}

/** The records an id could be, in the kinds this reader may open; none for anything else. */
export function jumpOptions(query: JumpQuery, kinds: readonly JumpKindId[]): JumpOption[] {
  if (query.type !== "id") return [];
  return JUMP_KINDS.filter((k) => kinds.includes(k.id)).map((k) => ({
    kind: k.id,
    label: k.label,
    icon: k.icon,
    href: k.href(query.id),
    shortId: shortId(query.id),
  }));
}

/** The one line under the field: what to type, or why nothing matches. */
export function jumpHint(query: JumpQuery, options: number): string {
  switch (query.type) {
    case "empty":
      return "Paste a full id to open the candidate, customer or posting it belongs to.";
    case "id":
      return options === 0
        ? "Your role cannot open any record by id."
        : "Pick which record the id belongs to. A wrong pick shows that page's not-found.";
    case "short-id":
      return "That looks like a short id. Paste the full id — a short one cannot be looked up.";
    case "phone":
      return "Finding a candidate by phone is not available yet. Paste their id instead.";
    case "other":
      return "That is not an id. Ids look like 5eeded00-0001-4a00-8000-000000000001.";
  }
}

/**
 * The palette's state: what is typed, and which option the keyboard has highlighted. A reducer,
 * so the keyboard rules are pure and the highlight moves in the same render as the key press —
 * instantly, with no animation on the results (A6).
 */
export interface JumpState {
  query: string;
  highlight: number;
}

export type JumpAction =
  | { type: "input"; query: string }
  | { type: "key"; key: string; count: number }
  | { type: "point"; index: number }
  | { type: "reset" };

export const INITIAL_JUMP_STATE: JumpState = { query: "", highlight: 0 };

export function jumpReducer(state: JumpState, action: JumpAction): JumpState {
  switch (action.type) {
    case "input":
      // New text, new options: the first one is the one Enter opens.
      return { query: action.query, highlight: 0 };
    case "point":
      return action.index === state.highlight ? state : { ...state, highlight: action.index };
    case "reset":
      return INITIAL_JUMP_STATE;
    case "key": {
      const next = moveHighlight(state.highlight, action.count, action.key);
      return next === state.highlight ? state : { ...state, highlight: next };
    }
  }
}

/** Arrow keys wrap, Home and End go to the ends; any other key leaves the highlight where it is. */
export function moveHighlight(current: number, count: number, key: string): number {
  if (count <= 0) return 0;
  switch (key) {
    case "ArrowDown":
      return (current + 1) % count;
    case "ArrowUp":
      return (current - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return Math.min(current, count - 1);
  }
}
