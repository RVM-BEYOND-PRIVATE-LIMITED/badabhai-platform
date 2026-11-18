import { Logger } from "@nestjs/common";

const logger = new Logger("StudentMove");
let warned = false;

/**
 * #2887 — STUDENT_MOVE_ENABLED is on and `student_visibility` is missing (the switch set before the
 * migration was applied): the reader FAILS OPEN to its switch-off statement, exactly today's
 * behaviour, and says so ONCE per process rather than on every request.
 */
export function warnStudentVisibilityMissingOnce(): void {
  if (warned) return;
  warned = true;
  logger.warn(
    "student_visibility missing (sqlstate=42P01) with STUDENT_MOVE_ENABLED on: reading as switch-off " +
      "(moved students follow #2752's rules only) until the student_move migration is applied",
  );
}

/** Test seam: forget that the warning was logged. */
export function resetStudentVisibilityMissingWarning(): void {
  warned = false;
}
