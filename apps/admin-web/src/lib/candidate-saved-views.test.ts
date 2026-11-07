import { describe, expect, it } from "vitest";
import {
  SAVED_VIEWS_MAX,
  newSavedViewId,
  parseSavedViews,
  removeSavedView,
  saveCandidateView,
  type SavedCandidateView,
} from "./candidate-saved-views";

/**
 * Local saved views (A7, #2577): localStorage is the viewer's to edit, so everything read from
 * it is narrowed; saving a name twice replaces it; the list is bounded.
 */
const view = (name: string): SavedCandidateView => ({
  id: `id-${name}`,
  name,
  saved_at: "2026-11-07T09:00:00.000Z",
  q: "Ramesh",
  filters: { status: ["active"], city: ["Pune"], min_experience_years: 3 },
  sort: "total_experience_years",
  dir: "desc",
  page_size: 100,
});

describe("parseSavedViews", () => {
  it("returns nothing for empty or malformed storage", () => {
    expect(parseSavedViews(null)).toEqual([]);
    expect(parseSavedViews("")).toEqual([]);
    expect(parseSavedViews("{")).toEqual([]);
    expect(parseSavedViews('{"not":"an array"}')).toEqual([]);
  });

  it("drops an entry with no id or name, and narrows the rest", () => {
    const raw = JSON.stringify([
      { id: "", name: "No id" },
      { id: "a", name: "  Welders  ", saved_at: "2026-11-07T09:00:00.000Z", page_size: 7 },
      {
        id: "b",
        name: "Pune",
        saved_at: "2026-11-07T09:00:00.000Z",
        filters: { status: ["active", 7], city: "not an array", flagged: "yes" },
        sort: "nonsense",
        dir: "sideways",
        page_size: 25,
      },
    ]);
    const parsed = parseSavedViews(raw);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ id: "a", name: "Welders", page_size: 50 });
    expect(parsed[1]).toMatchObject({
      id: "b",
      sort: "last_active_at",
      dir: "desc",
      page_size: 25,
    });
    expect(parsed[1]!.filters).toEqual({ status: ["active"] });
  });
});

describe("saving and removing", () => {
  it("replaces a view saved under the same name, keeping its place", () => {
    const one = view("Pune welders");
    const saved = saveCandidateView([one], {
      ...one,
      id: "new-id",
      filters: { city: ["Pune", "Chakan"] },
    });
    expect(saved).toHaveLength(1);
    expect(saved[0]!.id).toBe("new-id");
    expect(saved[0]!.filters.city).toEqual(["Pune", "Chakan"]);
  });

  it("adds a new view at the front and drops the oldest at the cap", () => {
    let list: SavedCandidateView[] = [];
    for (let i = 0; i < SAVED_VIEWS_MAX + 2; i++) {
      list = saveCandidateView(list, { ...view(`v${i}`), id: `id-${i}` });
    }
    expect(list).toHaveLength(SAVED_VIEWS_MAX);
    expect(list[0]!.name).toBe(`v${SAVED_VIEWS_MAX + 1}`);
    expect(list.at(-1)!.name).toBe("v2");
  });

  it("ignores a blank name", () => {
    const list = [view("Pune")];
    expect(saveCandidateView(list, { ...view("   "), id: "x" })).toEqual(list);
  });

  it("removes one by id and leaves the rest", () => {
    const list = [view("a"), view("b")];
    expect(removeSavedView(list, "id-a").map((v) => v.name)).toEqual(["b"]);
  });
});

describe("newSavedViewId", () => {
  it("is stable for the clock and random tail it is given, and unique otherwise", () => {
    expect(newSavedViewId(1, 0.5)).toBe(newSavedViewId(1, 0.5));
    expect(newSavedViewId(1, 0.5)).not.toBe(newSavedViewId(2, 0.5));
  });
});
