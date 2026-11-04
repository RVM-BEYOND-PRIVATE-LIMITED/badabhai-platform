import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { STATUS_LABELS, StatusPill, statusLabel } from "./status-pill";

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
  it("renders the de-snaked value in sentence case and the value-derived tone by default", () => {
    const out = html(<StatusPill value="job_posting" />);
    expect(out).toContain(">Job posting<");
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
    expect(out).toContain(">Paid<");
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
    expect(html(<StatusPill value="paid" label="settled" tone="ok" />)).toContain(">Settled<");
    expect(html(<StatusPill value="created" label="unsettled" tone="warn" />)).toContain(
      ">Unsettled<",
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

describe("one sentence-case status label map (A1, #2571)", () => {
  it("renders `open` and `closed` alike — the console used to print 'open' beside 'Closed'", () => {
    expect(html(<StatusPill value="open" />)).toBe('<span class="pill pill--ok">Open</span>');
    expect(html(<StatusPill value="closed" />)).toBe('<span class="pill pill--muted">Closed</span>');
  });

  it("labels every toned status in sentence case", () => {
    for (const [value, label] of Object.entries(STATUS_LABELS)) {
      expect(label.charAt(0), value).toBe(label.charAt(0).toUpperCase());
      expect(statusLabel(value)).toBe(label);
      expect(statusLabel(value.toUpperCase())).toBe(label);
    }
  });

  it("sentence-cases an unmapped value and an explicit lower-case label", () => {
    expect(statusLabel("under_review")).toBe("Under review");
    expect(html(<StatusPill value="servable" label="could be re-served" tone="warn" />)).toContain(
      ">Could be re-served<",
    );
    // Only the first letter changes — an acronym in a label survives.
    expect(html(<StatusPill value="x" label="AI paused" tone="warn" />)).toContain(">AI paused<");
  });
});
