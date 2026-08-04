import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StatusPill } from "./status-pill";

/**
 * What `StatusPill` actually RENDERS.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────────────────
 * `status-pill.test.ts` covers `statusTone`, the pure function — and it passed happily
 * while the credits ledger rendered a pill reading **"applied"** next to every ops grant.
 * The bug was never in the tone map; it was in what reached the DOM, and nothing asserted
 * that. When the fix was mutation-tested, both mutations SURVIVED, which is what surfaced
 * the gap.
 *
 * `renderToStaticMarkup` is enough here: this is a plain function component with no hooks,
 * so no jsdom environment is needed.
 */

const html = (el: React.ReactElement) => renderToStaticMarkup(el);

describe("StatusPill rendering", () => {
  it("renders the de-snaked value and the value-derived tone by default", () => {
    const out = html(<StatusPill value="job_posting" />);
    expect(out).toContain("job posting");
    expect(out).toContain("pill--warn"); // unmapped → warn, never ok
  });

  it("`label` overrides the TEXT without touching anything else", () => {
    const out = html(<StatusPill value="pack_purchase" label="Pack purchase" />);
    expect(out).toContain("Pack purchase");
    expect(out).not.toContain("pack purchase");
  });

  it("`tone` overrides the COLOUR without changing the text", () => {
    // The exact fix: borrow a tone, keep the word.
    const out = html(<StatusPill value="paid" tone="ok" />);
    expect(out).toContain("pill--ok");
    expect(out).toContain(">paid<");
  });

  it("a borrowed tone NEVER leaks another domain's word into the text", () => {
    // The shipped bug, pinned. Passing `value="applied"` to get a green pill also
    // displayed the word "applied" — meaningless on a finance screen.
    const out = html(<StatusPill value="grant" label="Ops grant" tone="ok" />);
    expect(out).toContain("Ops grant");
    for (const foreign of ["applied", "skipped", "active", "rejected", "pending"]) {
      expect(out, `must not render the foreign word "${foreign}"`).not.toContain(foreign);
    }
  });

  it("order statuses render their own words, correctly toned", () => {
    expect(html(<StatusPill value="paid" label="settled" tone="ok" />)).toContain(">settled<");
    expect(html(<StatusPill value="created" label="unsettled" tone="warn" />)).toContain(
      ">unsettled<",
    );
    expect(html(<StatusPill value="failed" label="failed" tone="bad" />)).toContain("pill--bad");
  });

  it("a null value renders a dash pill, not an empty one", () => {
    const out = html(<StatusPill value={null} />);
    expect(out).toContain("pill--muted");
    expect(out).toContain("—");
  });

  it("the title is passed through for the full value on hover", () => {
    expect(html(<StatusPill value="grant" title="adds credits" />)).toContain(
      'title="adds credits"',
    );
  });
});
