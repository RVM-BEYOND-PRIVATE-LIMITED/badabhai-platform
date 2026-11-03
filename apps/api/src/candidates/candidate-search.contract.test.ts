import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeCandidateCursor } from "./candidate-search.cursor";
import {
  CandidateSearchSchema,
  EXPERIENCE_BUCKETS,
  type CandidateFiltersDto,
  type CandidateSearchResponseDto,
  type CandidateSearchRowDto,
} from "./candidate-search.dto";

/**
 * The API's half of `packages/types/fixtures/candidate-search-contract.json` — the one wire
 * example payer-web and the payer app also parse. If a DTO key is added, renamed or dropped, this
 * fails until the fixture (and therefore both client parsers) learn it in the same change.
 */
const FIXTURE = JSON.parse(
  readFileSync(
    resolve(__dirname, "../../../../packages/types/fixtures/candidate-search-contract.json"),
    "utf8",
  ),
) as {
  routes: Record<string, { method: string; path: string }>;
  requests: { name: string; body: unknown }[];
  response: CandidateSearchResponseDto;
  emptyStrictResponse: CandidateSearchResponseDto;
  filters: CandidateFiltersDto;
};

// The DTO's keys, spelled once. A `satisfies` makes TypeScript hold each list to its interface.
const RESPONSE_KEYS = [
  "total",
  "matched",
  "unrecorded",
  "filtered",
  "strict",
  "candidates",
  "nextCursor",
] as const satisfies readonly (keyof CandidateSearchResponseDto)[];
const ROW_KEYS = [
  "workerId",
  "matchesFilters",
  "matchTier",
  "role",
  "otherRoles",
  "skillMonths",
  "industry",
  "industryMonths",
  "city",
  "tradeLevels",
] as const satisfies readonly (keyof CandidateSearchRowDto)[];
const FILTERS_KEYS = [
  "roles",
  "industries",
  "experienceBuckets",
  "cities",
  "maxRoles",
] as const satisfies readonly (keyof CandidateFiltersDto)[];

describe("candidate search contract fixture — the API's parse", () => {
  it("names the two routes the controller serves", () => {
    expect(FIXTURE.routes.search).toEqual({ method: "POST", path: "/payer/candidates/search" });
    expect(FIXTURE.routes.filters).toEqual({ method: "GET", path: "/payer/candidates/filters" });
  });

  it.each(FIXTURE.requests.map((r) => [r.name, r.body] as const))(
    "request '%s' parses with the route's schema",
    (_name, body) => {
      expect(CandidateSearchSchema.safeParse(body).success).toBe(true);
    },
  );

  it("its cursors are real server-minted ones", () => {
    expect(decodeCandidateCursor(FIXTURE.response.nextCursor ?? "")).not.toBeNull();
  });

  it.each([
    ["response", FIXTURE.response],
    ["emptyStrictResponse", FIXTURE.emptyStrictResponse],
  ] as const)("%s carries exactly the response keys, and every row exactly the row keys", (_n, body) => {
    expect(Object.keys(body).sort()).toEqual([...RESPONSE_KEYS].sort());
    for (const row of body.candidates) expect(Object.keys(row).sort()).toEqual([...ROW_KEYS].sort());
  });

  it("an empty strict page still carries the counts (ADR-0040 Decision 3)", () => {
    expect(FIXTURE.emptyStrictResponse.candidates).toEqual([]);
    expect(FIXTURE.emptyStrictResponse.total).toBeGreaterThan(0);
  });

  it("filters carry exactly the filters keys and the server's own buckets", () => {
    expect(Object.keys(FIXTURE.filters).sort()).toEqual([...FILTERS_KEYS].sort());
    expect(FIXTURE.filters.experienceBuckets).toEqual(
      EXPERIENCE_BUCKETS.map((b) => ({ id: b.id, label: b.label })),
    );
  });

  it("the payer-app CI job fires on a fixture-only change (its Dart contract test reads this file)", () => {
    const ci = readFileSync(resolve(__dirname, "../../../../.github/workflows/ci.yml"), "utf8");
    const payerApp = ci.slice(ci.indexOf("            payer-app:\n"));
    const block = payerApp.slice(0, payerApp.indexOf("\n            #"));
    expect(block).toContain("- 'packages/types/fixtures/candidate-search-contract.json'");
  });

  it("no example carries an identity key", () => {
    const text = JSON.stringify({ r: FIXTURE.response, f: FIXTURE.filters });
    for (const forbidden of ["name", "phone", "photo", "employer", "salary", "address", "email"]) {
      expect(text.toLowerCase()).not.toContain(`"${forbidden}`);
    }
  });
});
