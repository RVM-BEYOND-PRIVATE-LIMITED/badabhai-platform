import { describe, expect, it } from "vitest";
import { AGENCY_TWIN_ORG_LABEL, AGENCY_TWIN_SYSTEM_ACTOR_ID } from "@badabhai/config";
import {
  agencyTwinOperation,
  diffAgencyTwin,
  planAgencyTwin,
  type AgencyTwinContext,
  type AgencyTwinSource,
  type AgencyTwinValues,
  type AgencyTwinWrite,
} from "@badabhai/db";
import { createEvent } from "@badabhai/event-schema";
import { killSwitchPayload, twinSyncedPayload } from "./agency-twin.service";

/**
 * REGRESSION (CI run 37487401977, #2071): the sync emitted `operation: "created"` with a
 * `refused_reason` for a twin BORN unservable — an open agency job with no match pick, V1 on —
 * and `job_posting.twin_synced`'s strict refine rejected it inside the write's transaction.
 *
 * Every payload here is built EXACTLY as the sync builds it: `planAgencyTwin` → `diffAgencyTwin`
 * → `agencyTwinOperation` → `twinSyncedPayload`, then through the REAL `createEvent`, so a
 * schema/emitter disagreement on any reachable branch fails here instead of in a transaction.
 */

const TWIN = "33333333-3333-4333-8333-333333333333";
const SOURCE_ID = "11111111-1111-4111-8111-111111111111";

const source = (o: Partial<AgencyTwinSource> = {}): AgencyTwinSource => ({
  id: SOURCE_ID,
  status: "open",
  title: "VMC Operator — Day Shift",
  city: "Pune",
  area: null,
  payMin: 18000,
  payMax: 24000,
  payType: null,
  shift: "day",
  neededBy: null,
  description: null,
  minExperienceYears: null,
  maxExperienceYears: null,
  benefits: null,
  requirements: null,
  roleKind: null,
  matchSkillIds: ["mskill_vmc_operator"],
  createdAt: new Date("2026-09-01T00:00:00.000Z"),
  ...o,
});

const ctx = (matchV1Enabled: boolean): AgencyTwinContext => ({
  matchV1Enabled,
  relatedSkillsDefault: "on",
  systemActorId: AGENCY_TWIN_SYSTEM_ACTOR_ID,
  orgLabel: AGENCY_TWIN_ORG_LABEL,
});

/** The write the sync produces for (stored twin or none) → this source, as the core computes it. */
function writeFor(
  s: AgencyTwinSource,
  v1: boolean,
  stored: AgencyTwinValues | null,
  empty: AgencyTwinValues,
): AgencyTwinWrite | null {
  const plan = planAgencyTwin(s, ctx(v1));
  const changed = diffAgencyTwin(stored ?? empty, plan.values);
  if (stored && changed.length === 0) return null;
  return {
    kind: "written",
    sourceJobId: s.id,
    jobPostingId: TWIN,
    operation: agencyTwinOperation(stored === null, changed, plan.refusedReason),
    status: plan.values.status,
    changedFields: changed,
    refusedReason: plan.refusedReason,
  };
}

const validates = (payload: ReturnType<typeof twinSyncedPayload>) =>
  createEvent({
    event_name: "job_posting.twin_synced",
    actor: { actor_type: "system", actor_id: null },
    subject: { subject_type: "job_posting", subject_id: TWIN },
    payload,
    source: "api",
    metadata: { environment: "test", service: "api", request_id: null },
  });

describe("job_posting.twin_synced — every payload the sync can emit validates", () => {
  const EMPTY = { ...planAgencyTwin(source(), ctx(false)).values, roleTitle: "", orgLabel: "" };
  const sources: Array<[string, AgencyTwinSource]> = [
    ["open, picked", source()],
    ["open, NO pick (the CI failure)", source({ matchSkillIds: [] })],
    ["open, unknown id", source({ matchSkillIds: ["mskill_not_real"] })],
    ["open, text fails the screen", source({ description: "Call 9876543210" })],
    ["paused", source({ status: "paused" })],
    ["suspended", source({ status: "suspended" })],
    ["closed", source({ status: "closed" })],
  ];

  for (const v1 of [false, true]) {
    for (const [name, s] of sources) {
      it(`V1 ${v1 ? "on" : "off"} · ${name} · created, then every transition from every other row`, () => {
        const created = writeFor(s, v1, null, EMPTY)!;
        expect(() => validates(twinSyncedPayload(created))).not.toThrow();
        // From each other planned twin to this one (an update / status move / refusal).
        for (const [, other] of sources) {
          for (const otherV1 of [false, true]) {
            const stored = planAgencyTwin(other, ctx(otherV1)).values;
            const w = writeFor(s, v1, stored, EMPTY);
            if (w) expect(() => validates(twinSyncedPayload(w))).not.toThrow();
          }
        }
      });
    }
  }

  it("a twin born unservable is reported as REFUSED (paused, with its reason), never created+reason", () => {
    const EMPTY_TWIN = planAgencyTwin(source(), ctx(false)).values;
    const w = writeFor(source({ matchSkillIds: [] }), true, null, {
      ...EMPTY_TWIN,
      roleTitle: "",
    })!;
    expect(w).toMatchObject({
      operation: "refused",
      status: "paused",
      refusedReason: "no_match_skills",
    });
  });

  it("the kill switch payload validates", () => {
    expect(() =>
      validates(killSwitchPayload({ jobPostingId: TWIN, sourceJobId: SOURCE_ID })),
    ).not.toThrow();
  });
});
