import { describe, expect, it } from "vitest";

import { ProfileOccupationUnresolvedPayload } from "@badabhai/event-schema";

import { catalogVersionForEvent } from "./occupation.repository";

/**
 * THE REGRESSION THIS FILE EXISTS FOR, and why no existing test caught it.
 *
 * `OccupationRepository.catalogVersion()` returns a six-field cache signature joined by `:`,
 * two of whose fields are ISO-8601 timestamps. That is ~75 characters against a payload cap of
 * 64 — so passing it straight into `profile.occupation_unresolved` made the event fail its own
 * schema, which threw inside the emitter, which turned `POST /chat/message` into a 500 for
 * EVERY worker whose trade did not resolve on the first attempt.
 *
 * Every unit test passed while that was true. None of them built a real catalogue, so none ever
 * produced a version string longer than its own fixture's. The case below uses a version of the
 * shape the DATABASE actually returns — measured from a seeded local catalogue, not invented.
 */

// Verbatim shape of `catalogVersion()` against a freshly seeded catalogue: alias totals,
// searchable count, active domains, two ISO timestamps, binding count.
const REAL_VERSION =
  "9121:0:3885:2026-08-07T12:24:17.864Z:2026-08-07T12:24:22.762Z:101";

const payload = (catalogVersion: string) =>
  ProfileOccupationUnresolvedPayload.safeParse({
    worker_id: "11111111-1111-1111-1111-111111111111",
    session_id: "22222222-2222-2222-2222-222222222222",
    reason: "below_floor",
    best_score: null,
    deepest_layer: null,
    catalog_version: catalogVersion,
  });

describe("catalogVersionForEvent", () => {
  it("the RAW catalogue version does not fit the payload — which is the whole reason this exists", () => {
    // Guards the premise. If the cap or the signature shape ever changes so that the raw value
    // fits, this test says so instead of leaving a projection nobody can justify.
    expect(REAL_VERSION.length).toBeGreaterThan(64);
    expect(payload(REAL_VERSION).success).toBe(false);
  });

  it("the projection fits, and the event validates", () => {
    const projected = catalogVersionForEvent(REAL_VERSION);
    expect(projected.length).toBeLessThanOrEqual(64);
    expect(payload(projected).success).toBe(true);
  });

  it("is stable — the same catalogue always groups to the same bucket", () => {
    // The Phase 9 sweep groups misses by this value; a version that varied per call would
    // scatter one catalogue across as many buckets as there were events.
    expect(catalogVersionForEvent(REAL_VERSION)).toBe(catalogVersionForEvent(REAL_VERSION));
  });

  it("changes on a byte a 64-character TRUNCATION would have thrown away", () => {
    // This is the case that rules out the obvious cheap fix. `REAL_VERSION` is 65 characters,
    // so `.slice(0, 64)` discards exactly the last one — the low digit of the binding count.
    // Two catalogues differing only there are DIFFERENT catalogues and would have shared a
    // bucket forever.
    const differsOnlyPastTheCut = `${REAL_VERSION.slice(0, -1)}2`;
    expect(differsOnlyPastTheCut.slice(0, 64)).toBe(REAL_VERSION.slice(0, 64)); // truncation collides
    expect(differsOnlyPastTheCut).not.toBe(REAL_VERSION);
    expect(catalogVersionForEvent(differsOnlyPastTheCut)).not.toBe(
      catalogVersionForEvent(REAL_VERSION),
    );
  });

  it("keeps `unknown` as the sentinel for a missing version", () => {
    // A degraded seam must stay distinguishable from a real release rather than acquiring a
    // plausible-looking fake one.
    expect(catalogVersionForEvent(null)).toBe("unknown");
    expect(catalogVersionForEvent(undefined)).toBe("unknown");
    expect(catalogVersionForEvent("")).toBe("unknown");
    expect(payload("unknown").success).toBe(true);
  });
});
