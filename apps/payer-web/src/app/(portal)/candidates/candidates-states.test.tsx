import { describe, expect, it } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { PagerLink } from "../../../components/paged-list";
import { CandidatesPager, CursorRefusedState, LoadErrorState } from "./candidates-states";

/**
 * #2588 — the Candidates lists' shared pager: the rows on screen first, then First page / Next page,
 * each a PagerLink (so the heading of the list it opens takes focus) — as are the states' "First
 * page" ways back in. Node env: the returned element tree, walked through its children.
 */
type El = ReactElement<{ children?: ReactNode; className?: string; href?: string }>;

function elements(node: ReactNode, out: El[] = []): El[] {
  if (node === null || node === undefined || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const n of node) elements(n, out);
    return out;
  }
  const el = node as El;
  out.push(el);
  // Children only — never a component's own render (Retry is a hooked client component).
  if (el.props && "children" in el.props) elements(el.props.children, out);
  return out;
}
const links = (node: ReactNode) => elements(node).filter((e) => e.type === PagerLink);

describe("CandidatesPager", () => {
  it("the range, then First page and Next page — both PagerLinks", () => {
    const nav = CandidatesPager({
      firstPage: "/candidates",
      nextPage: "/candidates?cursor=abc&from=41",
      range: "Showing 21–40 of 57",
    }) as El;
    expect(nav.type).toBe("nav");
    const kids = (nav.props.children as ReactNode[]).filter(Boolean) as El[];
    expect(kids[0]).toMatchObject({
      type: "p",
      props: { className: "candidates-pager__range", children: "Showing 21–40 of 57" },
    });
    expect(links(nav).map((l) => l.props.href)).toEqual([
      "/candidates",
      "/candidates?cursor=abc&from=41",
    ]);
  });

  it("no range when this page's start is unknown; nothing at all for a one-page list", () => {
    const nav = CandidatesPager({ firstPage: null, nextPage: "/candidates?cursor=abc" }) as El;
    expect(elements(nav).some((e) => e.props?.className === "candidates-pager__range")).toBe(false);
    expect(
      CandidatesPager({ firstPage: null, nextPage: null, range: "Showing 1–12 of 12" }),
    ).toBeNull();
  });
});

describe("the states' First page is a PagerLink too (paging back in focuses the list heading)", () => {
  it("an outage on a later page, and a refused cursor", () => {
    expect(
      links(LoadErrorState({ firstPage: "/candidates", body: "x" })).map((l) => l.props.href),
    ).toEqual(["/candidates"]);
    expect(
      links(CursorRefusedState({ firstPage: "/candidates?city=Pune" })).map((l) => l.props.href),
    ).toEqual(["/candidates?city=Pune"]);
  });
});
