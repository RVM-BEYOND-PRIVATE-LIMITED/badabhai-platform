import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * A7 (#2577) — the universal search box's FIRST paint: the labelled field over the list, and a
 * closed results panel. The debounced POST itself is covered by the `candidates/search`
 * route's tests; what this pins is the contract that matters on first paint — the term is
 * typed into a body-only box, never into the address, so nothing here may render a `q`
 * into a link or a value.
 */
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams("status=active&page=2"),
}));

const { CandidateSearchBox } = await import("./candidate-search-box");

const render = () => renderToStaticMarkup(<CandidateSearchBox />);

describe("the universal search box", () => {
  it("labels the field and shows the example term", () => {
    const out = render();
    expect(out).toContain("Search every field");
    expect(out).toContain('placeholder="e.g. welder in Pune"');
    expect(out).toContain('role="searchbox"');
  });

  it("starts with the results panel closed and empty", () => {
    const out = render();
    expect(out).toContain('data-open="false"');
    expect(out).toContain('aria-label="Matching candidates"');
    expect(out).not.toContain("match");
  });

  it("renders no term, no query and no result link anywhere", () => {
    const out = render();
    expect(out).not.toContain("?c=");
    expect(out).not.toMatch(/[?&]q=/);
    expect(out).not.toContain('value="welder"');
  });
});
