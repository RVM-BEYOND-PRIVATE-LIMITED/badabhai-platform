import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { IconButtonBase } from "./button";

/**
 * The shared icon-only button: markup and the type-level contract. (Behaviour — Escape on focus
 * and on hover, listener cleanup — is in button.behaviour.test.tsx.)
 */
const html = (el: React.ReactElement) => renderToStaticMarkup(el);

describe("IconButtonBase — markup", () => {
  it("a native button named by its label, the glyph, and the shared tooltip", () => {
    expect(html(<IconButtonBase classBase="bb-iconbtn" icon="x" label="Close" />)).toBe(
      '<button type="button" class="bb-iconbtn" aria-label="Close">' +
        '<i class="ph-fill ph-x" aria-hidden="true"></i>' +
        '<span class="bb-icon-tip bb-icon-tip--top" aria-hidden="true">Close</span>' +
        "</button>",
    );
  });

  it("the app's class root takes its modifiers; falsy modifiers are skipped", () => {
    const out = html(
      <IconButtonBase
        classBase="iconbtn"
        modifiers={["outline", false, null, undefined, "sm"]}
        className="topbar__menu"
        icon="list"
        label="Navigation"
        tooltipPlacement="bottom-start"
      />,
    );
    expect(out).toContain('class="iconbtn iconbtn--outline iconbtn--sm topbar__menu"');
    expect(out).toContain('<span class="bb-icon-tip bb-icon-tip--bottom-start"');
  });

  it("only the label names it — glyph and tooltip are hidden from assistive tech", () => {
    const out = html(<IconButtonBase classBase="x" icon="gear" label="Account settings" />);
    const exposed = out
      .replace(/<i [^>]*aria-hidden="true"[^>]*><\/i>/, "")
      .replace(/<span [^>]*aria-hidden="true"[^>]*>[^<]*<\/span>/, "")
      .replace(/<[^>]+>/g, "")
      .trim();
    expect(exposed).toBe("");
    expect(out).not.toContain("title=");
  });

  it("no spread can give it a second name at runtime (aria-label / labelledby / title)", () => {
    // The types forbid these; a cast (or untyped JS) must still not get a second name through.
    const sneaky: object = {
      "aria-label": "Shut",
      "aria-labelledby": "elsewhere",
      title: "Shut",
    };
    const out = html(<IconButtonBase classBase="bb-iconbtn" icon="x" label="Close" {...sneaky} />);
    expect(out).toContain('aria-label="Close"');
    expect(out).not.toContain("Shut");
    expect(out).not.toContain("aria-labelledby");
    expect(out).not.toContain("title=");
  });

  it("a submit type passes through", () => {
    expect(
      html(<IconButtonBase classBase="b" icon="check" label="Save" type="submit" />),
    ).toContain('type="submit"');
  });

  it("the contract is enforced by types: label required, no title / aria-label, typed icon", () => {
    // @ts-expect-error — `label` is required.
    const noLabel = <IconButtonBase classBase="b" icon="x" />;
    // @ts-expect-error — `title` is not accepted.
    const titled = <IconButtonBase classBase="b" icon="x" label="Close" title="Close" />;
    // @ts-expect-error — the name comes from `label` only.
    const relabelled = <IconButtonBase classBase="b" icon="x" label="Close" aria-label="Shut" />;
    // @ts-expect-error — "funel" is not an IconName.
    const typo = <IconButtonBase classBase="b" icon="funel" label="Filter" />;
    // @ts-expect-error — not a placement.
    const placed = <IconButtonBase classBase="b" icon="x" label="Close" tooltipPlacement="left" />;
    expect([noLabel, titled, relabelled, typo, placed].every(Boolean)).toBe(true);
  });
});
