import { afterEach, describe, expect, it, vi } from "vitest";
import type * as ReactModule from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * CountUp — WHERE it starts (#2585). A CountUp that came with the page (the server render and its
 * hydration) prints the FINAL figure: the server's HTML never shows the `from` a count starts at
 * ("Reached 0 workers" before the script runs, or for good if it never does). One that mounts in
 * the browser (a toast, a client navigation, the shell chip's change) starts at `from` and counts.
 *
 * Which of the two a render is comes from `useSyncExternalStore`'s server vs client snapshot —
 * React's own rule. The node env renders on the server, so the browser case flips the hook to the
 * client snapshot; everything else (useState, useEffect) is the real React.
 */
const hooks = vi.hoisted(() => ({ browser: false }));
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof ReactModule>("react");
  return {
    ...actual,
    useSyncExternalStore: (
      subscribe: () => () => void,
      getSnapshot: () => unknown,
      getServerSnapshot?: () => unknown,
    ) =>
      hooks.browser || !getServerSnapshot
        ? getSnapshot()
        : actual.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot),
  };
});

const { CountUp } = await import("./count-up");

afterEach(() => {
  hooks.browser = false;
});

describe("CountUp — a figure that came with the page is printed settled", () => {
  it("the server's HTML shows the final figure, visible and announced — never `from`", () => {
    expect(renderToStaticMarkup(<CountUp from={0} to={12} />)).toBe(
      '<span class="bb-countup" aria-hidden="true">12</span><span class="sr-only">12</span>',
    );
  });

  it("formatted the same way in both twins", () => {
    const out = renderToStaticMarkup(
      <CountUp from={0} to={150000} format={(n) => n.toLocaleString("en-IN")} />,
    );
    expect(out).toBe(
      '<span class="bb-countup" aria-hidden="true">1,50,000</span><span class="sr-only">1,50,000</span>',
    );
  });
});

describe("CountUp — a browser mount counts from `from`", () => {
  it("starts at `from`; the announced twin is already the final figure", () => {
    hooks.browser = true;
    expect(renderToStaticMarkup(<CountUp from={5} to={4} />)).toBe(
      '<span class="bb-countup" aria-hidden="true">5</span><span class="sr-only">4</span>',
    );
  });
});
