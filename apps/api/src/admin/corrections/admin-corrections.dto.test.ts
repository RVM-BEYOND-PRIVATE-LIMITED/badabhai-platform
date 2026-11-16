import { describe, expect, it } from "vitest";

import {
  AVAILABILITY_STATUSES_V1,
  AVAILABILITY_STATUSES_V2,
} from "../../profiles/worker-preferences.vocabulary";
import { correctionValueSchema } from "./admin-corrections.dto";

/**
 * #2753 item 3 — an admin availability correction takes a key of EITHER set, exactly as the
 * worker's own PUT does. The schema reads no flag, so this holds with
 * `AVAILABILITY_ANSWERS_V2_ENABLED` on and off alike: the switch changes which chips a worker is
 * offered, never what may be written.
 */
describe("admin availability correction — both answer sets (#2753 item 3)", () => {
  const schema = correctionValueSchema("availability");

  it.each([...Object.keys(AVAILABILITY_STATUSES_V1), ...Object.keys(AVAILABILITY_STATUSES_V2)])(
    "accepts %s",
    (status) => {
      expect(schema.safeParse({ status }).success).toBe(true);
    },
  );

  it("keeps the rest of the shape: a date and a notice beside a new key, and null clears", () => {
    expect(
      schema.safeParse({
        status: "in_15_days",
        available_from: "2026-12-01",
        notice_period_days: 15,
      }).success,
    ).toBe(true);
    expect(schema.safeParse(null).success).toBe(true);
  });

  it("still refuses a status neither set knows, and an unknown key", () => {
    expect(schema.safeParse({ status: "next_week" }).success).toBe(false);
    expect(schema.safeParse({ status: "Can join now" }).success).toBe(false);
    expect(schema.safeParse({ status: "join_now", extra: true }).success).toBe(false);
  });
});
