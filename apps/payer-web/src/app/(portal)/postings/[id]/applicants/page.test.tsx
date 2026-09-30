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
 *  - BALANCE IS AN AFFORDANCE: a failed balance read drops the chip but leaves Unlock ENABLED
 *    (only a real 0 disables it) — the no-oracle server makes the spend decision.
 *  - NEUTRAL NOT-FOUND: a null feed (backend 404 for unknown AND not-owned) renders one union
 *    copy with no feed chrome; a failed read is a distinct, retryable error.
 *  - The `.applicants-page` wrapper exists (the screen's touch-target rules are scoped to it).
 * The seams, the server actions and next/link are mocked; nothing here reaches the network.
 */

const getApplicantFeed = vi.fn<(id: string) => Promise<ApplicantFeed | null>>();
const getDashboard = vi.fn();
vi.mock("../../../../../lib/payer-api", () => ({
  getApplicantFeed: (id: string) => getApplicantFeed(id),
  getDashboard: () => getDashboard(),
}));
vi.mock("./actions", () => ({
  unlockAction: vi.fn(),
  revealContactAction: vi.fn(),
  maskedResumeAction: vi.fn(),
}));
vi.mock("next/link", async () => {
  const React = await vi.importActual<typeof ReactModule>("react");
  return {
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
const FEED: ApplicantFeed = { postingId: POSTING, roleTitle: "CNC Turner", applicants: [A, B] };

async function html(): Promise<string> {
  const tree = (await ApplicantsPage({ params: Promise.resolve({ id: POSTING }) })) as ReactElement;
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
  getDashboard.mockReset().mockResolvedValue({ credits: { balance: 5 } });
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
    // The explainer alert NAMES what is withheld ("No name, phone, or employer is shown"); the
    // candidate list itself must not carry those words at all.
    const list = textOf(out.slice(out.indexOf('class="applicants-list"')));
    expect(list.length).toBeGreaterThan(0);
    expect(list).not.toMatch(/\bname\b|phone|\bemail\b|employer/i);
  });
});

describe("applicants page — the balance is an AFFORDANCE, never a gate", () => {
  it("a failed balance read drops the chip but leaves every Unlock ENABLED", async () => {
    getDashboard.mockRejectedValueOnce(new Error("dashboard 503"));
    const out = await html();
    expect(out).not.toContain("Balance:");
    const tags = unlockButtonTags(out);
    expect(tags).toHaveLength(FEED.applicants.length);
    for (const t of tags) expect(t).not.toMatch(/\bdisabled\b/);
  });

  it("only a real zero balance disables Unlock (and shows the own-balance top-up alert)", async () => {
    getDashboard.mockResolvedValueOnce({ credits: { balance: 0 } });
    const out = await html();
    const tags = unlockButtonTags(out);
    expect(tags).toHaveLength(FEED.applicants.length);
    for (const t of tags) expect(t).toMatch(/\bdisabled\b/);
    expect(out).toContain("not a signal about any candidate");
  });

  it("a loaded balance renders the chip beside the role title", async () => {
    const out = await html();
    expect(textOf(out)).toMatch(/Balance:\s+5/);
  });

  it("W3-A: only a REAL zero adds a Top up button beside each disabled Unlock", async () => {
    getDashboard.mockResolvedValueOnce({ credits: { balance: 0 } });
    const zero = await html();
    const rows = zero.split('class="applicant__unlock-actions"').slice(1);
    expect(rows).toHaveLength(FEED.applicants.length);
    for (const row of rows) {
      const actions = row.slice(0, row.indexOf("</div>"));
      expect(actions).toMatch(/<button[^>]*\bdisabled\b[^>]*>[\s\S]*Unlock contact \(1 credit\)/);
      expect(actions).toContain('<a href="/credits" class="bb-btn bb-btn--secondary">');
      expect(textOf(actions)).toMatch(/\bTop up\b/);
    }
  });

  it("W3-A: a failed balance read (Unlock enabled) and a positive one show NO Top up button", async () => {
    getDashboard.mockRejectedValueOnce(new Error("dashboard 503"));
    expect(await html()).not.toContain('class="bb-btn bb-btn--secondary">');
    expect(await html()).not.toContain('<a href="/credits" class="bb-btn');
  });
});

describe("applicants page — W3-A section head", () => {
  it("groups the role title + count in `.section__text`; the balance chip follows on the title row", async () => {
    const out = await html();
    const head = out.slice(out.indexOf('<div class="section__head">'));
    expect(head).toMatch(
      /^<div class="section__head"><div class="section__text"><h2 class="section__title">CNC Turner<\/h2><p class="section__sub">[^<]*<\/p><\/div><div class="section__actions">/,
    );
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
  });

  it("a failed feed read is a retryable error, never the not-found copy", async () => {
    getApplicantFeed.mockRejectedValueOnce(new Error("upstream 502"));
    const out = await html();
    expect(out).toContain("We couldn’t load applicants");
    expect(out).toContain("Retry");
    expect(out).not.toContain("No posting found here");
  });
});

describe("applicants page — W2-B layout namespace", () => {
  it("wraps the screen in `.applicants-page` (the touch-target rules are scoped to it)", async () => {
    expect(await html()).toMatch(/^<div class="applicants-page">/);
  });
});
