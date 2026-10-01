import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Icon } from "./index";

describe("<Icon>", () => {
  it("renders the decorative Phosphor FILL element exactly", () => {
    expect(renderToStaticMarkup(<Icon name="plus" />)).toBe(
      '<i class="ph-fill ph-plus" aria-hidden="true"></i>',
    );
  });

  it("sizes through a token class, never an inline style", () => {
    const out = renderToStaticMarkup(<Icon name="gear" size="md" />);
    expect(out).toBe('<i class="ph-fill ph-gear bb-icon--md" aria-hidden="true"></i>');
    expect(out).not.toContain("style=");
  });

  it("appends an app's own class after the glyph classes", () => {
    expect(renderToStaticMarkup(<Icon name="list" size="sm" className="pnav__icon" />)).toBe(
      '<i class="ph-fill ph-list bb-icon--sm pnav__icon" aria-hidden="true"></i>',
    );
  });

  it("a standalone meaningful icon is an image named by its label, and not hidden", () => {
    const out = renderToStaticMarkup(<Icon name="check" label="Allowed" />);
    expect(out).toBe('<i class="ph-fill ph-check" role="img" aria-label="Allowed"></i>');
    expect(out).not.toContain("aria-hidden");
  });

  it("only ever draws the fill weight", () => {
    expect(renderToStaticMarkup(<Icon name="x" />)).not.toMatch(
      /ph-(bold|regular|light|thin|duotone)/,
    );
  });

  it("a misspelt glyph name is a TYPE error (tsc fails if this directive goes unused)", () => {
    // @ts-expect-error — "plsu" is not an IconName.
    const typo = <Icon name="plsu" />;
    expect(typo).toBeTruthy();
  });
});
