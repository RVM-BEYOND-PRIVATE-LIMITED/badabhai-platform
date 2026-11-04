import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { InfoPopover } from "./info-popover";
import { AboutData } from "./about-data";
import { PageHeader } from "./page-header";

/**
 * A3 (#2573) — caveats one click away, and still reachable by keyboard and screen reader.
 *
 * Both are native `<details>`: the `<summary>` is in the tab order and toggles on Enter/Space
 * with no client JS, assistive tech announces it with its expanded state, and the content is
 * ordinary DOM text (rendered, never fetched on open), so nothing about a caveat depends on a
 * pointer or on JavaScript having loaded.
 */
const html = (el: React.ReactElement) => renderToStaticMarkup(el);

describe("InfoPopover", () => {
  const out = html(
    <InfoPopover label="About this page">
      <p>Contact details are never listed.</p>
    </InfoPopover>,
  );

  it("is a native disclosure, closed by default", () => {
    expect(out.startsWith('<details class="infopop">')).toBe(true);
  });

  it("names its ⓘ toggle for a screen reader and draws the brand info glyph", () => {
    expect(out).toContain(
      '<summary class="infopop__toggle" aria-label="About this page" title="About this page"><i class="ph-fill ph-info" aria-hidden="true"></i></summary>',
    );
  });

  it("keeps the caveat in the DOM as a note", () => {
    expect(out).toContain('<div class="infopop__body" role="note"><p>Contact details are never listed.</p></div>');
  });
});

describe("AboutData", () => {
  it("is a closed native disclosure titled About this data, with the brand caret as its chevron", () => {
    const out = html(
      <AboutData>
        <p>Small print.</p>
      </AboutData>,
    );
    expect(out).toBe(
      '<details class="about"><summary class="about__toggle"><span>About this data</span>' +
        '<i class="ph-fill ph-caret-down disclosure__caret about__chevron" aria-hidden="true"></i></summary>' +
        '<div class="about__body"><p>Small print.</p></div></details>',
    );
  });

  it("takes a page's own title", () => {
    expect(html(<AboutData title="About these calls">x</AboutData>)).toContain(
      "<span>About these calls</span>",
    );
  });
});

describe("PageHeader info", () => {
  it("puts the ⓘ beside the one-line description, outside its <p>", () => {
    const out = html(
      <PageHeader title="Workers" description="Workers, by id." info={<p>The caveat.</p>} />,
    );
    expect(out).toContain(
      '<div class="page__subrow"><p class="page__sub">Workers, by id.</p><details class="infopop">',
    );
    expect(out).toContain("<p>The caveat.</p>");
  });

  it("renders the plain description when there is no caveat", () => {
    const out = html(<PageHeader title="Workers" description="Workers, by id." />);
    expect(out).toContain('<p class="page__sub">Workers, by id.</p>');
    expect(out).not.toContain("infopop");
  });
});
