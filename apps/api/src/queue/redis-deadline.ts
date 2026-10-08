/**
 * A BOUND ON ONE REDIS INTERACTION over the shared BullMQ connection — the helper every fail-open
 * Redis read (and best-effort write) on a request path runs under.
 *
 * WHY A TRY/CATCH IS NOT ENOUGH. `queue.module.ts` builds the shared connection with
 * `maxRetriesPerRequest: null` (BullMQ's blocking commands require it), and nothing in this repo
 * sets `enableOfflineQueue` — so ioredis defaults it to `true`. Under that pair a command issued
 * while the connection is down is BUFFERED IN MEMORY AND NEVER REJECTS: it waits for a reconnect
 * that may never come. The `catch` is unreachable and the `await` never returns, so a class that
 * promises to "fail open" instead HANGS the request that called it. Racing a timer is what
 * actually keeps that promise; the try/catch only handles the errors that do surface.
 *
 * WHO MAY USE IT: a caller for which "no answer" is a correct answer — a cache miss, "not cooling
 * down", "no memory". Never a fail-CLOSED check (a rate limit, a spend ledger): there a timeout
 * must refuse, not permit, and those callers own their own bound.
 *
 * ONE RECORDED EXCEPTION: `FreeChatNewsCap` (ADR-0054 R5, the live-news daily cap). It is a
 * fail-closed counter that uses this helper because its timeout path REFUSES — a rejection here
 * becomes "no news call", never "unlimited calls" — so the race bounds a hang without permitting
 * anything. The late-landing caveat below applies to it and is accepted there: a reservation that
 * lands after its timeout holds one slot until the IST day ends (the refusing direction), and the
 * `daily_count` its event reports may then be one low. Any other fail-closed caller still owns its
 * own bound.
 *
 * THE ABANDONED COMMAND STILL RUNS. `Promise.race` cancels nothing, so a timed-out write may land
 * after the caller moved on. A caller whose write must not land late (a counter that an event
 * reports) must not use this.
 */

/**
 * How long a Redis interaction may take before it is abandoned.
 *
 * 150 ms is ~two orders of magnitude above a healthy same-network round trip (low single-digit ms
 * on the compose network / VPC) and still far below anything a worker would notice, so it cannot
 * trip on a merely loaded box while still bounding a dead one.
 */
export const REDIS_TIMEOUT_MS = 150;

/** The race was lost to the timer. `name` is what the callers' PII-free warn lines print. */
export class RedisDeadlineExceededError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`redis interaction exceeded ${timeoutMs}ms`);
    this.name = "RedisDeadlineExceededError";
  }
}

/**
 * Run `work` under `timeoutMs`, rejecting with {@link RedisDeadlineExceededError} if it has not
 * settled by then. A rejection from `work` itself propagates unchanged.
 *
 * `work` MUST INCLUDE THE CLIENT AWAIT. BullMQ's `queue.client` is a promise that resolves on
 * connection; during an outage it can be pending, so a bound that only covered the command would
 * still be preceded by an unbounded await.
 *
 * THE LOSING PROMISE IS DEFUSED: if `work` rejects after the timer won (the reconnect finally
 * fails), that rejection has a handler, so it cannot take the process down as an
 * `unhandledRejection`.
 */
export async function withinRedisDeadline<T>(
  work: () => Promise<T>,
  timeoutMs: number = REDIS_TIMEOUT_MS,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const attempt = (async () => work())();
  attempt.catch(() => undefined);
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new RedisDeadlineExceededError(timeoutMs)), timeoutMs);
  });
  try {
    return await Promise.race([attempt, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
