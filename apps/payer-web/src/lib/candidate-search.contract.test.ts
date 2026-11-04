import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  candidateFiltersWireSchema,
  candidateSearchBodySchema,
  candidateSearchWireSchema,
} from "./contracts";
import {
  candidateSearchBody,
  parseCandidateSearchAddress,
  resolveCandidateSearch,
  SEARCH_PARAM,
  STRICT_ON,
} from "./candidate-search";
import { CURSOR_PARAM } from "./candidate-inbox";

/**
 * THE ALL-CANDIDATES CONTRACT, from payer-web's side (ADR-0040 E2) — the checked-in fixture
 * packages/types/fixtures/candidate-search-contract.json is read by three parsers that must agree:
 * the API's (it parses every request with CandidateSearchSchema), the payer app's (fromJson) and
 * THIS one, with payer-web's OWN Zod wire schemas (lib/contracts.ts) and body builder
 * (lib/candidate-search.ts). Not a mock: if the fixture gains a key, the parse here drops it and
 * the round-trip equality fails until these schemas learn it — the fixture's own rule ("all three
 * parsers must learn it in the same change").
 */

const FIXTURE_PATH = (() => {
  // From this file up to the repo root (src/lib → apps/payer-web → apps → root), then into the
  // fixture — checked, so a moved file fails loudly here rather than reading nothing.
  const here = dirname(fileURLToPath(import.meta.url));
  const path = resolve(join(here, "..", "..", "..", "..", "packages", "types", "fixtures", "candidate-search-contract.json"));
  if (!existsSync(path)) throw new Error(`candidate-search contract fixture not found at ${path}`);
  return path;
})();

interface Fixture {
  version: number;
  routes: Record<"search" | "filters", { method: string; path: string }>;
  requests: Array<{ name: string; body: Record<string, unknown> }>;
  response: unknown;
  emptyStrictResponse: unknown;
  filters: unknown;
}
const FIXTURE = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Fixture;

describe("the candidate-search contract fixture", () => {
  it("is the version this suite reads, naming the routes the seam calls", () => {
    expect(FIXTURE.version).toBe(1);
    expect(FIXTURE.routes).toEqual({
      search: { method: "POST", path: "/payer/candidates/search" },
      filters: { method: "GET", path: "/payer/candidates/filters" },
    });
    expect(FIXTURE.requests.length).toBeGreaterThanOrEqual(2);
  });
});

describe("payer-web's wire schemas parse the fixture's answers — every key known, nothing dropped", () => {
  it.each([
    ["response", () => FIXTURE.response],
    ["emptyStrictResponse", () => FIXTURE.emptyStrictResponse],
  ] as const)("%s parses with candidateSearchWireSchema and round-trips exactly", (_name, read) => {
    const parsed = candidateSearchWireSchema.parse(read());
    // A plain z.object strips a key it does not know — equality proves it knows them all.
    expect(parsed).toEqual(read());
  });

  it("filters parses with candidateFiltersWireSchema and round-trips exactly", () => {
    expect(candidateFiltersWireSchema.parse(FIXTURE.filters)).toEqual(FIXTURE.filters);
  });

  it("the parse is capable of failing: a key the schema does not know is dropped (so equality fails)", () => {
    const extra = { ...(FIXTURE.response as Record<string, unknown>), surprise: 1 };
    expect(candidateSearchWireSchema.parse(extra)).not.toEqual(extra);
    const noCounts = { ...(FIXTURE.response as Record<string, unknown>) };
    delete noCounts.unrecorded;
    expect(candidateSearchWireSchema.safeParse(noCounts).success).toBe(false);
    // A row without the R74 sample flag is refused, not defaulted (the API always sends it).
    const response = FIXTURE.response as { candidates: Array<Record<string, unknown>> };
    const { isSample: _drop, ...noSample } = response.candidates[0]!;
    const unflagged = { ...response, candidates: [noSample] };
    expect(candidateSearchWireSchema.safeParse(unflagged).success).toBe(false);
  });

  it("the fixture's rows carry the masked shape the card reads (and nothing that names a person)", () => {
    const { candidates } = candidateSearchWireSchema.parse(FIXTURE.response);
    expect(candidates.length).toBeGreaterThanOrEqual(2);
    // A related row and a not-recorded row are both in it — the card's two hardest cases.
    expect(candidates.some((c) => c.matchTier === 2 && !c.matchesFilters)).toBe(true);
    expect(candidates.some((c) => c.industryMonths === null && c.city === null)).toBe(true);
    // R74: a real row and a SAMPLE row — the badge and the no-unlock line read `isSample`.
    expect(candidates.some((c) => c.isSample)).toBe(true);
    expect(candidates.some((c) => !c.isSample)).toBe(true);
    for (const c of candidates) {
      for (const key of Object.keys(c)) expect(key).not.toMatch(/name|phone|photo|email|address|salary|employer/i);
    }
  });
});

describe("payer-web's body builder produces the fixture's request bodies", () => {
  const options = candidateFiltersWireSchema.parse(FIXTURE.filters);
  /** What the search FORM would submit for a body — the address the page then reads. */
  const addressFor = (body: Record<string, unknown>) => {
    const params: Record<string, string> = {};
    const skills = body.skill_ids as string[] | undefined;
    if (skills?.[0]) params[SEARCH_PARAM.role] = skills[0];
    if (typeof body.experience === "string") params[SEARCH_PARAM.experience] = body.experience;
    if (typeof body.industry_id === "string") params[SEARCH_PARAM.industry] = body.industry_id;
    if (typeof body.industry_experience === "string") {
      params[SEARCH_PARAM.industryExperience] = body.industry_experience;
    }
    if (typeof body.city === "string") params[SEARCH_PARAM.city] = body.city;
    if (body.strict === true) params[SEARCH_PARAM.strict] = STRICT_ON;
    if (typeof body.cursor === "string") params[CURSOR_PARAM] = body.cursor;
    return params;
  };

  it.each(FIXTURE.requests.map((r) => [r.name, r] as const))("%s", (_name, request) => {
    // The address → checked against the fixture's OWN filter options → the body sent. Every value
    // in the example must be one the options offer, or it would be dropped and the bodies differ.
    const { query, ignored } = resolveCandidateSearch(
      parseCandidateSearchAddress(addressFor(request.body)),
      options,
    );
    expect(ignored).toBe(0);
    const limit = typeof request.body.limit === "number" ? request.body.limit : undefined;
    expect(candidateSearchBody(query, limit)).toEqual(request.body);
    // …and the seam's own shape guard accepts it, unchanged.
    expect(candidateSearchBodySchema.parse(request.body)).toEqual(request.body);
  });

  it("the shape guard refuses what the API's .strict() schema would (a payer id, a second unknown key)", () => {
    expect(candidateSearchBodySchema.safeParse({ payer_id: "x" }).success).toBe(false);
    expect(candidateSearchBodySchema.safeParse({ ...FIXTURE.requests[1]!.body, extra: 1 }).success).toBe(false);
  });
});
