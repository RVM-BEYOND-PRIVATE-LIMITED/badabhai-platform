import { describe, expect, it } from "vitest";
import { requestListFocus, takeListFocus } from "./list-focus";

/**
 * #2588 — after paging, the heading of the list a pager link opened takes focus: once, and only on
 * that address, so a request whose page drew no list never moves focus anywhere later.
 */
describe("requestListFocus / takeListFocus", () => {
  it("the heading drawn on the requested address takes it — once", () => {
    requestListFocus("/candidates?cursor=abc&from=21");
    expect(takeListFocus("/candidates?cursor=abc&from=21")).toBe(true);
    expect(takeListFocus("/candidates?cursor=abc&from=21")).toBe(false);
  });

  it("the same address in another key order or spelling is the same address", () => {
    requestListFocus("/candidates?city=Navi+Mumbai&cursor=abc");
    expect(takeListFocus("/candidates?cursor=abc&city=Navi%20Mumbai")).toBe(true);
  });

  it("a heading on any OTHER address leaves the request alone (the list being left re-renders)", () => {
    requestListFocus("/candidates?cursor=abc&from=21");
    expect(takeListFocus("/candidates")).toBe(false);
    expect(takeListFocus("/candidates/applied?cursor=abc&from=21")).toBe(false);
    expect(takeListFocus("/candidates?cursor=abc&from=21")).toBe(true);
  });

  it("nothing requested: no heading takes focus (a plain visit, a reload, Back)", () => {
    expect(takeListFocus("/candidates")).toBe(false);
  });

  it("the newest request wins", () => {
    requestListFocus("/candidates?cursor=abc&from=21");
    requestListFocus("/candidates");
    expect(takeListFocus("/candidates?cursor=abc&from=21")).toBe(false);
    expect(takeListFocus("/candidates")).toBe(true);
  });
});
