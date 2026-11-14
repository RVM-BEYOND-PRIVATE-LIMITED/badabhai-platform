import { BadRequestException } from "@nestjs/common";
import {
  CAMPUS_EARLIEST_DECISION_TIME,
  CAMPUS_MAX_CLOCK_SKEW_MS,
  type CampusErrorCode,
} from "./campus-link.contract";

const EARLIEST_MS = Date.parse(CAMPUS_EARLIEST_DECISION_TIME);

/**
 * #2746 PR 5 — a Campus time (`decided_at`, `as_of`) must be a time BadaBhai can order and store:
 * not before {@link CAMPUS_EARLIEST_DECISION_TIME} (a year-0000 time parses in JavaScript and then
 * fails Postgres's `timestamptz` cast, 22008), and not more than {@link CAMPUS_MAX_CLOCK_SKEW_MS}
 * ahead of BadaBhai's clock (both writes keep the NEWEST decision or list by Campus's clock, so a
 * time from the future would outrank every later one for as long as the gap lasts).
 *
 * Either failure is the same 400 `VALIDATION_FAILED` shape as a schema failure, naming the field,
 * before anything is read or written. `nowMs` is BadaBhai's clock (the api host, NTP-synced); a
 * parameter so tests can pin it.
 */
export function assertCampusTime(
  field: "decided_at" | "as_of",
  value: string,
  nowMs: number = Date.now(),
): void {
  const at = Date.parse(value);
  if (!Number.isFinite(at) || at < EARLIEST_MS) {
    throw campusTimeRefused(field, `before ${CAMPUS_EARLIEST_DECISION_TIME}`);
  }
  if (at - nowMs > CAMPUS_MAX_CLOCK_SKEW_MS) {
    throw campusTimeRefused(
      field,
      `more than ${CAMPUS_MAX_CLOCK_SKEW_MS / 1000} seconds ahead of BadaBhai's clock`,
    );
  }
}

function campusTimeRefused(field: string, message: string): BadRequestException {
  return new BadRequestException({
    code: "VALIDATION_FAILED" satisfies CampusErrorCode,
    message: "Validation failed",
    issues: [{ path: field, message }],
  });
}
