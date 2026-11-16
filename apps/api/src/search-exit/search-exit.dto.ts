import { z } from "zod";

/**
 * `PUT /workers/me/search-visibility` (#2753 item 6). STRICT: `visible` and nothing else, so a
 * client can never send a worker id, a `via` or a consent purpose along with it (the worker is the
 * session's; the via is the route's).
 */
export const SetSearchVisibilitySchema = z.object({ visible: z.boolean() }).strict();
export type SetSearchVisibilityDto = z.infer<typeof SetSearchVisibilitySchema>;

/**
 * Both routes' reply: whether companies can find him now, and since when he has been out
 * (`hidden_at` as an ISO instant; null while he is in search).
 */
export interface SearchVisibilityResponse {
  readonly visible: boolean;
  readonly hidden_since: string | null;
}
