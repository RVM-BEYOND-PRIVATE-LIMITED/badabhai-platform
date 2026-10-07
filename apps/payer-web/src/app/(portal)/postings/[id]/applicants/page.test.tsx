import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type * as ReactModule from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ApplicantFeed, FacelessApplicant } from "../../../../../lib/contracts";

/**
 * /postings/[id]/applicants PAGE tests — the invariants the W2-B polish pass re-laid out.
 *
 * Unlike applicant-actions.test (which seeds hook state into a hand-walked element tree), this
 * renders the WHOLE page through React's real server renderer, so it asserts on the rendered
 * HTML — including the client pipeline, which SSRs with its initial state. It does NOT see the
 * RSC payload: the client pipeline's props (incl. each full worker id, which the unlock action
 * needs) travel there, so the claims below are about what is RENDERED, not every byte sent:
 *  - FACELESS: the explainer alert stays; every card is a masked avatar + an 8-char opaque id;
 *    no phone/email-shaped run, no identity vocabulary in the list, and the VISIBLE text never
 *    shows the full worker id.
 *  - BALANCE IS AN AFFORDANCE: a failed balance read leaves Unlock ENABLED (only a real 0
 *    disables it) — the no-oracle server makes the spend decision. The balance is printed ONCE,
 *    by the shell header's credits chip — never again on this page.
 *  - CREDITS IS FOR EVERY MEMBER (owner ruling 2026-10-07): a zero balance links to /credits for
 *    an owner and a recruiter alike.
 *  - HEADER: the back link goes to the posting this feed belongs to, BY ITS NAME (from the
 *    postings read the page already makes); the New / Shortlist tabs sit in the head's toolbar
 *    row; there is no second (section) head under it.
 *  - COMPANY-ONLY: an agent is sent to the posting's (view-only) details before any read.
 *  - NEUTRAL NOT-FOUND: a null feed (backend 404 for unknown AND not-owned) renders one union
 *    copy with no feed chrome; a failed read is a distinct, retryable error.
 *  - The `.applicants-page` wrapper exists (the screen's touch-target rules are scoped to it).
 * The seams, the server actions and next/link are mocked; nothing here reaches the network.
 */

const getApplicantFeed = vi.fn<(id: string) => Promise<ApplicantFeed | null>>();
const getDashboard = vi.fn();
const requirePayer = vi.fn();
const getOrgRole = vi.fn();
const redirect = vi.fn((to: string) => {
  throw new Error(`NEXT_REDIRECT ${to}`);
});
vi.mock("../../../../../lib/auth", () => ({ requirePayer: () => requirePayer() }));
vi.mock("../../../../../lib/auth/org-roles", () => ({ getOrgRole: (s: unknown) => getOrgRole(s) }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => redirect(to) }));
vi.mock("../../../../../lib/payer-api", () => ({
  getApplicantFeed: (id: string) => getApplicantFeed(id),
  getDashboard: (opts: unknown) => getDashboard(opts),
}));
vi.mock("./actions", () => ({
  unlockAction: vi.fn(),
  revealContactAction: vi.fn(),
  maskedResumeAction: vi.fn(),
}));
vi.mock("next/link", async () => {
  const React = await vi.importActual<typeof ReactModule>("react");
  return {
    // The pending cue inside each link reads its status (components/nav-pending.tsx): idle.
    useLinkStatus: () => ({ pending: false }),
    // `className` is forwarded so a link styled as a DS button (the W3-A Top up) is assertable.
    default: ({
      children,
      href,
      className,
    }: {
      children: ReactNode;
      href: string;
      className?: string;
    }) => React.createElement("a", { href, className }, children),
  };
});
vi.mock("../../../../../components/retry-button", async () => {
  const React = await vi.importActual<typeof ReactModule>("react");
  return { RetryButton: () => React.createElement("button", { type: "button" }, "Retry") };
});

const { default: ApplicantsPage } = await import("./page");

const POSTING = "33333333-3333-4333-8333-333333333333";
const A: FacelessApplicant = {
  workerId: "a1b2c3d4-0000-4000-8000-000000000001",
  rank: 1,
  score: 0,
  hot: false,
  signals: [],
  tradeLabel: "CNC Turner",
  experienceBand: "6-10 yrs",
  cityLabel: "Pune",
  skills: ["CNC turning", "Fanuc control"],
  matchTier: 1,
  effectiveTier: 1,
  skillMonths: 48,
};
const B: FacelessApplicant = {
  workerId: "b2c3d4e5-0000-4000-8000-000000000002",
  rank: 2,
  score: 0.74,
  hot: true,
  signals: ["on-trade", "city"],
  tradeLabel: "Fitter",
  experienceBand: "1-2 yrs",
  cityLabel: "Nashik",
};
// The reach feed carries no role title; the page names its posting from the postings read.
const FEED: ApplicantFeed = { postingId: POSTING, roleTitle: "Applicants", applicants: [A, B] };
/** The payer's own postings list, as the dashboard read returns it (this posting is in it). */
const POSTINGS = [
  { id: "44444444-4444-4444-8444-444444444444", roleTitle: "Fitter", status: "open" },
  { id: POSTING, roleTitle: "CNC Turner", status: "open" },
];
/** The dashboard read: the balance (an affordance) and the postings list (the posting's name). */
const dash = (balance: number, postings: unknown[] = POSTINGS) => ({
  credits: { balance },
  unlocks: [],
  postings,
});

async function html(id: string = POSTING): Promise<string> {
  const tree = (await ApplicantsPage({ params: Promise.resolve({ id }) })) as ReactElement;
  return renderToStaticMarkup(tree);
}

/** Visible text only (tags stripped, entities left as rendered). */
const textOf = (markup: string) => markup.replace(/<[^>]+>/g, " ");

/** The opening tag of every button whose content includes the row's Unlock label. */
function unlockButtonTags(markup: string): string[] {
  return Array.from(
    markup.matchAll(/<button([^>]*)>(?:(?!<\/button>)[\s\S])*?Unlock contact \(1 credit\)/g),
    (m) => m[1]!,
  );
}

beforeEach(() => {
  getApplicantFeed.mockReset().mockResolvedValue(FEED);
  getDashboard.mockReset().mockResolvedValue(dash(5));
  requirePayer.mockReset().mockResolvedValue({ role: "employer" });
  getOrgRole.mockReset().mockReturnValue("owner");
  redirect.mockClear();
});

describe("applicants page — FACELESS rendered markup", () => {
  it("keeps the faceless alert and renders each card as a masked avatar + opaque id", async () => {
    const out = await html();
    expect(out).toContain("Applicants are faceless");
    expect(out.match(/bb-avatar--masked/g)).toHaveLength(FEED.applicants.length);
    expect(out).toContain("a1b2c3d4…");
    expect(out).toContain("b2c3d4e5…");
    // The VISIBLE text never shows the full worker id — only its 8-char opaque prefix. (The id
    // itself is not secret from this payer: it rides the RSC payload to the unlock action.)
    const visible = textOf(out);
    for (const a of FEED.applicants) expect(visible).not.toContain(a.workerId);
  });

  it("carries no phone/email-shaped run anywhere and no identity vocabulary in the list", async () => {
    const out = await html();
    const text = textOf(out);
    expect(text).not.toMatch(/\d{10,}/);
    expect(text).not.toMatch(/\+\d{7,}/);
    expect(text).not.toMatch(/@/);
    // The candidate list itself must not carry identity words at all.
    const list = textOf(out.slice(out.indexOf('class="applicants-list"')));
    expect(list.length).toBeGreaterThan(0);
    expect(list).not.toMatch(/\bname\b|phone|\bemail\b|employer/i);
  });
});

describe("applicants page — the balance is an AFFORDANCE, never a gate", () => {
  it("a failed balance read leaves every Unlock ENABLED", async () => {
    getDashboard.mockRejectedValueOnce(new Error("dashboard 503"));
    const out = await html();
    const tags = unlockButtonTags(out);
    expect(tags).toHaveLength(FEED.applicants.length);
    for (const t of tags) expect(t).not.toMatch(/\bdisabled\b/);
  });

  it("only a real zero balance disables Unlock (and shows the own-balance top-up alert)", async () => {
    getDashboard.mockResolvedValueOnce(dash(0));
    const out = await html();
    const tags = unlockButtonTags(out);
    expect(tags).toHaveLength(FEED.applicants.length);
    for (const t of tags) expect(t).toMatch(/\bdisabled\b/);
    expect(out).toContain("not a signal about any applicant");
  });

  it("a loaded balance is NOT printed again on the page (the shell header's chip shows it)", async () => {
    getDashboard.mockResolvedValueOnce(dash(4321));
    const out = await html();
    // The read still happened (it drives the Unlock affordance)…
    expect(getDashboard).toHaveBeenCalledTimes(1);
    // …but the number appears nowhere in the page markup, and no balance chip/badge renders.
    expect(textOf(out)).not.toContain("4321");
    expect(out).not.toMatch(/Balance:/);
    expect(out).not.toContain("section__actions");
  });

  it("W3-A: only a REAL zero adds a Top up button beside each disabled Unlock", async () => {
    getDashboard.mockResolvedValueOnce(dash(0));
    const zero = await html();
    const rows = zero.split('class="applicant__unlock-actions"').slice(1);
    expect(rows).toHaveLength(FEED.applicants.length);
    for (const row of rows) {
      const actions = row.slice(0, row.indexOf("</div>"));
      expect(actions).toMatch(/<button[^>]*\bdisabled\b[^>]*>[\s\S]*Unlock contact \(1 credit\)/);
      expect(actions).toContain('<a href="/credits" class="bb-btn bb-btn--secondary">');
      expect(textOf(actions)).toMatch(/\bBuy credits\b/);
    }
  });

  it("W3-A: a failed balance read (Unlock enabled) and a positive one show NO Top up button", async () => {
    // The same prefix for both renders: a /credits link styled as ANY DS button (whatever
    // variant or extra class it carries) is a Top up.
    const TOP_UP = '<a href="/credits" class="bb-btn';
    getDashboard.mockRejectedValueOnce(new Error("dashboard 503"));
    const unread = await html();
    expect(unlockButtonTags(unread)).toHaveLength(FEED.applicants.length);
    expect(unread).not.toContain(TOP_UP);
    const positive = await html();
    expect(unlockButtonTags(positive)).toHaveLength(FEED.applicants.length);
    expect(positive).not.toContain(TOP_UP);
  });

  it("W3-A: at a zero balance each card's band has ONE way to /credits — the hint is plain text", async () => {
    getDashboard.mockResolvedValueOnce(dash(0));
    const zero = await html();
    const bands = zero.split('class="applicant__unlock"').slice(1);
    expect(bands).toHaveLength(FEED.applicants.length);
    for (const band of bands) {
      const own = band.slice(0, band.indexOf('aria-live="polite"'));
      expect(own.match(/href="\/credits"/g)).toHaveLength(1);
      expect(textOf(own)).toContain(
        "Buy credits to unlock. Guidance only — this is your own balance, never a signal about this applicant.",
      );
    }
  });
});

describe("applicants page — the head names its posting; the tabs are its toolbar", () => {
  it("the back link and the description name THIS posting, from the postings read already made", async () => {
    const out = await html();
    expect(getDashboard).toHaveBeenCalledTimes(1);
    expect(getDashboard).toHaveBeenCalledWith({ withPostings: true });
    const at = out.indexOf('<p class="page-back">');
    const back = out.slice(at, out.indexOf("</p>", at));
    expect(textOf(back).trim()).toBe("CNC Turner");
    expect(textOf(out)).toContain("Everyone who applied to CNC Turner, best match first");
    // No constant stand-in title, and no second (section) head under the H1.
    expect(out).not.toContain("Ranked candidates");
    expect(out).not.toContain('class="section__head"');
    expect(out.match(/<h[12] /g)).toEqual(["<h1 "]);
  });

  it("the New / Shortlist tabs sit in the head's toolbar row, right under the title", async () => {
    const out = await html();
    const head = out.slice(out.indexOf('<div class="page-head">'));
    const toolbar = head.slice(head.indexOf('<div class="page-head__toolbar">'));
    expect(head.indexOf('<div class="page-head__toolbar">')).toBeGreaterThan(0);
    expect(toolbar.indexOf("applicants-pipeline")).toBeGreaterThan(0);
    expect(toolbar.indexOf("applicants-pipeline")).toBeLessThan(toolbar.indexOf("Applicants are faceless"));
    expect(textOf(toolbar)).toMatch(/New \(2\)/);
  });

  it("falls back to generic words when the posting is not in the list, or the read fails", async () => {
    getDashboard.mockResolvedValueOnce(dash(5, []));
    const missing = await html();
    getDashboard.mockRejectedValueOnce(new Error("dashboard 503"));
    const failed = await html();
    for (const out of [missing, failed]) {
      const at = out.indexOf('<p class="page-back">');
      expect(textOf(out.slice(at, out.indexOf("</p>", at))).trim()).toBe("Posting details");
      expect(textOf(out)).toContain("Everyone who applied to this posting");
    }
  });
});

describe("applicants page — CREDITS is linked for every member (owner ruling 2026-10-07)", () => {
  it("a recruiter at a zero balance gets the link to /credits, like an owner", async () => {
    getOrgRole.mockReturnValue("recruiter");
    getDashboard.mockResolvedValueOnce(dash(0));
    const out = await html();
    expect(out).toContain('href="/credits"');
    expect(textOf(out)).not.toMatch(/account owner/i);
    for (const t of unlockButtonTags(out)) expect(t).toMatch(/\bdisabled\b/);
  });

  it("an owner at a zero balance gets it too", async () => {
    getDashboard.mockResolvedValueOnce(dash(0));
    expect(await html()).toContain('href="/credits"');
  });
});

describe("applicants page — header: back to the posting, one H1, no hand-written head", () => {
  it("renders the shared head with a back link to THIS posting's details", async () => {
    const out = await html();
    const at = out.indexOf('<p class="page-back">');
    expect(at).toBeGreaterThanOrEqual(0);
    const back = out.slice(at, out.indexOf("</p>", at));
    expect(back.startsWith(`<p class="page-back"><a href="/postings/${POSTING}">`)).toBe(true);
    expect(textOf(back).trim()).toBe("CNC Turner");
    expect(out.match(/<h1 /g)).toHaveLength(1);
    expect(out).toContain('<h1 class="page-head__title">Applicants</h1>');
  });

  it("the gate runs first: no feed or balance read when requirePayer rejects", async () => {
    requirePayer.mockRejectedValueOnce(new Error("NEXT_REDIRECT"));
    await expect(html()).rejects.toThrow("NEXT_REDIRECT");
    expect(getApplicantFeed).not.toHaveBeenCalled();
    expect(getDashboard).not.toHaveBeenCalled();
  });

  it("COMPANY-ONLY: an agent goes to the posting's (view-only) details before any read", async () => {
    // An agency's older company postings are view-only, and this feed unlocks contacts.
    requirePayer.mockResolvedValueOnce({ role: "agent" });
    await expect(html()).rejects.toThrow(`NEXT_REDIRECT /postings/${POSTING}`);
    expect(redirect).toHaveBeenCalledWith(`/postings/${POSTING}`);
    expect(getApplicantFeed).not.toHaveBeenCalled();
    expect(getDashboard).not.toHaveBeenCalled();
  });

  it("a company is never redirected", async () => {
    await html();
    expect(redirect).not.toHaveBeenCalled();
  });
});

describe("applicants page — NEUTRAL not-found vs a transient error", () => {
  it("a null feed (unknown OR not-owned) renders one union copy and no feed chrome", async () => {
    getApplicantFeed.mockResolvedValueOnce(null);
    const out = await html();
    expect(out).toContain("No posting found here");
    expect(out).toContain("It may not exist, or it isn’t one of your postings.");
    expect(out).not.toContain("Applicants are faceless");
    expect(out).not.toContain("applicants-list");
    expect(out).not.toContain("couldn’t load applicants");
    // There is no posting to go back to: no back link — the state's ONE way out is Postings.
    expect(out).not.toContain("page-back");
    const state = out.slice(out.indexOf('class="state"'));
    expect(Array.from(state.matchAll(/<a href="([^"]*)"/g), (m) => m[1])).toEqual(["/postings"]);
    expect(textOf(state.slice(state.indexOf("<a "))).trim().startsWith("Postings")).toBe(true);
    expect(state).not.toContain("<button ");
  });

  it("a posting with no applicants yet is a calm state with nothing to press", async () => {
    getApplicantFeed.mockResolvedValueOnce({ ...FEED, applicants: [] });
    const out = await html();
    expect(out).toContain("No applicants on this posting yet");
    const state = out.slice(out.indexOf('class="state"'));
    expect(state).not.toMatch(/<a |<button /);
    // …and the head still names the posting and goes back to it.
    expect(out).toContain(`<p class="page-back"><a href="/postings/${POSTING}">`);
  });

  it("a failed feed read is a retryable error, never the not-found copy", async () => {
    getApplicantFeed.mockRejectedValueOnce(new Error("upstream 502"));
    const out = await html();
    expect(out).toContain("We couldn’t load applicants");
    expect(out).toContain("Retry");
    expect(out).not.toContain("No posting found here");
  });
});

describe("applicants page — a MALFORMED id is the neutral not-found, decided before any read (F31)", () => {
  it("renders 'No posting found here' (not the retry error) and never reaches the API", async () => {
    // The real API refuses a non-uuid path segment; the page must not turn that into "retry".
    getApplicantFeed.mockRejectedValue(new Error("upstream 400"));
    const out = await html("not-a-uuid");
    expect(out).toContain("No posting found here");
    expect(out).toContain("It may not exist, or it isn’t one of your postings.");
    expect(out).not.toContain("couldn’t load applicants");
    expect(out).not.toContain("Retry");
    expect(getApplicantFeed).not.toHaveBeenCalled();
    expect(getDashboard).not.toHaveBeenCalled();
    // Same shape as the unknown-uuid not-found: no back link; the way out is Postings.
    expect(out).not.toContain("page-back");
    const state = out.slice(out.indexOf('class="state"'));
    expect(Array.from(state.matchAll(/<a href="([^"]*)"/g), (m) => m[1])).toEqual(["/postings"]);
    expect(out.match(/<h1 /g)).toHaveLength(1);
  });

  it("the role gate still runs FIRST: an agent with a malformed id is redirected, not shown a 404", async () => {
    requirePayer.mockResolvedValueOnce({ role: "agent" });
    await expect(html("not-a-uuid")).rejects.toThrow("NEXT_REDIRECT /postings/not-a-uuid");
    expect(getApplicantFeed).not.toHaveBeenCalled();
  });
});

describe("applicants page — rows the payer already unlocked start unlocked (F10)", () => {
  const FUTURE = new Date(Date.now() + 7 * 864e5).toISOString();
  const PAST = new Date(Date.now() - 7 * 864e5).toISOString();
  const unlock = (workerId: string, over: Record<string, unknown> = {}) => ({
    unlockId: `${workerId.slice(0, 8)}-1111-4111-8111-111111111111`,
    workerId,
    status: "granted",
    createdAt: "2026-09-01T00:00:00.000Z",
    expiresAt: FUTURE,
    jobId: null,
    ...over,
  });
  /** The props the page hands the client pipeline (they ride the RSC payload). */
  async function feedProps(): Promise<Record<string, unknown>> {
    const tree = (await ApplicantsPage({ params: Promise.resolve({ id: POSTING }) })) as ReactElement<{
      children: ReactElement<Record<string, unknown>>;
    }>;
    return tree.props.children.props;
  }

  it("a live grant (job context null, as a company unlock is stored) starts that row unlocked", async () => {
    getDashboard.mockResolvedValueOnce({ ...dash(5), unlocks: [unlock(A.workerId)] });
    const out = await html();
    // A: the granted band, no spend offered. B: the spend, as before.
    expect(unlockButtonTags(out)).toHaveLength(1);
    expect(out).toContain("Open routed contact");
    expect(textOf(out)).toContain(FUTURE.slice(0, 10));
  });

  it("hands the client ONLY live grants for workers on THIS feed — nothing else from the history", async () => {
    const OFF_FEED = "c3d4e5f6-0000-4000-8000-000000000003";
    getDashboard.mockResolvedValueOnce({
      ...dash(5),
      unlocks: [
        unlock(A.workerId),
        unlock(B.workerId, { expiresAt: PAST }), // lapsed: the stored status still reads granted
        unlock(OFF_FEED),
        unlock("d4e5f6a7-0000-4000-8000-000000000004", { status: "expired" }),
      ],
    });
    const props = await feedProps();
    expect(props.unlocked).toEqual({
      [A.workerId]: { kind: "granted", unlockId: unlock(A.workerId).unlockId, expiresAt: FUTURE },
    });
  });

  it("a lapsed grant offers the spend again; a failed history read starts every row locked", async () => {
    getDashboard.mockResolvedValueOnce({ ...dash(5), unlocks: [unlock(A.workerId, { expiresAt: PAST })] });
    expect(unlockButtonTags(await html())).toHaveLength(FEED.applicants.length);
    getDashboard.mockRejectedValueOnce(new Error("dashboard 503"));
    const failed = await html();
    expect(unlockButtonTags(failed)).toHaveLength(FEED.applicants.length);
    expect(failed).not.toContain("Open routed contact");
  });
});

describe("applicants page — W2-B layout namespace", () => {
  it("wraps the screen in `.applicants-page` (the touch-target rules are scoped to it)", async () => {
    expect(await html()).toMatch(/^<div class="applicants-page">/);
  });
});

describe("applicants page — Reached N workers (a fresh publish lands here)", () => {
  async function landed(query: Record<string, string>): Promise<string> {
    const tree = (await ApplicantsPage({
      params: Promise.resolve({ id: POSTING }),
      searchParams: Promise.resolve(query),
    })) as ReactElement;
    return renderToStaticMarkup(tree);
  }

  it("the empty feed of a just-published posting confirms its reach", async () => {
    getApplicantFeed.mockResolvedValueOnce({ ...FEED, applicants: [] });
    const out = await landed({ reached: "18" });
    expect(textOf(out)).toContain("Posting published");
    expect(textOf(out)).toContain("Reached 18 workers");
    expect(textOf(out)).toContain("No applicants on this posting yet");
  });

  it("no param → no count; a not-found posting never claims one", async () => {
    getApplicantFeed.mockResolvedValueOnce({ ...FEED, applicants: [] });
    expect(textOf(await landed({}))).not.toContain("Reached");
    getApplicantFeed.mockResolvedValueOnce(null);
    expect(textOf(await landed({ reached: "18" }))).not.toContain("Reached");
  });

  it("a stale link onto a posting that is no longer open claims no reach", async () => {
    getApplicantFeed.mockResolvedValueOnce({ ...FEED, applicants: [] });
    getDashboard.mockResolvedValueOnce(dash(5, [{ id: POSTING, roleTitle: "CNC Turner", status: "paused" }]));
    expect(textOf(await landed({ reached: "18" }))).not.toContain("Reached");
  });
});
