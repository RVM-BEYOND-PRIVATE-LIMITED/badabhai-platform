import { z } from "zod";
import { STILL_LOOKING_ANSWERS } from "@badabhai/db";

/**
 * `POST /workers/me/still-looking` (#2753 item 5). STRICT: the answer and nothing else, so a client
 * can never send a worker id, a check id, a posting or a company along with it (the worker is the
 * session's; the check is the open one, or one his answer opens).
 */
export const AnswerStillLookingSchema = z
  .object({ answer: z.enum(STILL_LOOKING_ANSWERS) })
  .strict();
export type AnswerStillLookingDto = z.infer<typeof AnswerStillLookingSchema>;

/**
 * Both routes' reply (the POST answers the GET shape, so the app reconciles without a second read).
 *
 *  - `due`: an open (unanswered) check exists, so the card shows.
 *  - `check_id`: that open check's id; null when none is open.
 *  - `availability_needs_answer`: his stored availability is empty, or (while the brief's four
 *    answers are switched on) an OLD key, so the card can ask it again with the four.
 *  - `last_active_on`: his last active day (IST `yyyy-mm-dd`), the one definition companies see;
 *    null while `WORKER_ACTIVITY_ENABLED` is off (or he has no day at all).
 *  - `not_recently_active`: the same mark the company rows carry (more than
 *    `NOT_RECENTLY_ACTIVE_DAYS` since that day); false while `WORKER_ACTIVITY_ENABLED` is off.
 */
export interface StillLookingResponse {
  readonly due: boolean;
  readonly check_id: string | null;
  readonly availability_needs_answer: boolean;
  readonly last_active_on: string | null;
  readonly not_recently_active: boolean;
}
