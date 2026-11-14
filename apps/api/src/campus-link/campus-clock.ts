import { BadRequestException } from "@nestjs/common";
import { CAMPUS_MAX_CLOCK_SKEW_MS, type CampusErrorCode } from "./campus-link.contract";

/**
 * #2746 PR 5 — a Campus time (`decided_at`, `as_of`) may not be from BadaBhai's future.
 *
 * Both writes keep only the NEWEST decision or list, by Campus's own clock, so a time far ahead
 * would outrank every later one for as long as the gap lasts. Up to {@link CAMPUS_MAX_CLOCK_SKEW_MS}
 * ahead is tolerated (two servers' clocks); beyond it the body is refused with the same 400
 * `VALIDATION_FAILED` shape as a schema failure, naming the field. Nothing is read or written first.
 *
 * `nowMs` is BadaBhai's clock (the api host, NTP-synced); a parameter so tests can pin it.
 */
export function assertNotAheadOfBadaBhai(
  field: "decided_at" | "as_of",
  value: string,
  nowMs: number = Date.now(),
): void {
  const at = Date.parse(value);
  if (Number.isFinite(at) && at - nowMs <= CAMPUS_MAX_CLOCK_SKEW_MS) return;
  throw new BadRequestException({
    code: "VALIDATION_FAILED" satisfies CampusErrorCode,
    message: "Validation failed",
    issues: [
      {
        path: field,
        message: `more than ${CAMPUS_MAX_CLOCK_SKEW_MS / 60_000} minutes ahead of BadaBhai's clock`,
      },
    ],
  });
}
