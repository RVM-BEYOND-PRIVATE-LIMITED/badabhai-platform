import { describe, expect, it } from "vitest";
import { decl, globalsCss, rules } from "../../test/css-rules";
import { PENDING_ANNOUNCE_DELAY_MS } from "./nav-pending";

/**
 * ONE DELAY, TWO PLACES (approval review of #2095). The pending cue waits before it shows, so a
 * prefetched navigation never flashes it: the dot waits in CSS (`--nav-pending-delay`), the
 * page-wide bar and the status line wait for the announcement (`PENDING_ANNOUNCE_DELAY_MS`). If
 * the two drift, a control's dot and the bar appear at different moments — or one flashes on a
 * fast navigation the other was tuned to hide.
 */
describe("the pending cue's delay", () => {
  it("is the same in the stylesheet and in the announcement", () => {
    const declared = rules(globalsCss())
      .filter((r) => r.selector === ":root")
      .map((r) => decl(r.body, "--nav-pending-delay"))
      .filter((v): v is string => v !== null);
    expect(declared, "--nav-pending-delay declared once, on :root").toHaveLength(1);
    expect(declared[0]).toBe(`${PENDING_ANNOUNCE_DELAY_MS}ms`);
  });
});
