import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { PageHeaderContent } from "./page-header";
import type { JobPostingListItem, PayerDetail } from "../lib/entities";
import type { AdminCapability } from "../lib/auth/capabilities";

/**
 * One payer account, under the three name postures.
 *
 * The interesting thing on this page is that it now carries TWO self-declared names that can
 * disagree: `org_name`, the organisation the account REGISTERED as, and the `org_label` strings
 * it PUBLISHES under on its job postings. They are rendered as separate claims on purpose — an
 * account registered as one entity and posting as another is the shape of the spam an operator
 * opens this screen to act on, and merging them would erase exactly that signal.
 */

// Both interactive children are Client Components using `useRouter`/`useState`. The header is
// stubbed to render the shared PageHeader from the server-built `header` it is handed (back
// link, title, description), which is what this file asserts on.
const seen = vi.hoisted(() => ({ timelineHref: undefined as string | null | undefined }));
vi.mock("./payer-detail-header", async () => {
  const { PageHeader } = await import("./page-header");
  return {
    PayerDetailHeader: ({
      header,
      timelineHref,
    }: {
      header: PageHeaderContent;
      timelineHref: string | null;
    }) => {
      seen.timelineHref = timelineHref;
      return <PageHeader {...header} />;
    },
  };
});
vi.mock("./payer-credits-panel", () => ({ PayerCreditsPanel: () => null }));

const { PayerDetailView } = await import("./payer-detail");

const PAYER_ID = "6155050c-c91b-4c6e-96a7-8da023f1d2d2";

const FACELESS: PayerDetail = {
  id: PAYER_ID,
  role: "employer",
  status: "active",
  previous_status: null,
  created_at: "2026-08-19T09:00:00.000Z",
  updated_at: "2026-08-19T09:00:00.000Z",
  credit_balance: 25,
  posting_count: 2,
  open_posting_count: 1,
  unlock_count: 3,
};

const POSTING: JobPostingListItem = {
  id: "bc765f2b-902f-4cba-81c2-6abab75e4bf5",
  payer_id: PAYER_ID,
  org_label: "Acme Works Pune",
  role_title: "CNC Operator",
  location_label: "Pune",
  city: null,
  status: "open",
  verification_status: "unverified",
  vacancy_band: "2-5",
  pay_min: null,
  pay_max: null,
  published_at: null,
  closed_at: null,
  created_at: "2026-08-19T09:00:00.000Z",
};

const render = (
  payer: PayerDetail,
  capabilities: AdminCapability[],
  postings: JobPostingListItem[] | null = [POSTING],
) =>
  renderToStaticMarkup(
    <PayerDetailView
      payer={payer}
      postings={postings}
      kind="Company"
      backHref="/companies"
      capabilities={capabilities}
    />,
  );

const ENTITLED: AdminCapability[] = ["read_entities", "read_identity"];
const ANALYST: AdminCapability[] = ["read_entities"];

describe("when the registered name was disclosed", () => {
  const NAMED: PayerDetail = { ...FACELESS, org_name: "Acme Fabrication Pvt Ltd" };

  it("headlines the registered name, out of the monospace id face", () => {
    const out = render(NAMED, ENTITLED);
    expect(out).toContain('<h1 class="page__title">Acme Fabrication Pvt Ltd</h1>');
  });

  it("keeps the PUBLISHED labels as a separate claim, still flagged unverified", () => {
    // The two names are different facts. This is the case where they disagree — registered as
    // "Acme Fabrication Pvt Ltd", publishing as "Acme Works Pune".
    const out = render(NAMED, ENTITLED);
    expect(out).toContain("Acme Works Pune");
    expect(out).toContain("not a verified name");
  });

  it("drops the `not who registered it` clause, which is no longer true", () => {
    const out = render(NAMED, ENTITLED);
    expect(out).not.toContain("not who registered it");
  });

  it("adds a Registered name row, and keeps the id row beside it", () => {
    const out = render(NAMED, ENTITLED);
    expect(out).toContain("Registered name");
    expect(out).toContain(`<span class="mono">${PAYER_ID}</span>`);
  });

  it("no longer claims the organisation name is unserved", () => {
    // The copy that is about to be false if left alone.
    const out = render(NAMED, ENTITLED);
    expect(out).not.toContain("registered organisation name are encrypted at rest");
    expect(out).toContain("decrypted for this response only");
  });

  it("still says email and phone reach NO role", () => {
    // The half of the payer contract nothing reversed.
    const out = render(NAMED, ENTITLED);
    expect(out).toContain("Email and phone are encrypted at rest and are served to no role");
  });
});

describe("when the account never recorded one", () => {
  const UNNAMED: PayerDetail = { ...FACELESS, org_name: null };

  it("falls back to the short id heading rather than an empty line", () => {
    const out = render(UNNAMED, ENTITLED);
    expect(out).toContain('<h1 class="page__title mono">6155050c…</h1>');
  });

  it("keeps the `not who registered it` clause, which IS true here", () => {
    const out = render(UNNAMED, ENTITLED);
    expect(out).toContain("not who registered it");
  });

  it("dashes the Registered name row — disclosed, and UNREADABLE rather than unrecorded", () => {
    // `payers.org_name_enc` is `NOT NULL`, so a null org_name on this surface can only be a
    // failed decrypt (or blank whitespace) — never "nobody recorded one". The worker and admin
    // surfaces keep the "No name on record" copy, because their name columns really are
    // nullable and routinely unset.
    const out = render(UNNAMED, ENTITLED);
    expect(out).toContain('title="No readable name is stored for this account."');
    expect(out).not.toContain("No name on record");
  });

  it("a BLANK registered name behaves exactly as a null one", () => {
    const out = render({ ...FACELESS, org_name: " " }, ENTITLED);
    expect(out).toContain('<h1 class="page__title mono">6155050c…</h1>');
    expect(out).toContain('title="No readable name is stored for this account."');
  });
});

describe("an analyst", () => {
  it("gets the id heading, no Registered name row, and the role-scoped explanation", () => {
    const out = render(FACELESS, ANALYST);
    expect(out).toContain('<h1 class="page__title mono">6155050c…</h1>');
    expect(out).not.toContain("No name on record");
    expect(out).toContain("not served to your role");
    expect(out).not.toContain("Names are withheld on this page");
  });

  it("keeps the posting-label identification path, which is their whole way in", () => {
    const out = render(FACELESS, ANALYST);
    expect(out).toContain("Acme Works Pune");
    expect(out).toContain("publishing as");
  });
});

describe("an entitled admin whose budget is spent", () => {
  it("explains the id heading instead of leaving it as an apparent regression", () => {
    const out = render(FACELESS, ENTITLED);
    expect(out).toContain("Names are withheld on this page");
    expect(out).toContain("hourly name budget");
    expect(out).not.toContain("No name on record");
    expect(out).not.toContain("not served to your role");
  });

  it("does NOT claim a registered name was decrypted, directly under the withheld banner", () => {
    // Same defect as the worker detail page: a two-way branch over a three-valued posture put
    // "The registered name is decrypted for this response only." on a response that decrypted
    // nothing, immediately below the banner saying so.
    const out = render(FACELESS, ENTITLED);
    expect(out).not.toContain("The registered name is decrypted for this response only");
    expect(out).toContain("No registered name was decrypted for this response");
  });
});

describe("the suspended banner is not displaced by an identity banner", () => {
  it("renders both — a suspension is the operational fact on this page", () => {
    const out = render({ ...FACELESS, status: "suspended", previous_status: "active" }, ENTITLED);
    expect(out).toContain("Names are withheld on this page");
    expect(out).toContain("Suspended.");
  });
});

describe("the header (owner ruling 2026-10-01)", () => {
  it("has a back link to its own section, named as that page names itself", () => {
    const out = render(FACELESS, ENTITLED);
    expect(out).toContain('<a class="backlink" href="/companies">');
    expect(out).toContain("<span>Companies</span></a>");
  });
});

/**
 * The record panel names a customer the console's way (owner ruling 2026-10-01; sweep AW-12):
 * "Account" is the payer's own settings page in payer-web, never a label for one here.
 */
describe("the record panel", () => {
  it("is the Customer panel, with the type as Company or Agency", () => {
    const out = render(FACELESS, ENTITLED);
    expect(out).toContain('<h2 class="panel__title" id="p-record">Customer</h2>');
    expect(out).toContain('<dt class="kv__k">Customer type</dt><dd class="kv__v">Company</dd>');
    expect(out).not.toContain(">Account<");
    expect(out).not.toContain("Account type");
  });

  it("reads an agency as Agency", () => {
    const out = render({ ...FACELESS, role: "agent" }, ENTITLED);
    expect(out).toContain('<dt class="kv__k">Customer type</dt><dd class="kv__v">Agency</dd>');
  });
});

describe("the event-timeline link follows read_events (an affordance; the route keeps its gate)", () => {
  it("is offered with read_events, and only then", () => {
    render(FACELESS, ["read_entities", "read_events"]);
    expect(seen.timelineHref).toBe(`/companies/${PAYER_ID}/timeline`);
    render(FACELESS, ["read_entities"]);
    expect(seen.timelineHref).toBeNull();
  });

  it("is not repeated in the no-postings state — the header already carries it", () => {
    const out = render(FACELESS, ["read_entities", "read_events"], []);
    expect(out).toContain("No postings yet");
    expect(out).not.toContain("/timeline");
  });
});

describe("the description when the postings read FAILED (owner brief 2026-10-01)", () => {
  it("says the postings could not be loaded — not that the account has none", () => {
    const out = render(FACELESS, ENTITLED, null);
    const at = out.indexOf('<p class="page__sub">');
    const sub = out.slice(at, out.indexOf("</p>", at));
    expect(sub).toContain("its postings could not be loaded");
    expect(sub).not.toContain("no postings yet");
  });

  it("an account that genuinely has none still says so", () => {
    const out = render(FACELESS, ENTITLED, []);
    expect(out).toContain("with no postings yet");
    expect(out).not.toContain("could not be loaded, so no self-declared label");
  });
});
