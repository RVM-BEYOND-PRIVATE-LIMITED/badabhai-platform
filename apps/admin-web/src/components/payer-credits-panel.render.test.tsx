import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The Grant credits panel names the customer it sits on as a customer: "Account" is the payer's
 * own settings page (owner ruling 2026-10-01), and this panel's suspended state said "This
 * account is suspended".
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
// A Server Action module; a render never calls it.
vi.mock("./payer-actions", () => ({ grantCreditsAction: async () => ({ ok: true }) }));

const { PayerCreditsPanel } = await import("./payer-credits-panel");

const PAYER_ID = "6155050c-c91b-4c6e-96a7-8da023f1d2d2";

describe("PayerCreditsPanel — a suspended customer", () => {
  it("says the CUSTOMER is suspended, and offers no grant form", () => {
    const out = renderToStaticMarkup(
      <PayerCreditsPanel payerId={PAYER_ID} suspended timelineHref={null} />,
    );
    expect(out).toContain("This customer is suspended. Reinstate it before granting credits.");
    expect(out).not.toMatch(/\baccounts?\b/i);
    expect(out).not.toContain("<form");
  });
});
