import { capBreachReasonLabel } from "./ai-cost";
import type { Tone } from "../components/status-pill";

/**
 * How an AI call trace is ALLOWED to be described. Pure, so every rule below is testable in the
 * node environment this app's vitest runs in, and — the load-bearing half — separate from the
 * pages so that the ONE claim on this surface that must not overreach is written down once.
 *
 * ══ THE CLAIM THIS MODULE EXISTS TO KEEP HONEST ═════════════════════════════════════════
 * The detail screen prints a worker's own words, in bulk, to an operator. The portal may
 * therefore state what the PLATFORM ENFORCES and nothing beyond it:
 *
 *   ENFORCED — the stored text is AES-256-GCM ciphertext in the database (a CHECK constraint
 *     refuses prose outright); decrypting needs the `read_ai_traces` capability; the read sits
 *     behind a default-off switch; an `admin.ai_trace_viewed` audit row is committed BEFORE any
 *     plaintext exists, so a read that was not recorded did not happen; a per-admin allowance
 *     caps how many can be read; and there is no route that searches or exports the text.
 *
 *   NOT ENFORCED, AND NEVER TO BE IMPLIED — that the text carries no identity. What is stored is
 *     the AI service's own copy of the prompt and the reply, taken AFTER its pseudonymizer ran
 *     on them. That is a real improvement over the first cut, which stored the request `apps/api`
 *     assembled — i.e. the worker's raw words — but it is a statement about which STEP RAN, not
 *     about the result: the pseudonymizer is a best-effort transform over free text and R32
 *     measured its name gazetteer dead at 348 leaks in 487 probes. So the words below may still
 *     name the worker, their employer, or carry a phone number.
 *
 * A previous tooltip on this platform told an operator "every id is replaced" while an Aadhaar
 * number sat on the screen. {@link AI_TRACE_TEXT_CAVEAT} is the sentence that must not become
 * that one, and `ai-trace-view.test.ts` pins its shape rather than trusting review to notice.
 */

// ---------------------------------------------------------------------------
// The filter vocabulary (mirrored by hand — the portal takes no dependency on
// the API's packages, so every server vocabulary it pins is pinned explicitly)
// ---------------------------------------------------------------------------

/**
 * The task types offered in the filter, mirroring `aiTaskType` in `@badabhai/event-schema`.
 *
 * THIS IS A UI VOCABULARY, NOT A CONTRACT. It decides which options the dropdown OFFERS; it
 * never narrows what the list may DISPLAY. The stored column is `text` with no IN-list CHECK
 * on purpose (a new ai-service task type must not need a migration before the deploy), so a
 * row can legitimately arrive carrying a value this build has never heard of — and
 * {@link taskTypeLabel} shows it de-snaked rather than dropping the row, which is the same
 * ruling `screen_context` makes on the feedback list. Pinning the response schema to this list
 * would blank the whole page on the day a surface is added, which is the one way the portal
 * could make a new task type worse than invisible.
 */
export const AI_TRACE_TASK_TYPES = [
  "profiling_chat_turn",
  "profile_extraction",
  "profile_parse",
  "resume_generation",
  "domain_match",
  "stt_transcription",
  "tts_synthesis",
  "skill_embedding",
  "job_posting_chat_turn",
] as const;

export type AiTraceTaskType = (typeof AI_TRACE_TASK_TYPES)[number];

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/**
 * Human names for the half of `AI_TRACE_ERROR_CODES` that is NOT a spend-cap reason.
 *
 * The other half — the six `AI_SPEND_CAP_REASONS` this set spreads in — is already worded on
 * the dashboard, and {@link aiTraceErrorLabel} delegates to that map rather than restating it.
 * Two label maps for one vocabulary is how the same code ends up reading two different ways on
 * two screens of the same console.
 */
const ERROR_CODE_LABELS: Record<string, string> = {
  // Terminal codes the AI service returns per surface.
  stt_budget_blocked: "Speech budget blocked",
  stt_call_failed: "Speech call failed",
  stt_service_unreachable: "Speech service unreachable",
  translate_call_failed: "Translation call failed",
  extract_deadline_exceeded: "Extraction deadline exceeded",
  // Minted by the trace recorder itself — see `aiTraceErrorNote`.
  provider_error: "Provider failed — code not recognised",
  unknown_error: "Failed, with no code",
};

/**
 * One error code as words.
 *
 * Falls through to `capBreachReasonLabel`, which names the six spend-cap reasons and de-snakes
 * anything it does not recognise — so an unmapped code renders raw rather than blank, the same
 * ruling `creditReasonLabel` makes. A code this portal has not been taught about is a reason to
 * look, not a reason to render an empty cell.
 */
export function aiTraceErrorLabel(code: string): string {
  return ERROR_CODE_LABELS[code] ?? capBreachReasonLabel(code);
}

/**
 * What a failed call's code means for an operator, or null when the code needs no gloss.
 *
 * Only the two the RECORDER mints get one, because only they describe the recording rather than
 * the call: `provider_error` is the code saying an unrecognised provider string was thrown away
 * on purpose, and an operator who does not know that will go looking for the message it never
 * kept.
 */
export function aiTraceErrorNote(code: string): string | null {
  if (code === "provider_error") {
    return (
      "The provider reported something this platform's closed list does not contain. The string " +
      "itself was discarded rather than stored — a provider message routinely quotes the request " +
      "back, which would put the worker's words in a column that is not encrypted. What survives " +
      "is the only part a triage query needs: it failed on the far side."
    );
  }
  if (code === "unknown_error") {
    return "The call failed and reported no code at all. That is a distinct state, not a missing value.";
  }
  return null;
}

// NO `taskTypeLabel` HERE. `lib/ai-cost.ts` already exports one, over the same `aiTaskType`
// vocabulary, and the AI-spend panel renders it — a second copy is how `profile_parse` ends up
// reading one way on the dashboard and another here. The pages import it from there.

// ---------------------------------------------------------------------------
// Outcome
// ---------------------------------------------------------------------------

/**
 * How the outcome cell reads.
 *
 * The tone is passed EXPLICITLY wherever this is rendered, because `StatusPill`'s own map keys
 * off the VALUE and knows none of these words. A failure is `bad` and a success is `ok`; there
 * is no `warn` middle, because the column answers one boolean the server already decided.
 */
export function outcomeTone(success: boolean): Tone {
  return success ? "ok" : "bad";
}

/**
 * Whether a provider was really called, as the portal already words it elsewhere: `real` reads
 * `ok` and `mock` reads `warn` (`healthTone` in `lib/format.ts`, the TD81 ruling — staging
 * looked healthy for weeks behind a mocked provider, so simulated work never renders in the
 * same type as the real thing).
 */
export function realCallLabel(realCall: boolean): string {
  return realCall ? "real" : "mock";
}

// ---------------------------------------------------------------------------
// The two halves of the call, and the three states each of them has
// ---------------------------------------------------------------------------

/**
 * What the detail screen can honestly say about one half (request or reply) of a call.
 *
 * `text: null` from the API is AMBIGUOUS BY THE SERVER'S OWN ADMISSION — it means either "the
 * column was null" (a call with no request text, or one that failed before replying) or "the
 * ciphertext would not decrypt". The service degrades both to null on purpose rather than
 * describing the state of our key material to a caller.
 *
 * The LENGTH disambiguates it, and that is the whole reason this function exists. The writer
 * derives `prompt_chars` and `prompt_enc` from the same value in the same statement — a length
 * is recorded exactly when text was stored — so a non-null length beside a null string means
 * the text WAS there and did not come back. Saying "there was no request" in that case would
 * report a decryption failure as an absence, and an operator would stop looking.
 */
export type AiTraceHalfState =
  | { kind: "text"; text: string }
  | { kind: "absent" }
  | { kind: "undecryptable"; chars: number };

export function aiTraceHalf(text: string | null, chars: number | null): AiTraceHalfState {
  if (text !== null) return { kind: "text", text };
  if (chars !== null) return { kind: "undecryptable", chars };
  return { kind: "absent" };
}

// ---------------------------------------------------------------------------
// The privacy copy — the one string on this surface that must not overreach
// ---------------------------------------------------------------------------

/**
 * THE CAVEAT. Every word of it is a statement about something the code does, or an explicit
 * refusal to promise something it does not.
 *
 * It says what the text IS — the AI service's own prompt and reply, after its identity-rewriting
 * step ran. It says why that is not a guarantee: the step is best-effort and is measured to miss
 * names. It then tells the operator what to DO with that: treat it as identifying.
 *
 * ⚠ THE SENTENCE THIS REPLACED SAID THE OPPOSITE, AND WAS ALSO TRUE AT THE TIME. The first cut
 * stored the request `apps/api` assembled and sent — raw worker words, captured BEFORE the
 * boundary — so the copy correctly said the rewriting step "runs after this text was captured".
 * The writer now reads the ai-service's own masked pair instead, so that sentence would now be
 * wrong in the direction that matters least (it would understate) but wrong nonetheless, and
 * copy that is stale in one direction gets edited in the other. The claim moved with the code.
 *
 * It must never grow a sentence of the form "names/numbers/ids are removed". "The step ran" is
 * as far as this may go; an operator who reads "removed" will paste the text somewhere.
 */
export const AI_TRACE_TEXT_CAVEAT =
  "What is stored is the AI service's own copy of the prompt it was given and the reply it " +
  "produced, after the step that rewrites identifying details had run over both. That step is " +
  "best-effort and is measured to miss names it does not recognise, so nothing here guarantees " +
  "a name, a phone number, an employer or an address is not still in the words below. Treat " +
  "everything below as identifying.";

/**
 * The other half of the same honesty: what IS enforced. Stated separately so neither sentence
 * can be read as softening the other, and phrased without naming a role — the role→capability
 * matrix is the server's and is rendered from it on the Roles screen, never copied here.
 */
export const AI_TRACE_TEXT_CONTROLS =
  "The text is encrypted in the database, there is no search over it and no export, and this " +
  "read has already been written to the audit spine against your admin id — the record is " +
  "committed before anything is decrypted, so a read that was not recorded did not happen. " +
  "Opening or reloading this page spends one of a small hourly allowance.";
