import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PanelSection } from "./panel-section";

/**
 * A1 (#2571) — a panel's sub-section. The spacing and the hairline divider are the
 * `.panel__section` rules (pinned in app/foundation.css.test.ts); this pins the markup they key on.
 */
describe("PanelSection", () => {
  it("renders a titled section with an h3 under the panel's h2", () => {
    expect(renderToStaticMarkup(<PanelSection title="Spend by task">body</PanelSection>)).toBe(
      '<section class="panel__section"><h3 class="panel__section-title">Spend by task</h3>body</section>',
    );
  });

  it("renders no heading when untitled", () => {
    expect(renderToStaticMarkup(<PanelSection>body</PanelSection>)).toBe(
      '<section class="panel__section">body</section>',
    );
  });

  it("gives the heading its id, so a list or table can name itself by it", () => {
    expect(
      renderToStaticMarkup(
        <PanelSection title="By provider" titleId="ai-spend-provider">
          body
        </PanelSection>,
      ),
    ).toBe(
      '<section class="panel__section"><h3 class="panel__section-title" id="ai-spend-provider">By provider</h3>body</section>',
    );
  });
});
