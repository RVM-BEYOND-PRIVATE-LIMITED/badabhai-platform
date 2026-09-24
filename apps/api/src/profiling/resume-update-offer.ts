import { Inject, Injectable, Logger } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";

import { SERVER_CONFIG } from "../config/config.module";
import { WorkersRepository } from "../workers/workers.repository";

/**
 * The résumé-update OFFER (ADR-0043, owner ruling R3, 2026-09-24).
 *
 * ── WHAT IT IS ───────────────────────────────────────────────────────────────────────────
 *
 * A worker who ALREADY has a résumé and finishes another interview is asked, at the point the
 * engine would otherwise close, "Aapki nayi jaankari se resume update kar doon?". A "Haan" is
 * their acceptance: the profile this interview produces is confirmed without the preview, and a
 * new résumé is generated in the background as a new history entry. "Abhi nahi" — or anything
 * this cannot read — closes the interview exactly as it closed before this existed.
 *
 * ── WHY IT IS DETERMINISTIC, AND WHY ITS READER IS STRICT ─────────────────────────────────
 *
 * Fixed copy, two chips, one reader — the `formOfferPrompt` / `resumeConfirm` shape. The model
 * has no part in it (CLAUDE.md §3: AI never owns a business decision).
 *
 * The reader is deliberately NOT the lexicon's `parseAffirmation`, which every other offer uses.
 * That parser answers the 236 boolean pack questions and leans toward yes by design — `theek`,
 * `sahi`, `acha`, `ok`, verb forms like `kar lunga` — with a negator only counted inside its own
 * clause. Measured against this question it read "nahi, purana theek hai" (no, the old one is
 * fine), "pehle wala sahi hai", "main khud kar lunga" and "haan?" all as YES. Here a yes spends
 * AI money in the worker's name and puts a profile they did not review in front of employers, so
 * only an UNAMBIGUOUS yes counts: the chip, its label, or a whole utterance from a small closed
 * set. Anything with a negator, a question mark, or any other words is not a yes.
 *
 * ── AN UNREADABLE REPLY IS A NO ──────────────────────────────────────────────────────────
 *
 * A "Haan" spends AI money in the worker's name and confirms a profile they did not review on
 * the preview; a sentence nobody understood must never do either. Unlike the other offers it is
 * not re-asked: it is the LAST turn of the interview, and a worker who typed something else has
 * told us they are done — the ordinary close, and the preview they already know, follow.
 */

/**
 * The bubble. Aap-form, one question, no exclamation, no emoji, under twenty words — the
 * persona rules the pack copy is checked against.
 */
export const RESUME_UPDATE_OFFER_PROMPT = "Aapki nayi jaankari se resume update kar doon?";

/**
 * The reply after a "Haan" — the turn that ends the interview. Says what happens and where to
 * look, because the worker is about to leave the chat and the résumé arrives a minute later.
 */
export const RESUME_UPDATE_ACCEPTED_REPLY =
  "Theek hai. Aapka resume update ho raha hai, thodi der mein Resume tab mein dikhega.";

/**
 * The two chips.
 *
 * KEYS THAT CANNOT COLLIDE with anything a shipped client routes on: the post-completion resume
 * menu's `resume_upload` / `resume_chat_create` / `resume_edit` / `resume_redo` and the six
 * `section_*` keys all trigger client-side navigation, and a chip sharing one would send the
 * worker to a screen instead of answering the question.
 */
export const RESUME_UPDATE_OFFER_OPTIONS = Object.freeze([
  Object.freeze({
    option_key: "update_offer_yes",
    label_text: "Haan, update karein",
    value: true,
    implies_skill_id: null,
    is_none_of_above: false,
  }),
  Object.freeze({
    option_key: "update_offer_no",
    label_text: "Abhi nahi",
    value: false,
    implies_skill_id: null,
    is_none_of_above: false,
  }),
]);

export type ResumeUpdateOfferReply = "accept" | "decline" | "unclear";

/** Case-, space- and trailing-full-stop-insensitive; commas read as spaces. Never strips `?`. */
function normalizeReply(text: string): string {
  return text
    .normalize("NFC")
    .toLowerCase()
    .replace(/[,]+/g, " ")
    .replace(/[.!।]+\s*$/u, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * THE WHOLE-UTTERANCE YESES — typed, tapped on an old client (the label), or transcribed from
 * speech. Closed on purpose: a phrase earns its place here only if it cannot mean anything but
 * "yes, update it".
 */
const ACCEPT_UTTERANCES: ReadonlySet<string> = new Set(
  [
    RESUME_UPDATE_OFFER_OPTIONS[0]!.label_text,
    "haan",
    "haa",
    "han",
    "haan ji",
    "haanji",
    "ji haan",
    "yes",
    "haan update karo",
    "haan update karein",
    "haan update kar do",
    "update karo",
    "update karein",
    "update kar do",
    "हाँ",
    "हां",
    "हाँ जी",
    "जी हाँ",
    "हाँ अपडेट करो",
  ].map(normalizeReply),
);

/** A negator ANYWHERE in the reply rules out a yes, whatever else it says. */
const NEGATOR = /(^|[\s])(nahi|nahin|nai|na|mat|no|not|rehne|नहीं|नही|मत|ना)([\s]|$)/u;

/**
 * What the worker's reply means.
 *
 * `accept` ONLY for the chip key, the chip's label, or a whole utterance in
 * {@link ACCEPT_UTTERANCES}. `decline` for the "Abhi nahi" chip or label, or any reply carrying a
 * negator. EVERYTHING ELSE IS `unclear`, which the caller treats as a no — including a question
 * ("haan?"), a hedge ("theek hai, baad mein") and a yes with conditions ("haan lekin baad mein").
 */
export function readResumeUpdateOfferReply(text: string): ResumeUpdateOfferReply {
  const trimmed = text.trim();
  const chip = RESUME_UPDATE_OFFER_OPTIONS.find((option) => option.option_key === trimmed);
  if (chip) return chip.value ? "accept" : "decline";

  const reply = normalizeReply(text);
  if (reply === normalizeReply(RESUME_UPDATE_OFFER_OPTIONS[1]!.label_text)) return "decline";
  if (NEGATOR.test(reply)) return "decline";
  if (reply.includes("?")) return "unclear";
  return ACCEPT_UTTERANCES.has(reply) ? "accept" : "unclear";
}

/**
 * WHO IS OFFERED. A worker who already has a résumé — the offer is an UPDATE, and a first-time
 * worker's flow must stay exactly as it is (ruling R3) — and only while
 * `RESUME_CHAT_UPDATE_OFFER_ENABLED` is on.
 *
 * FAILS TO "NO OFFER" on any read error. No offer is precisely the pre-0125 interview, so the
 * safe failure costs a worker one question, never their close.
 *
 * ITS OWN PROVIDER, trailing and optional on the orchestrator, because the orchestrator holds no
 * config and a Postgres read on its hot path should be a named, fakeable thing rather than a
 * repository call buried in the turn loop. It is consulted once per interview, at the close.
 */
@Injectable()
export class ResumeUpdateOfferPolicy {
  private readonly logger = new Logger(ResumeUpdateOfferPolicy.name);

  constructor(
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    private readonly workers: WorkersRepository,
  ) {}

  async eligible(workerId: string): Promise<boolean> {
    if (!this.config.RESUME_CHAT_UPDATE_OFFER_ENABLED) return false;
    try {
      return (await this.workers.latestResume(workerId)) !== undefined;
    } catch (err) {
      this.logger.warn(
        `résumé-update offer skipped for worker ${workerId}: eligibility unreadable (${
          err instanceof Error ? err.name : "UnknownError"
        })`,
      );
      return false;
    }
  }
}
