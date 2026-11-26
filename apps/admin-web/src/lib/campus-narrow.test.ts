import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #3050 — the Campus narrow queue's reads. The page carries a keyset cursor rather than a total,
 * so the navigation badge counts by walking pages; a repeated cursor stops the walk instead of
 * looping, and the page itself never invents a page size.
 */
const adminFetch = vi.hoisted(() => vi.fn());

vi.mock("./admin-http", () => ({
  adminFetch: (...args: unknown[]) => adminFetch(...args),
}));

const { countNarrowQueue, listNarrowQueue } = await import("./campus-narrow");

const item = (id: string) => ({
  posting_id: id,
  company_id: null,
  company_label: "A company",
  title: "Machine Operator",
  campus_role_text: "Machine Operator",
  origin: "campus_posted" as const,
  posted_at: "2026-11-01T00:00:00.000Z",
});

beforeEach(() => adminFetch.mockReset());

describe("listNarrowQueue", () => {
  it("asks for the API's default page when no cursor or limit is given", async () => {
    adminFetch.mockResolvedValueOnce({ postings: [], next_cursor: null });
    await listNarrowQueue();
    expect(adminFetch.mock.calls[0]![0]).toBe("/admin/postings/campus-narrow-queue");
  });

  it("passes the cursor and limit as the API spells them", async () => {
    adminFetch.mockResolvedValueOnce({ postings: [], next_cursor: null });
    await listNarrowQueue("cursor-1", 200);
    expect(adminFetch.mock.calls[0]![0]).toBe(
      "/admin/postings/campus-narrow-queue?cursor=cursor-1&limit=200",
    );
  });
});

describe("countNarrowQueue", () => {
  it("walks every page and adds the rows", async () => {
    adminFetch
      .mockResolvedValueOnce({ postings: [item("a"), item("b")], next_cursor: "c1" })
      .mockResolvedValueOnce({ postings: [item("c")], next_cursor: null });

    await expect(countNarrowQueue()).resolves.toBe(3);

    expect(adminFetch.mock.calls.map((c) => c[0])).toEqual([
      "/admin/postings/campus-narrow-queue?limit=200",
      "/admin/postings/campus-narrow-queue?cursor=c1&limit=200",
    ]);
  });

  it("stops on a cursor that repeats rather than looping for ever", async () => {
    adminFetch
      .mockResolvedValueOnce({ postings: [item("a")], next_cursor: "same" })
      .mockResolvedValueOnce({ postings: [item("b")], next_cursor: "same" });

    await expect(countNarrowQueue()).resolves.toBe(2);
    expect(adminFetch).toHaveBeenCalledTimes(2);
  });

  it("stops on an empty page that still claims a next one", async () => {
    adminFetch.mockResolvedValueOnce({ postings: [], next_cursor: "odd" });
    await expect(countNarrowQueue()).resolves.toBe(0);
    expect(adminFetch).toHaveBeenCalledTimes(1);
  });
});
