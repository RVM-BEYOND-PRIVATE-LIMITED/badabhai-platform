import { describe, expect, it } from "vitest";
import {
  CANDIDATE_CURSOR_MAX_LENGTH,
  decodeCandidateCursor,
  encodeCandidateCursor,
  searchFingerprint,
  type CandidateCursor,
  type SearchShape,
} from "./candidate-search.cursor";

const SHAPE: SearchShape = {
  skillIds: ["mskill_cnc_turner"],
  relatedSkillIds: ["mskill_vmc_operator", "mskill_cnc_setter_operator"],
  experience: "1_3",
  industryId: "ind_industrial_manufacturing",
  industryExperience: null,
  city: "Pune",
  strict: false,
  tierFloorMonths: 36,
};
const POSITION: CandidateCursor = {
  fingerprint: searchFingerprint(SHAPE),
  workerId: "face2000-0000-4000-8000-000000000007",
  served: 20,
};

/** Base64url of an arbitrary JSON value — how a forger would build one. */
function forge(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

describe("candidate search cursor", () => {
  it("round-trips exactly", () => {
    expect(decodeCandidateCursor(encodeCandidateCursor(POSITION))).toEqual(POSITION);
  });

  it("mints a short, url-safe value", () => {
    const raw = encodeCandidateCursor(POSITION);
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(raw.length).toBeLessThan(CANDIDATE_CURSOR_MAX_LENGTH);
  });

  it("names WHO was last served, never a sort key the card does not show", () => {
    const json = JSON.parse(Buffer.from(encodeCandidateCursor(POSITION), "base64url").toString());
    expect(Object.keys(json).sort()).toEqual(["f", "o", "v", "w"]);
  });

  const f = POSITION.fingerprint;
  const w = POSITION.workerId;
  it.each([
    ["not base64url", "not a cursor!"],
    ["not JSON", Buffer.from("{oops", "utf8").toString("base64url")],
    ["another version", forge({ v: 2, f, w, o: 1 })],
    ["an extra key", forge({ v: 1, f, w, o: 1, payer: "x" })],
    ["a missing key", forge({ v: 1, f, w })],
    ["a short fingerprint", forge({ v: 1, f: "abc", w, o: 1 })],
    ["a zero served count", forge({ v: 1, f, w, o: 0 })],
    ["a fractional served count", forge({ v: 1, f, w, o: 1.5 })],
    ["an out-of-range served count", forge({ v: 1, f, w, o: 1_000_001 })],
    ["a non-uuid worker", forge({ v: 1, f, w: "worker-1", o: 1 })],
    ["an over-long value", "A".repeat(CANDIDATE_CURSOR_MAX_LENGTH + 1)],
  ])("refuses %s (null — the DTO turns it into a 400)", (_label, raw) => {
    expect(decodeCandidateCursor(raw)).toBeNull();
  });
});

describe("searchFingerprint", () => {
  it("is stable under list order and city case", () => {
    expect(
      searchFingerprint({
        ...SHAPE,
        relatedSkillIds: [...SHAPE.relatedSkillIds].reverse(),
        city: "PUNE",
      }),
    ).toBe(searchFingerprint(SHAPE));
  });

  it.each([
    ["a role", { skillIds: ["mskill_vmc_operator"] }],
    ["the related set", { relatedSkillIds: [] }],
    ["years in role", { experience: "3_5" }],
    ["the industry", { industryId: null }],
    ["years in industry", { industryExperience: "1_3" }],
    ["the city", { city: "Chennai" }],
    ["strict", { strict: true }],
    ["the tier floor", { tierFloorMonths: 24 }],
  ] as const)("changes when %s changes", (_label, change) => {
    expect(searchFingerprint({ ...SHAPE, ...change })).not.toBe(searchFingerprint(SHAPE));
  });
});
