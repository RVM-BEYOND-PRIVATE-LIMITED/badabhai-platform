import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FilterChip } from "./filter-chip-link";

/**
 * A filter chip that navigates (final re-sweep O-2): a link to its value — or, when its target IS
 * the address on screen, that value as text. The selected chip used to link the page it was on.
 * Chips drop the page cursor, so on a later page the selected chip's target is NOT this address:
 * there it stays a link, the one-click way back to the first page of the same selection.
 */
describe("FilterChip", () => {
  it("an unselected chip is a link to its value, drawn as the ghost chip", () => {
    const out = renderToStaticMarkup(
      <FilterChip selected={false} href="/credits?windowDays=90" cursor={undefined}>
        90d
      </FilterChip>,
    );
    expect(out).toBe('<a class="btn btn--sm btn--ghost" href="/credits?windowDays=90">90d</a>');
  });

  it("the selected chip on the first page is the current value as text — no link to the page it is on", () => {
    const out = renderToStaticMarkup(
      <FilterChip selected href="/credits?windowDays=30" cursor={undefined}>
        30d
      </FilterChip>,
    );
    expect(out).toBe('<span aria-current="true" class="btn btn--sm btn--selected">30d</span>');
    expect(out).not.toContain("href");
  });

  it("the selected chip on a later page links its own first page, still marked current", () => {
    // Review of #2095: the Pager only goes forward, so on `…&cursor=X` the selected chip was the
    // one-click way back to page one with the same selection — and rendering it as text took it.
    const out = renderToStaticMarkup(
      <FilterChip selected href="/credits?windowDays=30&reason=grant" cursor="Y3Vyc29y">
        Credit grant
      </FilterChip>,
    );
    expect(out).toBe(
      '<a aria-current="true" class="btn btn--sm btn--selected" href="/credits?windowDays=30&amp;reason=grant">Credit grant</a>',
    );
  });

  it("an unselected chip on a later page is the same plain link", () => {
    const out = renderToStaticMarkup(
      <FilterChip selected={false} href="/credits?windowDays=90" cursor="Y3Vyc29y">
        90d
      </FilterChip>,
    );
    expect(out).toBe('<a class="btn btn--sm btn--ghost" href="/credits?windowDays=90">90d</a>');
  });

  it("keeps the full-size row's size on every state", () => {
    expect(
      renderToStaticMarkup(
        <FilterChip selected size="md" href="/x" cursor={undefined}>
          a
        </FilterChip>,
      ),
    ).toContain('class="btn btn--selected"');
    expect(
      renderToStaticMarkup(
        <FilterChip selected size="md" href="/x" cursor="c2">
          a
        </FilterChip>,
      ),
    ).toContain('class="btn btn--selected"');
    expect(
      renderToStaticMarkup(
        <FilterChip selected={false} size="md" href="/x" cursor={undefined}>
          a
        </FilterChip>,
      ),
    ).toContain('class="btn btn--ghost"');
  });
});
