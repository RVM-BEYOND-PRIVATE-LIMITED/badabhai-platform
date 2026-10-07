import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FilterChip } from "./filter-chip-link";

/**
 * A filter chip that navigates (final re-sweep O-2): a link to its value — or, when it IS the
 * value on screen, that value as text. The selected chip used to link the page it was on.
 */
describe("FilterChip", () => {
  it("an unselected chip is a link to its value, drawn as the ghost chip", () => {
    const out = renderToStaticMarkup(
      <FilterChip selected={false} href="/credits?windowDays=90">
        90d
      </FilterChip>,
    );
    expect(out).toBe('<a class="btn btn--sm btn--ghost" href="/credits?windowDays=90">90d</a>');
  });

  it("the selected chip is the current value as text — no link to the page it is on", () => {
    const out = renderToStaticMarkup(
      <FilterChip selected href="/credits?windowDays=30">
        30d
      </FilterChip>,
    );
    expect(out).toBe('<span aria-current="true" class="btn btn--sm btn--selected">30d</span>');
    expect(out).not.toContain("href");
  });

  it("keeps the full-size row's size on both states", () => {
    expect(
      renderToStaticMarkup(
        <FilterChip selected size="md" href="/x">
          a
        </FilterChip>,
      ),
    ).toContain('class="btn btn--selected"');
    expect(
      renderToStaticMarkup(
        <FilterChip selected={false} size="md" href="/x">
          a
        </FilterChip>,
      ),
    ).toContain('class="btn btn--ghost"');
  });
});
