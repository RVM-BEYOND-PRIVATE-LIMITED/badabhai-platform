import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import type { PayOnJoiningHireRow } from "../../../lib/pay-on-joining-vocabulary";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("./actions", () => ({
  createPayOnJoiningHireAction: vi.fn(),
  updatePayOnJoiningHireAction: vi.fn(),
}));
// The dialog shell needs a real browser overlay; the form's content is what this test reads.
vi.mock("../../../components/dialog", () => ({
  Dialog: ({ children, footer }: { children: ReactNode; footer?: ReactNode }) => (
    <div>
      {children}
      {footer}
    </div>
  ),
}));

const { PayOnJoiningHireDialog } = await import("./pay-on-joining-hire-form");

const HIRE = "55555555-5555-4555-8555-555555555555";
const FACTORY = "11111111-1111-4111-8111-111111111111";
const WORKER = "33333333-3333-4333-8333-333333333333";
const PARTNER = "22222222-2222-4222-8222-222222222222";

const row: PayOnJoiningHireRow = {
  id: HIRE,
  factory_payer_id: FACTORY,
  job_posting_id: null,
  worker_id: WORKER,
  partner_payer_id: PARTNER,
  joined_on: "2026-11-01",
  stay_checked_on: "2026-12-01",
  stayed_30_days: true,
  fee_paise: 500000,
  partner_share_percent: 70,
  partner_share_paise: 350000,
  invoiced_on: null,
  factory_paid_on: null,
  partner_paid_on: null,
  note: "Pilot call.",
  payment_state: "awaiting_factory",
  created_by_admin_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  updated_by_admin_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  created_at: "2026-11-01T09:00:00.000Z",
  updated_at: "2026-11-01T09:00:00.000Z",
};

describe("the pay-on-joining form", () => {
  it("seeds an edit from the list row, with the fee in rupees", () => {
    const out = renderToStaticMarkup(<PayOnJoiningHireDialog mode="edit" initial={row} />);
    expect(out).toContain('value="5000"');
    expect(out).toContain('value="2026-11-01"');
    expect(out).toContain('value="2026-12-01"');
    expect(out).toContain("Save changes");
  });

  it("never renders the server-owned share or payment state as an input", () => {
    const out = renderToStaticMarkup(<PayOnJoiningHireDialog mode="edit" initial={row} />);
    expect(out).not.toContain("partner_share_paise");
    expect(out).not.toContain("partner_share_percent");
    expect(out).not.toContain("payment_state");
    expect(out).not.toContain("created_by_admin_id");
  });

  it("offers a create trigger and a record action", () => {
    const out = renderToStaticMarkup(<PayOnJoiningHireDialog mode="create" />);
    expect(out).toContain("Record a hire");
    expect(out).toContain("Record hire");
  });
});
