import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PublishedReachNotice } from "./published-reach-notice";

describe("PublishedReachNotice", () => {
  it("confirms the publish with the real count, announced as a status", () => {
    const out = renderToStaticMarkup(<PublishedReachNotice reached={12} />);
    expect(out).toContain('class="alert alert--success"');
    expect(out).toContain('role="status"');
    expect(out).toContain("Posting published");
    expect(out).toContain("Reached 12 workers");
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
