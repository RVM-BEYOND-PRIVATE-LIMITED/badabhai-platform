/**
 * THE FREE-CHAT REPLY'S DETERMINISTIC GATE (ADR-0051 §3.4) — the model's casual or career reply is
 * untrusted input, and nothing a model wrote reaches a worker without passing here.
 *
 * ONE GATE, NOT TWO. This is the companion career validator (`career-output.validator.ts`) with two
 * walls off by owner ruling (R11): the MONEY wall (typical ₹ ranges are allowed — "aam taur par …")
 * and the NAMED-EMPLOYER wall (company names are allowed freely). Everything else stays on and in
 * the same order: shape (1-4 lines of ≤20 words, ≤3 chips), Latin script only, no "!", no emoji, no
 * format or control characters, persona tokens, promises, sensitive (legal / medical / financial)
 * advice, rating the worker, and PII — the last is ADR-0047 G1's output floor, enforced whatever
 * `AI_RAW_PII_ENABLED` says. No `EmployerNameIndex` lookup either: that is the employer wall's
 * deterministic backstop, and the wall is off.
 *
 * TWO ADDITIONS. `{{` and `}}` are rejected: every reply is rendered through `renderPackText`, which
 * interpolates `{{worker_name}}` and strips any other token, so a model-written placeholder would
 * either put the worker's name in a line the model chose or silently lose words. Neither is the
 * model's to decide. And a line or chip the platform's ABUSE LEXICON flags (`isAbusive`, the
 * deterministic list that strikes a worker) is rejected: a jailbroken casual reply must never serve
 * the worker vulgar text, whatever the persona scan missed.
 *
 * AND THE G1 FLOOR (ADR-0047), on top of `looksLikePii`: `containsHardIdentifier` — the same scanner
 * the résumé parse gates and the companion's edit card apply — drops a PAN, a GSTIN, a cued or
 * credential ID, and a phone number split by `,` `;` `_` `|`, a dash, a middle dot or a danda, none
 * of which `looksLikePii` sees. A scanner that errors rejects too: fail closed.
 *
 * AND THE REGIONAL WALLS (ADR-0051 §9, #2126): a reply in Marathi, Gujarati, Kannada, Telugu or Tamil
 * mixed with English (Latin letters, as Hinglish) is held to the same persona, promise, sensitive
 * and rating bar in that language's own words — `free-chat-regional-walls.ts`.
 *
 * ANY FAILURE SERVES `REPLY_FALLBACK`; the caller logs the closed reason, never a line.
 */

import { isAbusive } from "@badabhai/profiling-lexicon";

import { containsHardIdentifier } from "../resume-import/resume-parse-gates";

import { regionalWallFailure } from "./free-chat-regional-walls";

import {
  screenAnswerWith,
  type CareerAnswerFailure,
  type CareerAnswerText,
  type ContentWalls,
} from "../../chat-companion/v2/career-output.validator";

/** The free chat's walls: the companion's, minus money and named employers (R11). */
export const FREE_CHAT_WALLS: ContentWalls = { money: false, namedEmployer: false };

/** Every way a free-chat reply can fail — the career vocabulary plus the two free-chat checks. */
export type FreeChatAnswerFailure = CareerAnswerFailure | "template_token" | "abusive";

/** The gate's decision: serve the (chip-trimmed) answer, or reject it for one closed reason. */
export type FreeChatScreenResult =
  | { readonly kind: "serve"; readonly answer: CareerAnswerText; readonly droppedChips: number }
  | { readonly kind: "reject"; readonly failure: FreeChatAnswerFailure };

const TEMPLATE_TOKEN = /\{\{|\}\}/;

/**
 * Screen one model reply. The template, abuse, hard-identifier and regional checks run over EVERY
 * line and chip first — a chip the length rule would drop is still model text, and any finding in
 * it rejects the answer,
 * the same "a dropped chip cannot launder unsafe text" rule the career gate applies to its content
 * checks.
 */
export function screenFreeChatAnswer(answer: CareerAnswerText): FreeChatScreenResult {
  const texts = [...answer.lines, ...answer.followup_chips];
  if (texts.some((text) => TEMPLATE_TOKEN.test(text))) {
    return { kind: "reject", failure: "template_token" };
  }
  if (texts.some((text) => isAbusive(text))) return { kind: "reject", failure: "abusive" };
  if (texts.some(carriesHardIdentifier)) return { kind: "reject", failure: "pii" };
  for (const text of texts) {
    const failure = regionalWallFailure(text);
    if (failure !== null) return { kind: "reject", failure };
  }
  return screenAnswerWith(answer, FREE_CHAT_WALLS);
}

/** The G1 floor over one line or chip. A scanner that throws counts as a hit — fail closed. */
function carriesHardIdentifier(text: string): boolean {
  try {
    return containsHardIdentifier(text) !== null;
  } catch {
    return true;
  }
}
