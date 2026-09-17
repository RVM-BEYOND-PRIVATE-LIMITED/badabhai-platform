import type { QuestionPackItem } from "@badabhai/ai-contracts";

import { factForPackItem, type WorkerFactId } from "./worker-fact.registry";

/**
 * ═══ WHICH SURFACE OWNS EACH FACT, FOR THE CHAT ═══ (#1505)
 *
 * `worker-fact.registry.ts` (#1503) names every spelling of a fact; it does not say who is
 * allowed to ASK about it. `f455bb36` appended the universal pack's eight questions to every
 * trade form, and five of them — `preferred_locations`, `shift`, `salary_expected`, `education` —
 * are already owned by pages served three screens later on the résumé/preferences flow. This file
 * is the table that stops the chat asking a fact a page owns, so #1503's defect cannot recur one
 * layer up, in the LLM-led interview rather than the trade form.
 *
 * `CHAT_FACT_OWNER` IS EXHAUSTIVE OVER `WORKER_FACT_IDS`, closed by the `Record` type: adding a
 * fact to the registry without a line here is a compile error, not a silent default.
 *
 * EVERY FACT NOT NAMED `'chat'` DEFAULTS TO `'pages'` — not because a page necessarily asks it
 * today, but because `qp_universal@2` (the corpus the chat actually serves) never asks it either;
 * see `universal-tail.corpus.test.ts`. Naming a fact `'chat'` is a claim that the chat interview
 * is allowed to settle it; everything else stays owned by whatever page eventually asks, exactly
 * as `MARKER_OWNED_FACTS` already describes for the trade form's own marker screens.
 *
 * APPLIES TO EVERY CHAT SESSION, NOT GATED ON `llmLedTurns > 0`. The universal pack's five
 * pages-owned questions are duplicates whether or not Phase A (the LLM-led stretch) ever ran —
 * the deterministic engine asking them straight from `qp_universal@2` is the SAME defect #1503
 * fixed on the trade form, so the filter this file backs (`selectableEnginePacks`,
 * `orchestrator.service.ts`) is unconditional.
 *
 * ═══ OWNER RULING (#1505-2): THIS FILE DOES NOT CLOSE THE WHOLE-TRANSCRIPT FALLBACK READER ═══
 *
 * A fact reading `'pages'` here means the CHAT no longer ASKS it structurally — it does not mean
 * nothing ever reads it out of the interview transcript again. `apps/ai-service/app/routers/
 * interview_prompts.py`'s `extract_system_prompt` continues to read `salary`, `shift`,
 * `preferred_locations`, `education` and `current_city` out of the RAW TRANSCRIPT as a
 * résumé-sheet fallback, and that reader stays wired through `resume-render-input.ts` and
 * `profile-extraction.processor.ts` on this side. KEEP IT — this is a deliberate, signed owner
 * ruling, not dead code a future cleanup should delete because "the chat doesn't ask these any
 * more". A worker who happens to mention his salary or shift preference unprompted while
 * answering something else is still worth capturing on the résumé sheet; this file only stops the
 * chat SOLICITING that answer as a structural question.
 */
export type ChatFactOwner = "chat" | "pages";

export const CHAT_FACT_OWNER: Readonly<Record<WorkerFactId, ChatFactOwner>> = {
  trade: "chat",
  experience: "chat",
  current_city: "chat",
  availability: "chat",
  // PAGES-OWNED — the résumé/preferences/qualifications/employment screens ask these, never the
  // chat (owner ruling 2026-09-15, restated for #1505).
  preferred_locations: "pages",
  shift: "pages",
  salary_expected: "pages",
  education: "pages",
  certifications: "pages",
  work_history: "pages",
  languages: "pages",
  documents_ready: "pages",
  job_type: "pages",
  relocation: "pages",
  accommodation: "pages",
  // ADR-0042 D9 / Layer A (c) — the finishing form's extension keys. Same rule: the chat never
  // solicits them structurally, and the page's write is what settles them.
  work_types: "pages",
  salary_period: "pages",
  commute_max_km: "pages",
  willing_to_travel: "pages",
};

/**
 * Facts that are per-JOB rather than per-WORKER — asked (or, for `experience`, cross-filled) once
 * per experience entry rather than once for the whole interview. Consumed by the cross-fill
 * exclusion in `orchestrator.service.ts`; see the note there on why `experience` is excluded from
 * ORDINARY cross-fill only while a per-job model question is on screen, and not on the turn that
 * answers the composite opener.
 */
export const PER_JOB_FACTS: ReadonlySet<WorkerFactId> = new Set(["experience"]);

/**
 * Is this pack item something the CHAT may serve, settle, or cross-fill?
 *
 * THREE CASES, in the order the registry itself distinguishes them:
 *  - The item names NO registered fact (`factForPackItem` returns `null`) — it is not a worker
 *    fact this table governs at all (a capability question, a marker DTO field, …), so it is
 *    servable by construction. Blocking the unnamed majority of the corpus was never this file's
 *    job; `worker-fact.registry.test.ts` holds that set exhaustive separately.
 *  - The item is only a `prefill_hint` (a yes/no like `shift_work` or `night_work`) — it is
 *    EVIDENCE about a pages-owned fact, not an answer to it (registry docblock, critique-2,
 *    #1503), so it stays servable regardless of which surface owns the fact it hints at. A driving
 *    pack's "do you work nights?" is a skills question about the JOB, not a request to set the
 *    preferences page's shift value, and must not be dropped as though it were the latter.
 *  - The item `settles` a fact — servable only when `CHAT_FACT_OWNER` says the chat owns it.
 *
 * FAILS OPEN ON AMBIGUITY THE SAME WAY THE REGISTRY DOES: `factForPackItem` throws on a pack item
 * naming two facts, and this function does not catch it — a registry defect belongs to
 * `worker-fact.registry.test.ts`, not to a silent drop here.
 */
export function isChatOwnedItem(
  item: Pick<QuestionPackItem, "question_key" | "target_field">,
): boolean {
  const match = factForPackItem(item);
  if (match === null) return true;
  if (match.strength === "prefill_hint") return true;
  return CHAT_FACT_OWNER[match.fact] === "chat";
}

/** Every item the chat may serve, settle, or cross-fill — order preserved. */
export function chatServableItems<
  T extends Pick<QuestionPackItem, "question_key" | "target_field">,
>(items: readonly T[]): T[] {
  return items.filter(isChatOwnedItem);
}

/**
 * Which pack items `fillCrossQuestion` (`orchestrator.service.ts`) may write to from FREE TEXT
 * the worker offered while answering something else.
 *
 * PAGES-OWNED FACTS ARE DROPPED UNCONDITIONALLY, on every turn, `phaseALeads` or not. The chat
 * never writes `salary_expected`, `preferred_locations`, `education` or `shift` through
 * cross-fill, full stop — a worker mentioning "25000 chahiye" while answering the trade question
 * must not silently settle the preferences page's salary field out from under it.
 *
 * `experience` IS ADDITIONALLY DROPPED WHEN `phaseALeads` IS TRUE — but `phaseALeads` here is
 * the caller's judgement of "is a PER-JOB model question on screen right now", not merely
 * "is Phase A (the LLM-led stretch) running". The turn that answers the composite opener
 * ("… aur kitna tajurba hai?") is itself a Phase-A turn with no pack question on screen, and a
 * worker who states a total there must be allowed to have it captured — see the caller's note in
 * `orchestrator.service.ts` on how it computes `phaseALeads` to exclude exactly that turn. What
 * this function guards against is a worker's free text, offered WHILE a per-job "kitne saal is
 * naukri mein?" is on screen, being read as an answer to the WORKER'S total experience — the two
 * questions ask different things and must never share a cross-fill write.
 *
 * The exclusion is intentionally soft: whatever a cross-fill DOES write into `experience_years`
 * is never final. `settleFromLlmDraft` unconditionally overwrites it with the sum of every
 * resolved job entry once Phase A hands over (owner ruling, ADR §1505-1) — sum wins over ANY
 * earlier-written value for this one field, in this one direction only.
 */
export function crossFillItems<T extends Pick<QuestionPackItem, "question_key" | "target_field">>(
  items: readonly T[],
  phaseALeads: boolean,
): T[] {
  return items.filter((item) => {
    const match = factForPackItem(item);
    if (match === null) return true;
    if (match.strength === "prefill_hint") return true;
    if (CHAT_FACT_OWNER[match.fact] === "pages") return false;
    if (phaseALeads && PER_JOB_FACTS.has(match.fact)) return false;
    return true;
  });
}
