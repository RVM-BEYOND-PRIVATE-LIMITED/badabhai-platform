import { beforeEach, describe, expect, it, vi } from "vitest";

const adminFetch = vi.fn();

vi.mock("./admin-http", () => ({
  adminFetch: (...args: unknown[]) => adminFetch(...args),
}));

const { listPayOnJoiningHires } = await import("./pay-on-joining");

beforeEach(() => {
  adminFetch.mockReset();
  adminFetch.mockResolvedValue({ items: [], nextCursor: null });
});

const FACTORY = "11111111-1111-4111-8111-111111111111";
const PARTNER = "22222222-2222-4222-8222-222222222222";

describe("GET /admin/pay-on-joining-hires", () => {
  it("omits every empty query value", async () => {
    await listPayOnJoiningHires();
    expect(adminFetch).toHaveBeenCalledWith("/admin/pay-on-joining-hires", {
      schema: expect.anything(),
    });
  });

  it("sends the factory, partner, payment state, cursor and limit", async () => {
    await listPayOnJoiningHires({
      factoryPayerId: FACTORY,
      partnerPayerId: PARTNER,
      paid: "partner_due",
      cursor: "c1",
      limit: 50,
    });
    expect(adminFetch).toHaveBeenCalledWith(
      `/admin/pay-on-joining-hires?factory_payer_id=${FACTORY}&partner_payer_id=${PARTNER}&paid=partner_due&cursor=c1&limit=50`,
      { schema: expect.anything() },
    );
  });
});
