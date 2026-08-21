import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * LEGACY PROFILE ROUTE (BL-6 / DU-1) — now a server redirect to the single canonical /account.
 * Both pages used to render the identical identity panel + AccountForm + agent-only KYC/bank
 * section; that render behaviour is already proven on the destination's own
 * ../account/page.test.tsx and ../account/account-form.test.tsx — this route keeps ONLY a
 * redirect so old links/bookmarks still resolve. It must:
 *  - call next/navigation `redirect("/account")`, and
 *  - read/render NO session or account data of its own (no `requirePayer()` call here — the
 *    gate lives on the portal layout and is re-asserted independently on the destination).
 */

const redirect = vi.fn((url: string) => {
  // next's real redirect throws a control-flow signal; mimic it so callers can't continue.
  throw new Error(`NEXT_REDIRECT:${url}`);
});
vi.mock("next/navigation", () => ({ redirect: (url: string) => redirect(url) }));

const { default: ProfileRedirect } = await import("./page");

beforeEach(() => {
  redirect.mockClear();
});

describe("legacy /profile — redirects to the canonical /account", () => {
  it("calls redirect('/account') (old links + hrefs still resolve)", () => {
    expect(() => ProfileRedirect()).toThrow("NEXT_REDIRECT:/account");
    expect(redirect).toHaveBeenCalledTimes(1);
    expect(redirect).toHaveBeenCalledWith("/account");
  });
});
