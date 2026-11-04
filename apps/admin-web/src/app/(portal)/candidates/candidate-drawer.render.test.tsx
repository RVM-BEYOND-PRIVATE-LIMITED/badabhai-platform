import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { candidateRecord, facelessRecord, RECORD_WORKER_ID } from "../../../../test/candidate-record";
import type { CandidateRecordResult } from "../../../lib/candidate-detail";

/**
 * A7 (#2577) — the candidate drawer as rendered: closed without `?c=`, open over the list with
 * it; its title (the name, or the short id — never empty); the skeleton while the record loads;
 * every failure with its own way out; the tab row; and the footer — Previous / Next through the
 * current page and Open full page.
 */
const nav = vi.hoisted(() => ({ search: "" }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/candidates",
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

// The tabs' content is its own test (candidate-record-view.render.test.tsx).
vi.mock("./candidate-record-view", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./candidate-record-view")>()),
  CandidateRecordPanels: ({ active, entitled, canReveal }: { active: string; entitled: boolean; canReveal: boolean }) => (
    <div data-panels={active} data-entitled={String(entitled)} data-can-reveal={String(canReveal)} />
  ),
}));

const { CandidateDrawer } = await import("./candidate-drawer");

const W = RECORD_WORKER_ID;
const ROWS = [
  { id: "a1a1a1a1-0000-4000-8000-000000000001", title: "Sunita Devi" },
  { id: W, title: "Ramesh Kumar" },
  { id: "c3c3c3c3-0000-4000-8000-000000000003", title: "Candidate c3c3…0003" },
];

beforeEach(() => {
  nav.search = "";
});

const html = (
  initial: { id: string; result: CandidateRecordResult } | null = null,
  props: { rows?: typeof ROWS; entitled?: boolean; canReveal?: boolean } = {},
) =>
  renderToStaticMarkup(
    <CandidateDrawer
      rows={props.rows ?? ROWS}
      initial={initial}
      entitled={props.entitled ?? true}
      canReveal={props.canReveal ?? false}
    />,
  );

const ok = (detail = candidateRecord()) => ({ id: detail.worker_id, result: { status: "ok" as const, detail } });

describe("addressed by ?c=", () => {
  it("renders nothing without it — the list alone", () => {
    nav.search = "status=active";
    expect(html()).toBe("");
  });

  it("is a modal drawer over the list with it", () => {
    nav.search = `status=active&c=${W}`;
    const out = html(ok());
    expect(out).toContain('<div class="overlay overlay--drawer" data-state="open">');
    expect(out).toMatch(/role="dialog" aria-modal="true"/);
  });
});

describe("the record the page read on the server", () => {
  beforeEach(() => {
    nav.search = `c=${W}`;
  });

  it("is shown at once: titled by the disclosed name, the trade, the city and the short id under it", () => {
    const out = html(ok());
    expect(out).toContain('<h2 class="overlay__title"');
    expect(out).toContain(">Ramesh Kumar</h2>");
    expect(out).toContain("<span>TIG Welder · Pune</span>");
    expect(out).toContain(`<span class="mono" title="${W}">0b7f…9a01</span>`);
    expect(out).toContain('data-panels="profile"');
    expect(out).not.toContain("cdrawer__skeleton");
  });

  it("an analyst's record (no name disclosed) is titled by the short id — never an empty title", () => {
    const out = html(ok(facelessRecord()), { entitled: false });
    expect(out).toContain(">Candidate 0b7f…9a01</h2>");
    expect(out).toContain('data-entitled="false"');
  });

  it("the tab row: seven tabs, Profile selected, one tab stop", () => {
    const out = html(ok());
    const tabs = [...out.matchAll(/<button[^>]*role="tab"[^>]*>([^<]*)<\/button>/g)];
    expect(tabs.map((m) => m[1])).toEqual([
      "Profile",
      "Work history",
      "Skills",
      "Applications",
      "Resume",
      "Activity",
      "Edit log",
    ]);
    expect(tabs[0]![0]).toContain('aria-selected="true"');
    expect(tabs[0]![0]).toContain('tabindex="0"');
    expect(tabs[0]![0]).toContain("btn--selected");
    for (const t of tabs.slice(1)) {
      expect(t[0]).toContain('aria-selected="false"');
      expect(t[0]).toContain('tabindex="-1"');
    }
    expect(out).toContain('role="tablist" aria-label="Candidate record"');
  });

  it("passes the reveal capability through", () => {
    expect(html(ok(), { canReveal: true })).toContain('data-can-reveal="true"');
  });
});

describe("while the record loads", () => {
  it("a skeleton, busy, titled from the list row — and tabs with nothing to switch to are disabled", () => {
    nav.search = `c=${W}`;
    const out = html(null);
    expect(out).toContain('class="cdrawer__view" aria-busy="true"');
    expect(out).toContain('<div class="cdrawer__skeleton" aria-hidden="true">');
    expect(out).toContain("Loading the candidate&#x27;s record…");
    expect(out).toContain(">Ramesh Kumar</h2>");
    expect(out.match(/role="tab"[^>]*disabled=""/g)?.length).toBe(7);
    // A disabled tab controls no panel yet.
    expect(out).not.toContain("aria-controls");
  });

  it("the server's read of ANOTHER candidate is not shown for this one", () => {
    nav.search = `c=${ROWS[0]!.id}`;
    const out = html(ok());
    expect(out).toContain("cdrawer__skeleton");
    expect(out).toContain(">Sunita Devi</h2>");
    expect(out).not.toContain("data-panels");
  });

  it("a candidate not in the list is titled by the short id", () => {
    nav.search = "c=d4d4d4d4-0000-4000-8000-000000000004";
    expect(html(null)).toContain(">Candidate d4d4…0004</h2>");
  });
});

describe("every failure has its own screen and its own way out", () => {
  beforeEach(() => {
    nav.search = `c=${W}`;
  });
  const failed = (status: "not_found" | "forbidden" | "signed_out" | "error") =>
    html({ id: W, result: { status } });

  it("not found", () => {
    const out = failed("not_found");
    expect(out).toContain("No such candidate");
    expect(out).not.toContain(">Retry<");
  });

  it("a role that may not read records", () => {
    expect(failed("forbidden")).toContain("Your role cannot open candidate records");
  });

  it("a session that ended: sign in again", () => {
    const out = failed("signed_out");
    expect(out).toContain("Your session has ended");
    expect(out).toMatch(/href="\/login">.*Sign in<\/a>/);
  });

  it("a fault on our side: Retry", () => {
    const out = failed("error");
    expect(out).toContain("The record did not load");
    expect(out).toMatch(/<button type="button" class="btn btn--ghost">.*Retry<\/button>/);
  });

  it("none of them shows a record's tabs", () => {
    for (const s of ["not_found", "forbidden", "signed_out", "error"] as const) {
      expect(failed(s)).not.toContain("data-panels");
    }
  });
});

describe("the footer: through the current page, and out to the full page", () => {
  /** The footer's markup. */
  const foot = (out: string) => out.slice(out.indexOf('class="overlay__foot"'));
  /** The footer button that holds `label`. */
  const button = (out: string, label: string) =>
    [...foot(out).matchAll(/<button[^>]*>(?:(?!<\/button>).)*<\/button>/g)]
      .map((m) => m[0])
      .find((b) => b.includes(label)) ?? "";

  it("says where in the page this candidate is, with Previous and Next (↑ / ↓)", () => {
    nav.search = `c=${W}`;
    const out = html(ok());
    expect(foot(out)).toContain("2 of 3 on this page");
    expect(button(out, "Previous")).toContain('aria-keyshortcuts="ArrowUp"');
    expect(button(out, "Next")).toContain('aria-keyshortcuts="ArrowDown"');
    expect(button(out, "Previous")).not.toContain("disabled");
    expect(button(out, "Next")).not.toContain("disabled");
  });

  it("the first row has no Previous and the last no Next — the page is the range", () => {
    nav.search = `c=${ROWS[0]!.id}`;
    expect(button(html(null), "Previous")).toContain('disabled=""');
    nav.search = `c=${ROWS[2]!.id}`;
    expect(button(html(null), "Next")).toContain('disabled=""');
  });

  it("a candidate not on this page says so, and moves nowhere", () => {
    nav.search = "c=d4d4d4d4-0000-4000-8000-000000000004";
    const out = html(null);
    expect(foot(out)).toContain("Not on this page");
    expect(button(out, "Previous")).toContain('disabled=""');
    expect(button(out, "Next")).toContain('disabled=""');
  });

  it("Open full page links the worker's page", () => {
    nav.search = `c=${W}`;
    expect(foot(html(ok()))).toMatch(new RegExp(`href="/candidates/${W}">.*Open full page</a>`));
  });
});
