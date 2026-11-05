import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Timestamp } from "./timestamp";

/** Every visible timestamp reads IST, with the exact UTC instant on hover (#2572). */
describe("Timestamp", () => {
  it("shows IST, keeps UTC in the title and the machine value in dateTime", () => {
    expect(renderToStaticMarkup(<Timestamp iso="2026-08-19T07:38:54.000Z" />)).toBe(
      '<time dateTime="2026-08-19T07:38:54.000Z" title="2026-08-19 07:38:54 UTC">' +
        "19 Aug 2026, 13:08 IST</time>",
    );
  });

  it("dateOnly shows just the IST day", () => {
    expect(renderToStaticMarkup(<Timestamp iso="2026-08-19T20:00:00Z" dateOnly />)).toContain(
      ">20 Aug 2026</time>",
    );
  });
});
