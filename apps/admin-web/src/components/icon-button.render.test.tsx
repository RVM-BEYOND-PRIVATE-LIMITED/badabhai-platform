import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { IconButton } from "./icon-button";

/**
 * The admin IconButton is the console's SKIN over the shared IconButtonBase
 * (@badabhai/icons/button) — the same component payer-web's DS IconButton wraps. These tests pin
 * the class vocabulary and that the shared contract reaches through the wrapper; the behaviour
 * (Escape on a focus- AND a hover-opened tooltip, listener cleanup on leave and unmount) is tested
 * once, on IconButtonBase, in packages/icons (button.behaviour.test.tsx).
 */
describe("IconButton (admin)", () => {
  it("renders the shared control with the console's class root and the shared tooltip", () => {
    expect(renderToStaticMarkup(<IconButton icon="funnel-x" label="Clear filters" />)).toBe(
      '<button type="button" class="iconbtn" aria-label="Clear filters">' +
        '<i class="ph-fill ph-funnel-x" aria-hidden="true"></i>' +
        '<span class="bb-icon-tip bb-icon-tip--top" aria-hidden="true">Clear filters</span>' +
        "</button>",
    );
  });

  it("variant, size, placement and an app class compose; a submit type passes through", () => {
    const out = renderToStaticMarkup(
      <IconButton
        icon="list"
        label="Navigation"
        variant="outline"
        size="sm"
        tooltipPlacement="bottom-start"
        className="topbar__menu"
        type="submit"
      />,
    );
    expect(out).toContain('class="iconbtn iconbtn--outline iconbtn--sm topbar__menu"');
    expect(out).toContain('type="submit"');
    expect(out).toContain('<span class="bb-icon-tip bb-icon-tip--bottom-start"');
  });

  it("never emits a title (a title-only hint is invisible to keyboard and touch users)", () => {
    expect(renderToStaticMarkup(<IconButton icon="x" label="Close" />)).not.toContain("title=");
  });

  it("the contract is enforced by types: label required, no title / aria-label, typed icon", () => {
    // @ts-expect-error — `label` is required.
    const noLabel = <IconButton icon="x" />;
    // @ts-expect-error — `title` is not accepted.
    const titled = <IconButton icon="x" label="Close" title="Close" />;
    // @ts-expect-error — the name comes from `label` only.
    const relabelled = <IconButton icon="x" label="Close" aria-label="Shut" />;
    // @ts-expect-error — "funel" is not an IconName.
    const typo = <IconButton icon="funel" label="Filter" />;
    // @ts-expect-error — payer-web's `solid` variant is not part of the console's vocabulary.
    const solid = <IconButton icon="x" label="Close" variant="solid" />;
    expect([noLabel, titled, relabelled, typo, solid].every(Boolean)).toBe(true);
  });
});
