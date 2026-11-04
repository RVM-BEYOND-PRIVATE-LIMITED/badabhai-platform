import type { ProfileSource } from "@badabhai/types";
import type { FieldSource } from "../profiles/worker-field-precedence";
import { resolveResumeSource } from "../resume/resume-source";

/**
 * WHICH WRITER PUT A STORED VALUE THERE — the provenance half of the admin candidate read
 * (ADR-0062, #2560). PURE: each function maps the columns a row already carries to one
 * {@link FieldSource}, and says `unknown` wherever those columns cannot tell. Nothing here reads
 * a value, and nothing here is a rank input.
 *
 * It sits beside `profile-summary.mapper.ts` because the summary is the read whose values the
 * admin view mirrors; the precedence rules themselves stay in `worker-field-precedence.ts`.
 */

/**
 * The road that produced a `worker_profiles` row, as a field source — through
 * {@link resolveResumeSource}, the rule the résumé history label already uses: an accepted CV
 * import wins over the road (owner ruling R1), then the road itself. A pre-0107 row with no road
 * is `unknown`, never a guessed one; no profile at all is `none`.
 */
export function profileRowSource(
  profile:
    | {
        readonly source?: ProfileSource | string | null;
        readonly seededFromImportId?: string | null;
      }
    | null
    | undefined,
): FieldSource {
  if (!profile) return "none";
  const road = profile.source === "form" || profile.source === "chat" ? profile.source : null;
  switch (
    resolveResumeSource({ source: road, seededFromImportId: profile.seededFromImportId ?? null })
  ) {
    case "resume_upload":
      return "resume_import";
    case "chat":
      return "interview";
    case "form":
      return "form";
    default:
      return "unknown";
  }
}

/**
 * The provenance columns of one `worker_attributes` row, plus the source of the pack answer it
 * was projected from (joined on `(worker_id, pack_id, question_key)`, null when none matched).
 * No value column — provenance only.
 */
export interface AttributeProvenance {
  readonly attributeKey: string;
  /** `worker_attributes.source` — the CAPTURE mechanism (`answer_map` | `llm_parse`). */
  readonly valueSource: string;
  readonly hasPack: boolean;
  readonly hasSession: boolean;
  /** `worker_pack_answer.source` (`chat` | `chip` | `form` | `ops` | `resume`), or null. */
  readonly answerSource: string | null;
}

/**
 * One attribute's source, from the columns its writers stamp:
 *
 *   1. The pack answer it was projected from says how the answer reached us — `chat`/`chip` is the
 *      interview, `form` the trade form, `resume` the CV autofill, `ops` an operator.
 *   2. No pack AND no session is the one writer that stamps neither: `WorkerPreferencesService`
 *      (the worker's preferences page, the finishing form's write, a confirmed chat edit).
 *   3. No pack WITH a session is the general form (`GeneralFormService.formRow`).
 *   4. An `llm_parse` value is the extraction's parse of the interview.
 *   5. Anything else — a pack-backed row whose answer row is keyed differently — is `unknown`:
 *      `WorkerAttributesRepository.loadKeys` documents that pack/session alone stopped being a
 *      reliable "written on this form" marker, so it is not guessed from them.
 */
export function attributeSourceOf(row: AttributeProvenance | undefined): FieldSource {
  if (!row) return "none";
  switch (row.answerSource) {
    case "chat":
    case "chip":
      return "interview";
    case "form":
      return "form";
    case "resume":
      return "resume_import";
    case "ops":
      return "ops";
    default:
      break;
  }
  if (!row.hasPack && !row.hasSession) return "worker_edit";
  if (!row.hasPack && row.hasSession) return "form";
  if (row.valueSource === "llm_parse") return "interview";
  return "unknown";
}

/**
 * A `worker_skill` row's source. `derived_coarse` is the match derivation; `interview` is stamped
 * ONLY by the worker's own "do you want this work?" answer (`setWantsAndReconcile` /
 * `clearAllWantsAndReconcile`), so it reads as the worker's edit; `ops` is operator-authored.
 */
export function workerSkillSourceOf(source: string): FieldSource {
  switch (source) {
    case "derived_coarse":
      return "derived";
    case "interview":
      return "worker_edit";
    case "ops":
      return "ops";
    default:
      return "unknown";
  }
}

/**
 * The occupation-matcher status on a profile's `job_domain_id`: the worker confirming the match is
 * his answer; every other `matched_*` status is the matcher's.
 */
export function jobDomainSourceOf(matchStatus: string | null | undefined): FieldSource {
  if (matchStatus === "matched_worker_confirmed") return "worker_edit";
  return typeof matchStatus === "string" && matchStatus.startsWith("matched")
    ? "derived"
    : "unknown";
}
