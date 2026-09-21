import { describe, it, expect } from "vitest";
import { CITY_HUBS } from "./worker-cities.hubs";
import { CITY_CATALOGUE, STATE_CATALOGUE } from "./worker-cities.catalogue";
import { SetMyPreferencesSchema } from "./worker-preferences.dto";

/**
 * The DESIGN2 hub catalogue (#1634).
 *
 * THE CENTRAL PROMISE IS THE SAME ONE THE FLAT CITY LIST MAKES: every tap a hub offers must be a
 * value the write endpoint accepts, and accepts UNCHANGED — a hub that displayed one city and
 * stored another would print something else on the résumé. It is asserted through the REAL DTO
 * rather than through `canonicalCity`, because the DTO is what decides what may be submitted.
 *
 * The rest are the invariants the client cascade and the mockup rest on: every `state` is a served
 * state (the client filters by string equality), every `city_value` is in the served city list (a
 * hub pointing outside it would be a chip the picker itself cannot render), keys are unique, and
 * the POPULAR row is non-empty and not the whole catalogue.
 */
describe("the DESIGN2 hub catalogue (#1634)", () => {
  it("offers only city values the write endpoint accepts UNCHANGED", () => {
    for (const hub of CITY_HUBS) {
      const parsed = SetMyPreferencesSchema.safeParse({ preferred_cities: [hub.city_value] });
      expect(parsed.success, `hub "${hub.hub_key}" submits "${hub.city_value}"`).toBe(true);
      if (parsed.success) {
        expect(parsed.data.preferred_cities, `"${hub.city_value}" is rewritten on write`).toEqual([
          hub.city_value,
        ]);
      }
    }
  });

  it("every hub city_value is a member of the served city list", () => {
    const served = new Set(CITY_CATALOGUE.map((city) => city.value));
    for (const hub of CITY_HUBS) {
      expect(served.has(hub.city_value), `"${hub.city_value}" is not a served city`).toBe(true);
    }
  });

  it("every hub state is a served state — the client cascades by string equality", () => {
    const states = new Set(STATE_CATALOGUE);
    for (const hub of CITY_HUBS) {
      expect(states.has(hub.state), `"${hub.state}" is not a served state`).toBe(true);
    }
  });

  it("hub_key is unique, and every hub carries a display label and at least one area", () => {
    const keys = CITY_HUBS.map((hub) => hub.hub_key);
    expect(new Set(keys).size, "a hub_key appears twice").toBe(keys.length);
    for (const hub of CITY_HUBS) {
      expect(hub.hub_key.length).toBeGreaterThan(0);
      expect(hub.display.trim().length).toBeGreaterThan(0);
      expect(hub.areas.length).toBeGreaterThan(0);
      for (const area of hub.areas) expect(area.trim().length).toBeGreaterThan(0);
    }
  });

  it("marks a POPULAR row that is neither empty nor the whole catalogue", () => {
    const popular = CITY_HUBS.filter((hub) => hub.popular);
    expect(popular.length).toBeGreaterThan(0);
    expect(popular.length).toBeLessThan(CITY_HUBS.length);
  });
});
