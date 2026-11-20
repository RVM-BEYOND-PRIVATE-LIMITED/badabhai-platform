import { beforeEach, describe, expect, it, vi } from "vitest";

const adminFetch = vi.fn();

vi.mock("./admin-http", () => ({
  adminFetch: (...args: unknown[]) => adminFetch(...args),
}));

const { listHires } = await import("./hires");

beforeEach(() => {
  adminFetch.mockReset();
  adminFetch.mockResolvedValue({ items: [], nextCursor: null });
});

describe("GET /admin/hires", () => {
  it("omits every empty query value", async () => {
    await listHires();
    expect(adminFetch).toHaveBeenCalledWith("/admin/hires", { schema: expect.anything() });
  });

  it("sends the status, cursor and limit as the API's strict query", async () => {
    await listHires({ status: "confirmed", cursor: "c1", limit: 50 });
    expect(adminFetch).toHaveBeenCalledWith(
      "/admin/hires?status=confirmed&cursor=c1&limit=50",
      { schema: expect.anything() },
    );
  });

  it("still sends an empty status as absent", async () => {
    await listHires({ status: undefined, cursor: "c1" });
    expect(adminFetch).toHaveBeenCalledWith("/admin/hires?cursor=c1", {
      schema: expect.anything(),
    });
  });
});
