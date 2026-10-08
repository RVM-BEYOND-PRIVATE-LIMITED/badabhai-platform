import { describe, expect, it, vi, beforeEach } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import type * as ReactModule from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CandidateInbox, CandidateInboxRow } from "../../../lib/contracts";
import { PayerValidationError } from "../../../lib/payer-errors";

/**
 * /candidates PAGE — every applicant across the payer's postings (owner request 2026-10-07).
 *
 * Rendered whole through React's server renderer (as the applicants page test does), so the
 * claims are about the HTML a payer gets — including the shared client card list, which SSRs with
 * its initial state. Seams, auth, flags, the server actions and next/link are mocked.
 *  - GATES: requirePayer first (a rejection reads nothing); an agency with the agency portal off
 *    is the neutral 404 before any read; `force-dynamic`.
 *  - HEAD: one H1 "Candidates", no back link, the posting filter in its toolbar (a GET form to
 *    /candidates with the payer's OWN postings — company postings or agency jobs per persona).
 *  - LIST: the shared faceless cards, each naming its posting (linked per this session's pages),
 *    one card list (so one confirm dialog), the balance as an affordance, live grants seeded.
 *  - FILTER / PAGING: `?postingId=` reaches the seam; a non-id never does; `nextCursor` → Next
 *    page keeping the filter; a later page offers First page.
 *  - STATES: empty, filtered-empty (= unknown id, byte for byte), error (Retry, head kept), 429,
 *    and a REFUSED page cursor (400 with a cursor) — First page with the filter kept, never Retry.
 *  - PENDING CUE: every query-only link (First page, Next page, All postings) and each card's
 *    "Applied to" link carries the navigation pending cue (no loading boundary — #2115).
 */

const requirePayer = vi.fn();
const agencyFlags = vi.fn();
const getCandidateInbox = vi.fn<(q?: unknown) => Promise<CandidateInbox>>();
const getPostings = vi.fn();
const listAgencyJobs = vi.fn();
const getCredits = vi.fn();
const getUnlocks = vi.fn();
const notFound = vi.fn(() => {
  throw new Error("NEXT_NOT_FOUND");
});

vi.mock("../../../lib/auth", () => ({ requirePayer: () => requirePayer() }));
vi.mock("../../../lib/config", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, agencyFlags: () => agencyFlags() };
});
vi.mock("next/navigation", () => ({ notFound: () => notFound() }));
vi.mock("../../../lib/payer-api", () => ({
  getCandidateInbox: (q?: unknown) => getCandidateInbox(q),
  getPostings: () => getPostings(),
  listAgencyJobs: () => listAgencyJobs(),
  getCredits: () => getCredits(),
  getUnlocks: () => getUnlocks(),
}));
vi.mock("../postings/[id]/applicants/actions", () => ({
  unlockAction: vi.fn(),
  revealContactAction: vi.fn(),
  maskedResumeAction: vi.fn(),
}));
vi.mock("next/link", async () => {
  const React = await vi.importActual<typeof ReactModule>("react");
  return {
    // The pending cue inside each link reads its status (components/nav-pending.tsx): idle.
    useLinkStatus: () => ({ pending: false }),
    default: ({ children, href, className }: { children: ReactNode; href: string; className?: string }) =>
      React.createElement("a", { href, className }, children),
  };
});
vi.mock("../../../components/retry-button", async () => {
  const React = await vi.importActual<typeof ReactModule>("react");
  return {
    RetryButton: ({ label = "Retry" }: { label?: string }) =>
      React.createElement("button", { type: "button", "data-retry": "" }, label),
  };
});

const mod = await import("./page");
const CandidatesPage = mod.default;
const { CandidateFilter } = await import("./candidate-filter");
const { ApplicantActions } = await import("../postings/[id]/applicants/applicant-actions");

const P1 = "11111111-0000-4000-8000-000000000001";
const P2 = "11111111-0000-4000-8000-000000000002";
const J1 = "22222222-0000-4000-8000-000000000001";
const W1 = "a1b2c3d4-0000-4000-8000-000000000001";
const W2 = "b2c3d4e5-0000-4000-8000-000000000002";
const W3 = "c3d4e5f6-0000-4000-8000-000000000003";
const NEXT = "eyJ2IjoxLCJ0IjoiMjAyNi0xMC0wNyJ9";

const companyRow = (workerId: string, postingId = P1, title = "CNC Turner"): CandidateInboxRow => ({
  workerId,
  rank: 1,
  score: 0,
  hot: false,
  signals: [],
  tradeLabel: "CNC Turner",
  experienceBand: "6-10 yrs",
  cityLabel: "Pune",
  matchTier: 1,
  skillMonths: 48,
  posting: { id: postingId, title, kind: "company_posting" },
});
const agencyRow = (workerId: string): CandidateInboxRow => ({
  workerId,
  rank: 2,
  score: 0.74,
  hot: true,
  signals: ["Same trade"],
  tradeLabel: "Fitter",
  posting: { id: J1, title: "Fitter", kind: "agency_job" },
});

const POSTINGS = [
  { id: P1, roleTitle: "CNC Turner", status: "open", locationLabel: null, vacancyBand: "2-5", applicantCount: 0, createdAt: "2026-10-01T00:00:00.000Z" },
  { id: P2, roleTitle: "VMC Operator", status: "paused", locationLabel: null, vacancyBand: "2-5", applicantCount: 0, createdAt: "2026-10-01T00:00:00.000Z" },
];
const JOBS = [{ id: J1, title: "Fitter", status: "open" }];

const FUTURE = new Date(Date.now() + 7 * 864e5).toISOString();
const PAST = new Date(Date.now() - 7 * 864e5).toISOString();
const unlock = (workerId: string, over: Record<string, unknown> = {}) => ({
  unlockId: `${workerId.slice(0, 8)}-1111-4111-8111-111111111111`,
  workerId,
  status: "granted",
  createdAt: "2026-09-01T00:00:00.000Z",
  expiresAt: FUTURE,
  ...over,
});

type Query = Record<string, string | string[] | undefined>;

async function tree(query: Query = {}): Promise<ReactElement> {
  return (await CandidatesPage({ searchParams: Promise.resolve(query) })) as ReactElement;
}
async function html(query: Query = {}): Promise<string> {
  return renderToStaticMarkup(await tree(query));
}
const textOf = (markup: string) => markup.replace(/<[^>]+>/g, " ");
const unlockButtons = (markup: string) =>
  Array.from(
    markup.matchAll(/<button([^>]*)>(?:(?!<\/button>)[\s\S])*?Unlock contact \(1 credit\)/g),
    (m) => m[1]!,
  );
/**
 * Every link in the markup → whether it carries the navigation pending cue (the idle cue SSRs as
 * its always-present `nav-pending` span, a DIRECT child of the link — what the CSS anchors on).
 */
const linkCue = (markup: string) =>
  new Map(
    Array.from(markup.matchAll(/<a href="([^"]*)"[^>]*>((?:(?!<\/a>)[\s\S])*)<\/a>/g), (m) => [
      m[1]!.replace(/&amp;/g, "&"),
      m[2]!.endsWith('<span class="nav-pending" aria-hidden="true"></span>'),
    ]),
  );
/** The markup of the state card (from its `.state` block to the end). */
const stateOf = (markup: string) => markup.slice(markup.indexOf('<div class="state'));
/** The props the page hands the ONE shared card list (they ride the RSC payload). */
async function listProps(query: Query = {}): Promise<Record<string, unknown>> {
  const t = (await tree(query)) as ReactElement<{ children: ReactNode[] }>;
  const lists = (t.props.children as ReactElement[]).filter((c) => c?.type === ApplicantActions);
  expect(lists).toHaveLength(1);
  return (lists[0] as ReactElement<Record<string, unknown>>).props;
}

const COMPANY = { role: "employer" };
const AGENCY = { role: "agent" };

beforeEach(() => {
  requirePayer.mockReset().mockResolvedValue(COMPANY);
  agencyFlags.mockReset().mockReturnValue({ agencyPortalEnabled: true });
  getCandidateInbox.mockReset().mockResolvedValue({
    applicants: [companyRow(W1), companyRow(W2, P2, "VMC Operator")],
    nextCursor: null,
  });
  getPostings.mockReset().mockResolvedValue(POSTINGS);
  listAgencyJobs.mockReset().mockResolvedValue(JOBS);
  getCredits.mockReset().mockResolvedValue({ payerId: "x", balance: 5 });
  getUnlocks.mockReset().mockResolvedValue([]);
  notFound.mockClear();
});

describe("candidates page — gates first", () => {
  it("is force-dynamic (request-time reads, request-time unlock windows)", () => {
    expect(mod.dynamic).toBe("force-dynamic");
  });

  it("requirePayer runs FIRST: when it rejects, nothing is read", async () => {
    requirePayer.mockRejectedValueOnce(new Error("NEXT_REDIRECT /login"));
    await expect(html()).rejects.toThrow("NEXT_REDIRECT /login");
    for (const read of [getCandidateInbox, getPostings, listAgencyJobs, getCredits, getUnlocks]) {
      expect(read).not.toHaveBeenCalled();
    }
  });

  it("an agency with the agency portal OFF gets the neutral 404 before any read", async () => {
    requirePayer.mockResolvedValueOnce(AGENCY);
    agencyFlags.mockReturnValue({ agencyPortalEnabled: false });
    await expect(html()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFound).toHaveBeenCalledTimes(1);
    for (const read of [getCandidateInbox, getPostings, listAgencyJobs, getCredits, getUnlocks]) {
      expect(read).not.toHaveBeenCalled();
    }
  });

  it("both personas open it: a company, and an agency with the portal on", async () => {
    expect(await html()).toContain('<h1 class="page-head__title">Candidates</h1>');
    requirePayer.mockResolvedValueOnce(AGENCY);
    getCandidateInbox.mockResolvedValueOnce({ applicants: [agencyRow(W3)], nextCursor: null });
    expect(await html()).toContain('<h1 class="page-head__title">Candidates</h1>');
    // A company's flag never matters.
    agencyFlags.mockReturnValue({ agencyPortalEnabled: false });
    expect(await html()).toContain('<h1 class="page-head__title">Candidates</h1>');
    expect(notFound).not.toHaveBeenCalled();
  });
});

describe("candidates page — the head: one H1, no back link, the posting filter as its toolbar", () => {
  it("renders ONE PageHeader with a one-sentence description and no primary action", async () => {
    const out = await html();
    expect(out.match(/<h1 /g)).toHaveLength(1);
    expect(out).not.toContain("page-back");
    expect(out).not.toContain("page-head__actions");
    expect(textOf(out)).toContain("Everyone who applied to your postings, newest first");
  });

  it("the toolbar is a GET form to /candidates: a labelled postingId select + Show", async () => {
    const out = await html();
    const toolbar = out.slice(out.indexOf('<div class="page-head__toolbar">'));
    expect(out.indexOf('<div class="page-head__toolbar">')).toBeGreaterThan(0);
    const form = /<form class="candidates-filter__form"[^>]*>/.exec(toolbar)?.[0] ?? "";
    for (const attr of ['method="get"', 'action="/candidates"', 'role="search"']) {
      expect(form, attr).toContain(attr);
    }
    expect(toolbar).toContain('<label class="bb-field__label" for="candidates-posting">Posting</label>');
    expect(toolbar).toMatch(/<select id="candidates-posting" class="[^"]*" name="postingId"/);
    expect(toolbar).toMatch(/<button type="submit" class="bb-btn bb-btn--secondary">[\s\S]*Show/);
    // No stage tabs anywhere: the inbox filters by posting only.
    expect(out).not.toContain("applicants-pipeline");
    expect(textOf(out)).not.toMatch(/Shortlist \(/);
  });

  it("a COMPANY's options are its own company postings (status named), after All postings", async () => {
    const out = await html();
    const options = Array.from(out.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g), (m) => [m[1], m[2]]);
    expect(options).toEqual([
      ["", "All postings"],
      [P1, "CNC Turner"],
      [P2, "VMC Operator (paused)"],
    ]);
    expect(getPostings).toHaveBeenCalledTimes(1);
    expect(listAgencyJobs).not.toHaveBeenCalled();
  });

  it("an AGENCY's options are its own agency postings — the company list is never read", async () => {
    requirePayer.mockResolvedValueOnce(AGENCY);
    getCandidateInbox.mockResolvedValueOnce({ applicants: [agencyRow(W3)], nextCursor: null });
    const out = await html();
    const options = Array.from(out.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g), (m) => m[1]);
    expect(options).toEqual(["", J1]);
    expect(listAgencyJobs).toHaveBeenCalledTimes(1);
    expect(getPostings).not.toHaveBeenCalled();
  });

  it("a failed postings read leaves the filter (All postings) and the list — with a note", async () => {
    getPostings.mockRejectedValueOnce(new Error("503"));
    const out = await html();
    expect(out).toContain('<option value="" selected="">All postings</option>');
    expect(out).toContain("candidates-filter__note");
    expect(out).toMatch(/<select[^>]*aria-describedby="candidates-posting-note"/);
    expect(out.match(/bb-avatar--masked/g)).toHaveLength(2);
  });
});

describe("candidates page — the list: the shared faceless cards, each naming its posting", () => {
  it("renders ONE shared card list, its cards faceless, each linking its company posting", async () => {
    const out = await html();
    expect(out.match(/bb-avatar--masked/g)).toHaveLength(2);
    const cue = '<span class="nav-pending" aria-hidden="true"></span>';
    expect(out).toContain(`<a href="/postings/${P1}" class="applicant__posting-link">CNC Turner${cue}</a>`);
    expect(out).toContain(`<a href="/postings/${P2}" class="applicant__posting-link">VMC Operator${cue}</a>`);
    expect(out).toContain("Applicants are faceless");
    expect(unlockButtons(out)).toHaveLength(2);
    await listProps(); // exactly one ApplicantActions → exactly one ConfirmSpendDialog
    expect(out).toMatch(/^<div class="applicants-page candidates-page">/);
  });

  it("hands the list NO postingId: each row's own posting is its unlock context", async () => {
    const props = await listProps();
    expect(props.postingId).toBeUndefined();
    const rows = props.applicants as Array<{ workerId: string; posting: unknown }>;
    expect(rows.map((r) => [r.workerId, r.posting])).toEqual([
      [W1, { id: P1, title: "CNC Turner", href: `/postings/${P1}`, viewOnly: false }],
      [W2, { id: P2, title: "VMC Operator", href: `/postings/${P2}`, viewOnly: false }],
    ]);
  });

  it("an AGENCY: its own job links /agency/jobs/<id>; an older company posting is view-only text", async () => {
    requirePayer.mockResolvedValueOnce(AGENCY);
    getCandidateInbox.mockResolvedValueOnce({
      applicants: [agencyRow(W3), companyRow(W1, P1, "Old company posting")],
      nextCursor: null,
    });
    const out = await html();
    expect(out).toContain(
      `<a href="/agency/jobs/${J1}" class="applicant__posting-link">Fitter<span class="nav-pending" aria-hidden="true"></span></a>`,
    );
    expect(out).not.toContain(`href="/postings/${P1}"`);
    expect(out).toContain('<span class="applicant__posting-title">Old company posting</span>');
    // The agency job's card offers the spend; the view-only one does not.
    expect(unlockButtons(out)).toHaveLength(1);
    expect(textOf(out)).toContain("View only");
  });

  it("the balance is an affordance: unread keeps Unlock enabled; only a real zero disables it", async () => {
    getCredits.mockRejectedValueOnce(new Error("503"));
    for (const t of unlockButtons(await html())) expect(t).not.toMatch(/\bdisabled\b/);
    getCredits.mockResolvedValueOnce({ payerId: "x", balance: 0 });
    const zero = await html();
    expect(unlockButtons(zero)).toHaveLength(2);
    for (const t of unlockButtons(zero)) expect(t).toMatch(/\bdisabled\b/);
    expect(zero).toContain('href="/credits"');
  });

  it("FACELESS: no phone/email-shaped run and never a full worker id in the visible text", async () => {
    const text = textOf(await html());
    expect(text).not.toMatch(/\d{10,}/);
    expect(text).not.toMatch(/\+\d{7,}/);
    expect(text).not.toMatch(/@/);
    for (const id of [W1, W2]) expect(text).not.toContain(id);
    expect(text).toContain("a1b2c3d4…");
  });
});

describe("candidates page — already unlocked rows start unlocked (liveUnlocksFor)", () => {
  it("a LIVE grant starts that row unlocked; the other row still offers the spend", async () => {
    getUnlocks.mockResolvedValueOnce([unlock(W1)]);
    const out = await html();
    expect(unlockButtons(out)).toHaveLength(1);
    expect(out).toContain("Open routed contact");
    expect(textOf(out)).toContain(FUTURE.slice(0, 10));
  });

  it("hands the list ONLY live grants for workers on THIS page", async () => {
    getUnlocks.mockResolvedValueOnce([
      unlock(W1),
      unlock(W2, { expiresAt: PAST }),
      unlock(W3), // not on this page
      unlock("d4e5f6a7-0000-4000-8000-000000000004", { status: "expired" }),
    ]);
    const props = await listProps();
    expect(props.unlocked).toEqual({
      [W1]: { kind: "granted", unlockId: unlock(W1).unlockId, expiresAt: FUTURE },
    });
  });

  it("a failed history read starts every row locked — never an error state", async () => {
    getUnlocks.mockRejectedValueOnce(new Error("503"));
    const out = await html();
    expect(unlockButtons(out)).toHaveLength(2);
    expect(out).not.toContain("Open routed contact");
    expect(out).not.toContain("couldn’t load");
  });
});

describe("candidates page — the posting filter reaches the server; a non-id never does", () => {
  it("no filter → the inbox is read with no postingId", async () => {
    await html();
    expect(getCandidateInbox).toHaveBeenCalledWith({});
  });

  it("?postingId=<id> → read for that posting, and the option is selected", async () => {
    const out = await html({ postingId: P2 });
    expect(getCandidateInbox).toHaveBeenCalledWith({ postingId: P2 });
    expect(out).toContain(`<option value="${P2}" selected="">VMC Operator (paused)</option>`);
  });

  it("the form's empty 'All postings' (?postingId=) is no filter", async () => {
    await html({ postingId: "" });
    expect(getCandidateInbox).toHaveBeenCalledWith({});
  });

  it("an UPPERCASE id is the same posting: read lowercased, its own option selected — no duplicate", async () => {
    // An id WITH hex letters — an all-digit one reads the same in either case and proves nothing.
    const PX = "abcdef12-0000-4000-8000-0000000000ab";
    getPostings.mockResolvedValueOnce([...POSTINGS, { ...POSTINGS[0]!, id: PX, roleTitle: "Welder" }]);
    getCandidateInbox.mockResolvedValueOnce({ applicants: [companyRow(W1, PX, "Welder")], nextCursor: NEXT });
    const upper = PX.toUpperCase();
    expect(upper).not.toBe(PX);
    const out = await html({ postingId: upper });
    expect(getCandidateInbox).toHaveBeenCalledWith({ postingId: PX });
    expect(out).toContain(`<option value="${PX}" selected="">Welder</option>`);
    expect(out.match(/<option /g)).toHaveLength(4); // All postings + the three owned — nothing added
    expect(out).not.toContain(upper);
    expect(out).not.toContain("Selected posting");
    // The pager keeps the posting in the form every other link carries.
    expect(out).toContain(`href="/candidates?postingId=${PX}&amp;cursor=${NEXT}"`);
  });

  it("?postingId=<not an id> → NO read, the filtered-empty state, the value shown as selected", async () => {
    const out = await html({ postingId: "garbage" });
    expect(getCandidateInbox).not.toHaveBeenCalled();
    expect(out).toContain("No applicants for this posting");
    expect(out).toContain('<option value="garbage" selected="">Selected posting</option>');
  });
});

describe("candidates page — keyset paging", () => {
  it("nextCursor → a Next page link carrying it verbatim AND the posting filter", async () => {
    getCandidateInbox.mockResolvedValueOnce({ applicants: [companyRow(W1)], nextCursor: NEXT });
    const out = await html({ postingId: P1 });
    expect(out).toContain('<nav class="candidates-pager" aria-label="Candidate pages">');
    expect(out).toContain(`href="/candidates?postingId=${P1}&amp;cursor=${NEXT}"`);
    expect(textOf(out)).toContain("Next page");
    // The newest page offers no way "back" to itself.
    expect(textOf(out)).not.toContain("First page");
  });

  it("?cursor= reaches the seam with the filter; the page offers First page (filter kept)", async () => {
    const out = await html({ postingId: P1, cursor: NEXT });
    expect(getCandidateInbox).toHaveBeenCalledWith({ postingId: P1, cursor: NEXT });
    expect(out).toContain(`<a href="/candidates?postingId=${P1}" class="bb-btn bb-btn--secondary">`);
    expect(textOf(out)).toContain("First page");
    expect(textOf(out)).not.toContain("Next page"); // nextCursor null: the last page
  });

  it("a cursor the server could not have minted is dropped — the newest page is read", async () => {
    await html({ cursor: "not a cursor!" });
    expect(getCandidateInbox).toHaveBeenCalledWith({});
  });

  it("one page and no cursor: no pager at all", async () => {
    expect(await html()).not.toContain("candidates-pager");
  });

  it("a later page with nothing left says so, and still offers First page", async () => {
    getCandidateInbox.mockResolvedValueOnce({ applicants: [], nextCursor: null });
    const out = await html({ cursor: NEXT });
    expect(out).toContain("No more applicants");
    expect(out).toContain('<a href="/candidates" class="bb-btn bb-btn--secondary">');
  });
});

describe("candidates page — the navigation pending cue on every link (#2115 and its follow-up)", () => {
  it("Next page and First page (the pager) carry it", async () => {
    getCandidateInbox.mockResolvedValueOnce({ applicants: [companyRow(W1)], nextCursor: NEXT });
    const cues = linkCue(await html({ postingId: P1, cursor: NEXT }));
    expect(cues.get(`/candidates?postingId=${P1}&cursor=${NEXT}`)).toBe(true);
    expect(cues.get(`/candidates?postingId=${P1}`)).toBe(true);
  });

  it("each card's Applied to link carries it", async () => {
    const cues = linkCue(await html());
    expect(cues.get(`/postings/${P1}`)).toBe(true);
    expect(cues.get(`/postings/${P2}`)).toBe(true);
  });

  it("the states' First page (outage on a later page, refused cursor) and All postings carry it", async () => {
    getCandidateInbox.mockRejectedValueOnce(new Error("payer API /payer/reach/applicants returned 502"));
    expect(linkCue(stateOf(await html({ postingId: P1, cursor: NEXT }))).get(`/candidates?postingId=${P1}`)).toBe(true);
    getCandidateInbox.mockRejectedValueOnce(new Error("payer API /payer/reach/applicants returned 400"));
    expect(linkCue(stateOf(await html({ postingId: P1, cursor: "abc" }))).get(`/candidates?postingId=${P1}`)).toBe(true);
    getCandidateInbox.mockResolvedValueOnce({ applicants: [], nextCursor: null });
    expect(linkCue(stateOf(await html({ postingId: P1 }))).get("/candidates")).toBe(true);
  });

  it("so do the empty states' Postings and New posting — every in-app link is a PortalLink", async () => {
    getCandidateInbox.mockResolvedValueOnce({ applicants: [], nextCursor: null });
    expect(linkCue(stateOf(await html())).get("/postings")).toBe(true);
    getCandidateInbox.mockResolvedValueOnce({ applicants: [], nextCursor: null });
    getPostings.mockResolvedValueOnce([]);
    expect(linkCue(stateOf(await html())).get("/postings/new")).toBe(true);
  });

  it("no link on a full page goes without it — and the scan sees one that does (it is not vacuous)", async () => {
    getCandidateInbox.mockResolvedValueOnce({ applicants: [companyRow(W1)], nextCursor: NEXT });
    const page = linkCue(await html({ postingId: P1, cursor: NEXT }));
    expect(page.size).toBeGreaterThan(2);
    expect([...page].filter(([, cued]) => !cued)).toEqual([]);
    expect(linkCue('<a href="/postings">Postings</a>').get("/postings")).toBe(false);
  });
});

describe("candidates page — states (the head and filter never blank)", () => {
  const headKept = (out: string) => {
    expect(out).toContain('<h1 class="page-head__title">Candidates</h1>');
    expect(out).toContain('action="/candidates"');
  };

  it("EMPTY (no filter): a calm state that leads to the persona's Postings", async () => {
    getCandidateInbox.mockResolvedValueOnce({ applicants: [], nextCursor: null });
    const company = await html();
    headKept(company);
    expect(company).toContain("No applicants yet");
    expect(Array.from(stateOf(company).matchAll(/<a href="([^"]*)"/g), (m) => m[1])).toEqual(["/postings"]);
    requirePayer.mockResolvedValueOnce(AGENCY);
    getCandidateInbox.mockResolvedValueOnce({ applicants: [], nextCursor: null });
    const agency = await html();
    expect(Array.from(stateOf(agency).matchAll(/<a href="([^"]*)"/g), (m) => m[1])).toEqual(["/agency/jobs"]);
  });

  it("EMPTY with no postings at all: the way forward is New posting", async () => {
    getCandidateInbox.mockResolvedValueOnce({ applicants: [], nextCursor: null });
    getPostings.mockResolvedValueOnce([]);
    const out = await html();
    expect(Array.from(stateOf(out).matchAll(/<a href="([^"]*)"/g), (m) => m[1])).toEqual(["/postings/new"]);
    expect(textOf(stateOf(out))).toContain("New posting");
  });

  it("FILTERED-EMPTY: one union copy, a way back to all postings, no spend chrome", async () => {
    getCandidateInbox.mockResolvedValueOnce({ applicants: [], nextCursor: null });
    const out = await html({ postingId: P1 });
    headKept(out);
    expect(out).toContain("No applicants for this posting");
    expect(textOf(out)).toContain("or it isn’t one of your postings");
    expect(Array.from(stateOf(out).matchAll(/<a href="([^"]*)"/g), (m) => m[1])).toEqual(["/candidates"]);
    expect(out).not.toContain("Applicants are faceless");
    expect(out).not.toContain("No applicants yet");
  });

  it("an UNKNOWN or another payer's id renders the SAME state as an owned posting with none", async () => {
    const OTHER = "99999999-0000-4000-8000-000000000009";
    getCandidateInbox.mockResolvedValueOnce({ applicants: [], nextCursor: null });
    const owned = stateOf(await html({ postingId: P1 }));
    getCandidateInbox.mockResolvedValueOnce({ applicants: [], nextCursor: null });
    const foreign = stateOf(await html({ postingId: OTHER }));
    const malformed = stateOf(await html({ postingId: "garbage" }));
    expect(foreign).toBe(owned);
    expect(malformed).toBe(owned);
  });

  it("ERROR: an in-place card with Retry under the kept head — never the empty copy", async () => {
    getCandidateInbox.mockRejectedValueOnce(new Error("payer API /payer/reach/applicants returned 502"));
    const out = await html();
    headKept(out);
    expect(out).toContain('<div class="state state--error">');
    expect(out).toContain("We couldn’t load candidates");
    expect(out).toContain('data-retry="">Retry</button>');
    expect(out).not.toContain("No applicants yet");
    expect(out).not.toContain("Too many requests");
    expect(out).not.toContain("candidates-pager");
  });

  it("ERROR (an outage) on a later page offers Retry AND the newest page (a stale link is not a dead end)", async () => {
    getCandidateInbox.mockRejectedValueOnce(new Error("payer API /payer/reach/applicants returned 502"));
    const out = await html({ postingId: P1, cursor: NEXT });
    expect(stateOf(out)).toContain("We couldn’t load candidates");
    expect(stateOf(out)).toContain('data-retry="">Retry</button>');
    expect(stateOf(out)).toContain(`<a href="/candidates?postingId=${P1}" class="bb-btn bb-btn--secondary">`);
  });

  it("a REFUSED page cursor (400 — hand-edited) is not an outage: First page, filter kept, NO Retry", async () => {
    const refusals = [
      new PayerValidationError("/payer/reach/applicants", [{ path: "cursor", message: "cursor is malformed" }]),
      new Error("payer API /payer/reach/applicants returned 400"),
    ];
    for (const refusal of refusals) {
      getCandidateInbox.mockRejectedValueOnce(refusal);
      // `abc` has the cursor's shape, so it is sent — only the server can say it never minted it.
      const out = await html({ postingId: P1, cursor: "abc" });
      expect(getCandidateInbox).toHaveBeenLastCalledWith({ postingId: P1, cursor: "abc" });
      headKept(out);
      const state = stateOf(out);
      expect(state.startsWith('<div class="state">')).toBe(true); // calm, not state--error
      expect(textOf(state)).toContain("This page link isn’t valid");
      // Repeating a refused request cannot succeed: no Retry anywhere, and not the outage copy.
      expect(out).not.toContain("data-retry");
      expect(out).not.toContain("couldn’t load");
      expect(textOf(out)).not.toMatch(/temporary|retry/i);
      // The one way out: the first page of the SAME posting filter — once on the screen.
      expect(Array.from(state.matchAll(/<a href="([^"]*)"/g), (m) => m[1])).toEqual([
        `/candidates?postingId=${P1}`,
      ]);
      expect(textOf(out).match(/First page/g)).toHaveLength(1);
      expect(out).not.toContain("candidates-pager");
    }
  });

  it("…with no filter, its First page is the bare route", async () => {
    getCandidateInbox.mockRejectedValueOnce(new Error("payer API /payer/reach/applicants returned 400"));
    const state = stateOf(await html({ cursor: "abc" }));
    expect(Array.from(state.matchAll(/<a href="([^"]*)"/g), (m) => m[1])).toEqual(["/candidates"]);
    expect(state).not.toContain("data-retry");
  });

  it("a 400 with NO cursor is an outage: nothing in the address to refuse, so Retry — no First page", async () => {
    getCandidateInbox.mockRejectedValueOnce(new Error("payer API /payer/reach/applicants returned 400"));
    const out = await html({ postingId: P1 });
    const state = stateOf(out);
    expect(state).toContain('<div class="state state--error">');
    expect(textOf(state)).toContain("We couldn’t load candidates");
    expect(state).toContain('data-retry="">Retry</button>');
    expect(textOf(out)).not.toContain("First page");
    expect(textOf(out)).not.toContain("This page link");
  });

  it("429: a neutral 'too many requests' — not the failure copy, no cause, a way to try again", async () => {
    getCandidateInbox.mockRejectedValueOnce(new Error("payer API /payer/reach/applicants returned 429"));
    const out = await html();
    headKept(out);
    const state = stateOf(out);
    expect(state.startsWith('<div class="state">')).toBe(true); // neutral, not state--error
    expect(textOf(state)).toContain("Too many requests");
    expect(textOf(state)).toContain("Try again shortly.");
    expect(state).toContain('data-retry="">Try again</button>');
    expect(out).not.toContain("couldn’t load");
    expect(textOf(state)).not.toMatch(/limit|hour|\d/);
  });
});

describe("candidates page — the filter shows the posting the list is filtered by", () => {
  /** The key React reconciles the filter by, found wherever the page passes it (a header prop). */
  const filterKey = (node: unknown, seen = new Set<unknown>()): string | null | undefined => {
    if (node === null || typeof node !== "object" || seen.has(node)) return undefined;
    seen.add(node);
    if (isValidElement(node)) {
      if (node.type === CandidateFilter) return node.key;
      return filterKey(node.props, seen);
    }
    for (const v of Object.values(node)) {
      const k = filterKey(v, seen);
      if (k !== undefined) return k;
    }
    return undefined;
  };

  it("a new selection remounts the filter: a kept <select> never applies a changed defaultValue", async () => {
    // Filtered-empty -> "All postings" -> empty: Next keeps the page mounted across a query-only
    // navigation and both states render the same head, so without a key the select would keep
    // showing the old posting above the unfiltered list.
    const empty = { applicants: [], nextCursor: null };
    getCandidateInbox.mockResolvedValueOnce(empty);
    const onP1 = filterKey(await tree({ postingId: P1 }));
    getCandidateInbox.mockResolvedValueOnce(empty);
    const onAll = filterKey(await tree());
    getCandidateInbox.mockResolvedValueOnce(empty);
    const onP2 = filterKey(await tree({ postingId: P2 }));
    expect(onP1).not.toBeUndefined();
    expect(new Set([onP1, onAll, onP2]).size).toBe(3);
    // The same selection keeps the same key (paging within a filter is not a new selection).
    getCandidateInbox.mockResolvedValueOnce(empty);
    expect(filterKey(await tree({ postingId: P1.toUpperCase() }))).toBe(onP1);
  });
});

describe("candidates page — SAVED stages (#2139): the Stage filter, and each card's stage", () => {
  type Stage = "new" | "shortlist" | "passed";
  const staged = (row: CandidateInboxRow, stage: Stage): CandidateInboxRow => ({ ...row, stage });
  const STAGED = {
    applicants: [staged(companyRow(W1), "new"), staged(companyRow(W2, P2, "VMC Operator"), "shortlist")],
    nextCursor: null,
  };
  /** The Stage select's markup (its options), or null when the page draws none. */
  const stageSelect = (markup: string) =>
    /<select id="candidates-stage" class="[^"]*" name="stage"[^>]*>([\s\S]*?)<\/select>/.exec(markup)?.[1] ?? null;
  const selectedStage = (markup: string) =>
    /<option value="([^"]*)" selected="">/.exec(stageSelect(markup) ?? "")?.[1] ?? null;
  const filterKey = (node: unknown, seen = new Set<unknown>()): string | null | undefined => {
    if (node === null || typeof node !== "object" || seen.has(node)) return undefined;
    seen.add(node);
    if (isValidElement(node)) {
      if (node.type === CandidateFilter) return node.key;
      return filterKey(node.props, seen);
    }
    for (const v of Object.values(node)) {
      const k = filterKey(v, seen);
      if (k !== undefined) return k;
    }
    return undefined;
  };

  it("FLAG OFF (no row carries a stage): no Stage select and no stage on a card — the page as before", async () => {
    const out = await html();
    expect(stageSelect(out)).toBeNull();
    expect(out).not.toContain('name="stage"');
    expect(out).toContain('aria-label="Filter candidates by posting"');
    expect(textOf(out)).not.toMatch(/Shortlisted|Move to New|\bKeep\b/);
  });

  it("FLAG ON: the filter gains a labelled Stage select — All stages, then New / Shortlist / Passed", async () => {
    getCandidateInbox.mockResolvedValueOnce(STAGED);
    const out = await html();
    expect(out).toContain('<label class="bb-field__label" for="candidates-stage">Stage</label>');
    const options = Array.from(
      (stageSelect(out) ?? "").matchAll(/<option value="([^"]*)"[^>]*>([^<]*)</g),
      (m) => [m[1], m[2]],
    );
    expect(options).toEqual([
      ["", "All stages"],
      ["new", "New"],
      ["shortlist", "Shortlist"],
      ["passed", "Passed"],
    ]);
    expect(selectedStage(out)).toBe("");
    // Still ONE plain GET form, with no cursor in it (a new stage starts from the first page).
    const toolbar = out.slice(out.indexOf('<div class="page-head__toolbar">'));
    expect(toolbar.match(/<form /g)).toHaveLength(1);
    expect(toolbar).not.toContain('name="cursor"');
    expect(out).toContain('aria-label="Filter candidates"');
  });

  it("FLAG ON: each card shows its stage and offers its moves (still no stage tabs)", async () => {
    getCandidateInbox.mockResolvedValueOnce(STAGED);
    const out = await html();
    const text = textOf(out);
    expect(text).toMatch(/\bNew\b[\s\S]*Keep[\s\S]*Pass/);
    expect(text).toContain("Shortlisted");
    expect(text).toContain("Move to New");
    expect(out).not.toContain("applicants-pipeline");
  });

  it("?stage= reaches the seam beside postingId; it is selected, and paging keeps it", async () => {
    getCandidateInbox.mockResolvedValueOnce({
      applicants: [staged(companyRow(W1), "shortlist")],
      nextCursor: NEXT,
    });
    const out = await html({ postingId: P1, stage: "shortlist" });
    expect(getCandidateInbox).toHaveBeenCalledTimes(1);
    expect(getCandidateInbox).toHaveBeenCalledWith({ postingId: P1, stage: "shortlist" });
    expect(selectedStage(out)).toBe("shortlist");
    expect(out).toContain(`href="/candidates?postingId=${P1}&amp;stage=shortlist&amp;cursor=${NEXT}"`);

    getCandidateInbox.mockResolvedValueOnce({
      applicants: [staged(companyRow(W2), "shortlist")],
      nextCursor: null,
    });
    const page2 = await html({ stage: "shortlist", cursor: NEXT });
    expect(getCandidateInbox).toHaveBeenLastCalledWith({ cursor: NEXT, stage: "shortlist" });
    expect(page2).toContain('<a href="/candidates?stage=shortlist" class="bb-btn bb-btn--secondary">');
  });

  it("a stage the API REFUSES (a 400 — the flag is off) is read again WITHOUT it: the unfiltered list, no Stage select", async () => {
    const refusals = [
      new PayerValidationError("/payer/reach/applicants?stage=passed", [
        { path: "", message: "Unrecognized key(s) in object: 'stage'" },
      ]),
      new Error("payer API /payer/reach/applicants?stage=passed returned 400"),
    ];
    for (const refusal of refusals) {
      getCandidateInbox.mockReset();
      getCandidateInbox
        .mockRejectedValueOnce(refusal)
        .mockResolvedValueOnce({ applicants: [companyRow(W1)], nextCursor: NEXT });
      const out = await html({ postingId: P1, stage: "passed" });
      expect(getCandidateInbox.mock.calls.map((c) => c[0])).toEqual([
        { postingId: P1, stage: "passed" },
        { postingId: P1 },
      ]);
      expect(stageSelect(out)).toBeNull();
      expect(out).not.toContain("couldn’t load");
      expect(textOf(out)).toContain("Applied to");
      // The pager no longer carries the refused stage.
      expect(out).toContain(`href="/candidates?postingId=${P1}&amp;cursor=${NEXT}"`);
    }
  });

  it("a refused stage AND a refused cursor is the cursor's refusal — First page (stage kept, to re-ask), never Retry", async () => {
    getCandidateInbox
      .mockRejectedValueOnce(new Error("payer API /payer/reach/applicants returned 400"))
      .mockRejectedValueOnce(new Error("payer API /payer/reach/applicants returned 400"));
    const out = await html({ stage: "passed", cursor: "abc" });
    expect(textOf(stateOf(out))).toContain("This page link isn’t valid");
    expect(Array.from(stateOf(out).matchAll(/<a href="([^"]*)"/g), (m) => m[1])).toEqual([
      "/candidates?stage=passed",
    ]);
    expect(out).not.toContain("data-retry");
  });

  it("any OTHER failure on a stage read is the page's own state — no second read", async () => {
    getCandidateInbox.mockRejectedValueOnce(new Error("payer API /payer/reach/applicants returned 502"));
    expect(stateOf(await html({ stage: "new" }))).toContain("We couldn’t load candidates");
    expect(getCandidateInbox).toHaveBeenCalledTimes(1);
    getCandidateInbox.mockRejectedValueOnce(new Error("payer API /payer/reach/applicants returned 429"));
    expect(textOf(stateOf(await html({ stage: "new" })))).toContain("Too many requests");
    expect(getCandidateInbox).toHaveBeenCalledTimes(2);
  });

  it("a stage filter that matches nothing: its own state, a way to All stages (posting kept), the select kept", async () => {
    getCandidateInbox.mockResolvedValueOnce({ applicants: [], nextCursor: null });
    const out = await html({ postingId: P1, stage: "passed" });
    const state = stateOf(out);
    expect(textOf(state)).toContain("No applicants in Passed");
    expect(textOf(state)).not.toContain("one of your postings");
    expect(linkCue(state)).toEqual(new Map([[`/candidates?postingId=${P1}`, true]]));
    expect(textOf(state)).toContain("All stages");
    expect(selectedStage(out)).toBe("passed");
  });

  it("an empty UNFILTERED page cannot say stages are saved: no Stage select", async () => {
    getCandidateInbox.mockResolvedValueOnce({ applicants: [], nextCursor: null });
    expect(stageSelect(await html())).toBeNull();
  });

  it("a value that is not a stage is no stage filter — never sent to the API", async () => {
    getCandidateInbox.mockResolvedValueOnce(STAGED);
    await html({ stage: "archived" });
    expect(getCandidateInbox).toHaveBeenCalledWith({});
  });

  it("a new stage remounts the filter and starts a fresh card list (no session state carried over)", async () => {
    getCandidateInbox.mockResolvedValueOnce({ applicants: [staged(companyRow(W1), "new")], nextCursor: null });
    const a = await tree({ stage: "new" });
    getCandidateInbox.mockResolvedValueOnce({ applicants: [staged(companyRow(W1), "passed")], nextCursor: null });
    const b = await tree({ stage: "passed" });
    expect(filterKey(a)).not.toBe(filterKey(b));
    expect(listKey(a)).not.toBe(listKey(b));
  });

  /** The key React reconciles the ONE card list by (its session state lives as long as the key). */
  const listKey = (t: ReactElement) =>
    ((t.props as { children: ReactElement[] }).children.find((c) => c?.type === ApplicantActions) as ReactElement)
      .key;
  const refusedThenRead = (rows: CandidateInboxRow[]) =>
    getCandidateInbox
      .mockRejectedValueOnce(new Error("payer API /payer/reach/applicants returned 400"))
      .mockResolvedValueOnce({ applicants: rows, nextCursor: null });

  it("a REFUSED stage keeps the same card list as the address it was asked from (review #2162 Low 1)", async () => {
    // A failed move's `gone` re-reads this page; if stages stopped being saved meanwhile, the read
    // of ?stage=passed is refused and re-read without it. The list must NOT remount — that would
    // drop the move's toast — so it is keyed by the stage the ADDRESS asked for.
    getCandidateInbox.mockResolvedValueOnce({ applicants: [staged(companyRow(W1), "passed")], nextCursor: null });
    const applied = await tree({ stage: "passed" });
    refusedThenRead([companyRow(W1)]);
    const refused = await tree({ stage: "passed" });
    expect(listKey(refused)).toBe(listKey(applied));
  });

  it("a REFUSED stage says so, calmly, beside the filter — and only then", async () => {
    const NOTE = "The stage filter isn\u2019t available right now, so every stage is shown.";
    refusedThenRead([companyRow(W1)]);
    const refused = await html({ stage: "passed" });
    expect(textOf(refused)).toContain(NOTE);
    expect(refused).toContain('<p class="candidates-filter__note" id="candidates-stage-note">');
    expect(refused).not.toContain("data-retry"); // not an outage: nothing to retry
    // Applied, or never asked: no note.
    getCandidateInbox.mockResolvedValueOnce({ applicants: [staged(companyRow(W1), "passed")], nextCursor: null });
    expect(textOf(await html({ stage: "passed" }))).not.toContain(NOTE);
    expect(textOf(await html())).not.toContain(NOTE);
    // A refused stage on an empty answer says it too (the empty state is about every stage).
    refusedThenRead([]);
    expect(textOf(await html({ stage: "passed" }))).toContain(NOTE);
  });
});
