import { z } from "zod";
import {
  WORKER_FEEDBACK_ATTACHMENT_PATH_MAX,
  WORKER_FEEDBACK_ATTACHMENTS_MAX,
  WORKER_FEEDBACK_CATEGORIES,
  WORKER_FEEDBACK_MESSAGE_MAX,
} from "@badabhai/types";

/**
 * Control characters that must never enter the `message` column.
 *
 * `\t`, `\n` and `\r` are DELIBERATELY absent from this set — this is a multi-line free-text box
 * and a worker pressing Enter is not an attack. NUL in particular is not merely undesirable:
 * Postgres `text` cannot store it, so without this check the insert throws a driver error the
 * worker would see as a generic 500 after typing a paragraph. Rejecting at the edge turns that
 * into an honest 400 with a message that says what was wrong.
 *
 * Written with `\uXXXX` ESCAPES, never as literal bytes — `source-hygiene.test.ts` scans the
 * whole repo for raw control characters in source, and this file would be its first hit.
 */
// eslint-disable-next-line no-control-regex -- matching control characters is the entire job.
const FORBIDDEN_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/**
 * Worker SELF-service app feedback — the body of `POST /workers/me/feedback` (#997).
 *
 * NO `worker_id`, AND `.strict()` SO SENDING ONE IS A 400 RATHER THAN A NO-OP. The submitting
 * worker comes from the bearer token via `@CurrentWorker`; a body-supplied id would be an IDOR
 * attempt, and silently dropping it would let a client ship code that believes it is filing
 * feedback on someone else's behalf and never be told otherwise (the #694 precedent).
 *
 * `category` is OPTIONAL, and `.optional()` rather than `.nullable()` is the shape that matches
 * the wire: the shipped client omits the key entirely when the worker did not tag their message
 * (`if (category != null)`) and never sends an explicit null. An UNKNOWN value is a 400 rather
 * than a coercion to `"other"` — the only client that exists sends one of three frozen tokens,
 * so anything else is a bug or a forged request, and quietly relabelling it would put a lie into
 * the category histogram ops make decisions from.
 *
 * `message` is the worker's OWN words and may contain their own PII. It is stored, and shown to
 * admins, and that is the entire feature — but it is never logged, never carried on an event,
 * and never echoed back: the response is `{ ok: true }` and nothing else.
 *
 * `screen` is the route the worker was on when they tapped Feedback, and it is OPTIONAL so that
 * every already-released client — none of which sends it — keeps working unchanged. It is typed
 * `unknown` ON PURPOSE, which is the one place this schema deliberately validates nothing:
 *
 *   EVERY refinement that could go here (a type check, a length, a charset) is a 400, and a 400
 *   on this field throws away the paragraph the worker typed over a telemetry value they never
 *   filled in. `resolveScreenTemplate` takes it from here and returns one of the worker app's own
 *   screen constants or `null` — the SANITIZE-NEVER-REJECT posture `sanitizeAppBuild` already
 *   applies to `x-app-build`, whose signature is `unknown` for exactly this reason. The key still
 *   has to be DECLARED, because `.strict()` would otherwise 400 the very clients this field is for.
 *
 *   Validating nothing here is also SAFE here, which is not a general licence: the value never
 *   reaches a sink. It is compared against a closed table and then discarded — what continues is
 *   a constant of ours — so there is no shape a zod refinement could catch that the resolver does
 *   not already refuse by returning `null`.
 */
export const SubmitFeedbackSchema = z
  .object({
    message: z
      .string()
      .trim()
      // Trim BEFORE the bounds, so a box full of spaces is an empty message rather than a
      // 400-character one — and so the length that reaches the event is the length that was
      // stored.
      .min(1, "message is required")
      // The only bound that exists on this text: the shipped app deliberately imposes no client
      // cap. The `worker_feedback_message_len_chk` CHECK pins the same number, because a DTO is
      // the first line of defence and not the last.
      .max(WORKER_FEEDBACK_MESSAGE_MAX, "message is too long")
      .refine((s) => !FORBIDDEN_CONTROL.test(s), "message must not contain control characters"),
    category: z.enum(WORKER_FEEDBACK_CATEGORIES).optional(),
    // See the header. Declared, never validated — resolved or nulled by `resolveScreenTemplate`.
    screen: z.unknown().optional(),
    /**
     * The object keys of the images the worker attached (#1191), minted by
     * `POST /workers/me/feedback/attachment/upload-url` and PUT to Storage by the client before
     * this call.
     *
     * ⚠ THIS SCHEMA IS NOT THE OWNERSHIP CONTROL AND MUST NOT BE READ AS ONE. Everything here is
     * a SHAPE bound — an array, at most three, each a non-empty string under
     * {@link WORKER_FEEDBACK_ATTACHMENT_PATH_MAX} — and a caller who sends
     * `["feedback-attachments/<someone-else>/<uuid>.jpg"]` passes every one of them. The control
     * is in `FeedbackService.submit`, which tests each path against the minted-key shape for the
     * SESSION worker (`@CurrentWorker`, never the body) and 400s the whole submission on any
     * mismatch. What the bounds here are for is arriving at that regex with something small: they
     * stop a megabyte of caller-chosen bytes, or ten thousand of them, being handed to
     * `RegExp.test` at all.
     *
     * `.optional()` AND NEVER `.default([])`. The shipped client omits the key entirely when the
     * worker attached nothing — it does not send `[]` — and the column mirrors that: absent means
     * NULL, which every reader treats as "no images". Defaulting here would write `[]` on every
     * text-only submission and make a row that predates this feature indistinguishable from one
     * where the mint 503'd and the client dropped the image, which is exactly the degradation
     * `attachment_count` exists to make visible on the spine.
     *
     * The array itself is NOT `.min(1)`: an explicit empty array from some future client is a
     * truthful "no images", and 400ing it would cost that worker their typed message over a
     * distinction nothing downstream can act on.
     */
    attachment_paths: z
      .array(z.string().trim().min(1).max(WORKER_FEEDBACK_ATTACHMENT_PATH_MAX))
      .max(WORKER_FEEDBACK_ATTACHMENTS_MAX)
      .optional(),
  })
  .strict();
export type SubmitFeedbackDto = z.infer<typeof SubmitFeedbackSchema>;
