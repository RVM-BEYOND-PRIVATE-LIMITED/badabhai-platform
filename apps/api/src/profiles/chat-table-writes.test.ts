import { describe, expect, it } from "vitest";

import {
  roleIdsFromChatAttributes,
  trainingEntryFromChatAttributes,
  type ChatAttribute,
} from "./chat-table-writes";

const attribute = (
  attributeKey: string,
  value: ChatAttribute["value"],
): ChatAttribute => ({ attributeKey, value });

describe("trainingEntryFromChatAttributes", () => {
  it("assembles one row from the three chat attributes", () => {
    expect(
      trainingEntryFromChatAttributes([
        attribute("training_name", "CNC operator course"),
        attribute("training_provider", "Govt ITI"),
        attribute("training_year", 2019),
      ]),
    ).toEqual({ name: "CNC operator course", provider: "Govt ITI", year: 2019 });
  });

  it("gates the whole row on the name — a year with no course is not a credential", () => {
    expect(
      trainingEntryFromChatAttributes([
        attribute("training_provider", "Govt ITI"),
        attribute("training_year", 2019),
      ]),
    ).toBeNull();
    expect(trainingEntryFromChatAttributes([])).toBeNull();
  });

  it("keeps provider and year optional", () => {
    expect(trainingEntryFromChatAttributes([attribute("training_name", "Welding course")])).toEqual({
      name: "Welding course",
      provider: null,
      year: null,
    });
  });

  it("refuses a year the worker_training CHECK would reject", () => {
    for (const year of [1949, 2101, 20.19, Number.NaN]) {
      expect(
        trainingEntryFromChatAttributes([
          attribute("training_name", "CNC course"),
          attribute("training_year", year),
        ])?.year,
      ).toBeNull();
    }
  });

  it("trims and bounds the free-text fields to the page's own limits", () => {
    const entry = trainingEntryFromChatAttributes([
      attribute("training_name", `  ${"n".repeat(200)}  `),
      attribute("training_provider", `  ${"p".repeat(200)}  `),
    ]);
    expect(entry?.name).toHaveLength(120);
    expect(entry?.provider).toHaveLength(120);
  });
});

describe("roleIdsFromChatAttributes", () => {
  it("keeps known role ids in the worker's order", () => {
    expect(roleIdsFromChatAttributes([attribute("secondary_occupations", ["role_welder", "role_plumber"])]))
      .toEqual(["role_welder", "role_plumber"]);
  });

  it("drops ids the closed taxonomy does not know — the page's PUT would 400 on them", () => {
    expect(
      roleIdsFromChatAttributes([
        attribute("secondary_occupations", ["role_welder", "role_astronaut", "role_carpenter"]),
      ]),
    ).toEqual(["role_welder", "role_carpenter"]);
  });

  it("dedupes and caps at the page's own maximum", () => {
    const ids = [
      "role_welder",
      "role_welder",
      "role_plumber",
      "role_carpenter",
      "role_designer",
      "role_interior_designer",
    ];
    expect(roleIdsFromChatAttributes([attribute("secondary_occupations", ids)])).toEqual([
      "role_welder",
      "role_plumber",
      "role_carpenter",
      "role_designer",
    ]);
  });

  it("returns nothing when the item was never answered or was declined", () => {
    expect(roleIdsFromChatAttributes([])).toEqual([]);
    expect(roleIdsFromChatAttributes([attribute("secondary_occupations", "")])).toEqual([]);
  });
});
