import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { TOOLTIP_DISMISSED_ATTRIBUTE } from "@badabhai/icons";
import { IconButton, type IconButtonProps } from "./index";

/**
 * The DS IconButton honours the shared icon-only-control contract (@badabhai/icons): a required
 * label that is the ONLY accessible name, a visible tooltip carrying it (never a `title`), a
 * native button, and an Escape dismissal that does not swallow the key.
 */
describe("IconButton (payer DS)", () => {
  it("renders a native button named by its label, with the glyph and a visible tooltip", () => {
    expect(renderToStaticMarkup(<IconButton icon="x" label="Close" />)).toBe(
      '<button type="button" class="bb-iconbtn" aria-label="Close">' +
        '<i class="ph-fill ph-x" aria-hidden="true"></i>' +
        '<span class="bb-iconbtn__tip bb-iconbtn__tip--top" aria-hidden="true">Close</span>' +
        "</button>",
    );
  });

  it("the only exposed name is the aria-label — glyph and tooltip are hidden from AT", () => {
    const out = renderToStaticMarkup(<IconButton icon="gear" label="Account settings" />);
    const exposed = out
      .replace(/<i [^>]*aria-hidden="true"[^>]*><\/i>/, "")
      .replace(/<span [^>]*aria-hidden="true"[^>]*>[^<]*<\/span>/, "")
      .replace(/<[^>]+>/g, "")
      .trim();
    expect(exposed).toBe("");
    expect(out).toContain('aria-label="Account settings"');
    expect(out).not.toContain("title=");
  });

  it("placement, size and variant compose", () => {
    const out = renderToStaticMarkup(
      <IconButton icon="plus" label="Add" size="sm" variant="outline" tooltipPlacement="bottom" />,
    );
    expect(out).toContain('class="bb-iconbtn bb-iconbtn--outline bb-iconbtn--sm"');
    expect(out).toContain("bb-iconbtn__tip--bottom");
  });

  it("the contract is enforced by types: label required, no title / aria-label, typed icon", () => {
    // @ts-expect-error — `label` is required.
    const noLabel = <IconButton icon="x" />;
    // @ts-expect-error — `title` is not accepted.
    const titled = <IconButton icon="x" label="Close" title="Close" />;
    // @ts-expect-error — the name comes from `label` only.
    const relabelled = <IconButton icon="x" label="Close" aria-label="Shut" />;
    // @ts-expect-error — "pencl-simple" is not an IconName.
    const typo = <IconButton icon="pencl-simple" label="Edit" />;
    expect([noLabel, titled, relabelled, typo].every(Boolean)).toBe(true);
  });

  it("Escape marks the tooltip dismissed and still reaches the caller; blur / leave re-arm it", () => {
    const onKeyDown = vi.fn();
    const onBlur = vi.fn();
    const el = IconButton({ icon: "x", label: "Close", onKeyDown, onBlur }) as ReactElement<
      Required<Pick<IconButtonProps, "onKeyDown" | "onBlur" | "onMouseLeave">>
    >;
    const attrs = new Map<string, string>();
    const currentTarget = {
      setAttribute: (k: string, v: string) => void attrs.set(k, v),
      removeAttribute: (k: string) => void attrs.delete(k),
    };
    el.props.onKeyDown({ key: "Enter", currentTarget } as never);
    expect(attrs.size).toBe(0);
    el.props.onKeyDown({ key: "Escape", currentTarget } as never);
    expect(attrs.has(TOOLTIP_DISMISSED_ATTRIBUTE)).toBe(true);
    expect(onKeyDown).toHaveBeenCalledTimes(2);
    el.props.onBlur({ currentTarget } as never);
    expect(attrs.has(TOOLTIP_DISMISSED_ATTRIBUTE)).toBe(false);
    expect(onBlur).toHaveBeenCalledTimes(1);
    el.props.onKeyDown({ key: "Escape", currentTarget } as never);
    el.props.onMouseLeave({ currentTarget } as never);
    expect(attrs.has(TOOLTIP_DISMISSED_ATTRIBUTE)).toBe(false);
  });
});
