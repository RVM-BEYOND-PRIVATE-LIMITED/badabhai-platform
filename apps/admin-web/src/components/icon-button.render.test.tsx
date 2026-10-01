import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { TOOLTIP_DISMISSED_ATTRIBUTE } from "@badabhai/icons";
import { IconButton, type IconButtonProps } from "./icon-button";

/**
 * The admin IconButton honours the shared icon-only-control contract (@badabhai/icons):
 * a required label that is the ONLY accessible name, a visible tooltip carrying it (never a
 * `title`), a native button, Escape dismissal that does not swallow the key.
 */
describe("IconButton (admin)", () => {
  it("renders a native button named by its label, with the glyph and a visible tooltip", () => {
    expect(renderToStaticMarkup(<IconButton icon="funnel-x" label="Clear filters" />)).toBe(
      '<button type="button" class="iconbtn" aria-label="Clear filters">' +
        '<i class="ph-fill ph-funnel-x" aria-hidden="true"></i>' +
        '<span class="iconbtn__tip iconbtn__tip--top" aria-hidden="true">Clear filters</span>' +
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
        tooltipPlacement="end"
        className="topbar__menu"
        type="submit"
      />,
    );
    expect(out).toContain('class="iconbtn iconbtn--outline iconbtn--sm topbar__menu"');
    expect(out).toContain('type="submit"');
    expect(out).toContain("iconbtn__tip--end");
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
    expect([noLabel, titled, relabelled, typo].every(Boolean)).toBe(true);
  });

  it("Escape marks the tooltip dismissed AND still reaches the caller's handler (the drawer)", () => {
    const onKeyDown = vi.fn();
    const el = IconButton({ icon: "list", label: "Navigation", onKeyDown }) as ReactElement<
      Required<Pick<IconButtonProps, "onKeyDown" | "onBlur" | "onMouseLeave">>
    >;
    const attrs = new Map<string, string>();
    const currentTarget = {
      setAttribute: (k: string, v: string) => void attrs.set(k, v),
      removeAttribute: (k: string) => void attrs.delete(k),
    };
    el.props.onKeyDown({ key: "Escape", currentTarget } as never);
    expect(attrs.has(TOOLTIP_DISMISSED_ATTRIBUTE)).toBe(true);
    expect(onKeyDown).toHaveBeenCalledTimes(1);

    el.props.onBlur({ currentTarget } as never);
    expect(attrs.has(TOOLTIP_DISMISSED_ATTRIBUTE)).toBe(false);
    el.props.onKeyDown({ key: "Escape", currentTarget } as never);
    el.props.onMouseLeave({ currentTarget } as never);
    expect(attrs.has(TOOLTIP_DISMISSED_ATTRIBUTE)).toBe(false);
  });
});
