import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
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
// stubbed to render the server-built `title` it is handed, which is what this file asserts on.
vi.mock("./payer-detail-header", () => ({
  PayerDetailHeader: ({ title }: { title: unknown }) => title,
}));
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

  it("dashes the Registered name row — disclosed, and empty", () => {
    const out = render(UNNAMED, ENTITLED);
    expect(out).toContain('title="No name on record for this account."');
  });

  it("a BLANK registered name behaves exactly as a null one", () => {
    const out = render({ ...FACELESS, org_name: " " }, ENTITLED);
    expect(out).toContain('<h1 class="page__title mono">6155050c…</h1>');
    expect(out).toContain('title="No name on record for this account."');
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
    expect(out).toContain("Publishes as");
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
});

describe("the suspended banner is not displaced by an identity banner", () => {
  it("renders both — a suspension is the operational fact on this page", () => {
    const out = render({ ...FACELESS, status: "suspended", previous_status: "active" }, ENTITLED);
    expect(out).toContain("Names are withheld on this page");
    expect(out).toContain("Suspended.");
  });
});
