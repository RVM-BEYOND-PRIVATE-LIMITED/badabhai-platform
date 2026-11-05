import { describe, expect, it } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CountUp } from "./ds/count-up";
import { formatReach } from "../lib/published-reach";
import { PublishedReachNotice } from "./published-reach-notice";

/** What a screen reader hears: the markup minus the count's moving (aria-hidden) digits. */
const spoken = (markup: string) =>
  markup
    .replace(/<span class="bb-countup" aria-hidden="true">[^<]*<\/span>/g, "")
    .replace(/<[^>]+>/g, "");

/** Every element of `type` in a returned tree (the notice is hook-free, so it can be called). */
function findAll(node: ReactNode, type: unknown, acc: ReactElement[] = []): ReactElement[] {
  if (node === null || node === undefined || typeof node !== "object") return acc;
  if (Array.isArray(node)) {
    for (const n of node) findAll(n, type, acc);
    return acc;
  }
  const el = node as ReactElement<{ children?: ReactNode }>;
  if (el.type === type) acc.push(el);
  if (el.props && "children" in el.props) findAll(el.props.children, type, acc);
  return acc;
}

describe("PublishedReachNotice", () => {
  it("confirms the publish with the real count, announced as a status", () => {
    const out = renderToStaticMarkup(<PublishedReachNotice reached={12} />);
    expect(out).toContain('class="alert alert--success"');
    expect(out).toContain('role="status"');
    expect(out).toContain("Posting published");
    expect(spoken(out)).toContain("Reached 12 workers");
  });

  it("zero reach is the neutral info alert, never a green 'Reached 0 workers'", () => {
    const out = renderToStaticMarkup(<PublishedReachNotice reached={0} />);
    expect(out).toContain('class="alert alert--info"');
    expect(out).toContain("Posting published");
    expect(out).toContain("No matching workers yet");
    expect(out).not.toContain("Reached 0");
  });

  it("renders nothing without a count", () => {
    expect(renderToStaticMarkup(<PublishedReachNotice reached={null} />)).toBe("");
  });
});

describe("PublishedReachNotice — the workers-reached count counts up (#2585)", () => {
  it("the figure is a CountUp from 0 to the REAL reach, grouped the Indian way", () => {
    const counts = findAll(PublishedReachNotice({ reached: 1500 }), CountUp);
    expect(counts).toHaveLength(1);
    expect(counts[0]!.props).toEqual({ from: 0, to: 1500, format: formatReach });
  });

  it("the server's HTML prints the real figure settled — never the 0 the count starts from", () => {
    const out = renderToStaticMarkup(<PublishedReachNotice reached={1500} />);
    expect(out).toContain(
      'Reached <span class="ui-num"><span class="bb-countup" aria-hidden="true">1,500</span>' +
        '<span class="sr-only">1,500</span></span> workers',
    );
    expect(out).not.toMatch(/aria-hidden="true">0</);
  });

  it("the unit is the FINAL figure's: one worker, never a 'workers' flipping mid-count", () => {
    expect(spoken(renderToStaticMarkup(<PublishedReachNotice reached={1} />))).toContain(
      "Reached 1 worker",
    );
    expect(spoken(renderToStaticMarkup(<PublishedReachNotice reached={1} />))).not.toContain(
      "workers",
    );
  });
});
