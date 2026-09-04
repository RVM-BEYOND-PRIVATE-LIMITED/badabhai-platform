import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";

import { WorkerPreferencesController } from "./worker-preferences.controller";
import type { WorkerPreferencesService } from "./worker-preferences.service";
import type { AuthenticatedWorker } from "../auth/worker-auth.guard";
import type { RequestContext } from "../common/request-context";
import { CITY_CATALOGUE } from "./worker-cities.catalogue";
import { DOCUMENTS_READY, JOB_TYPES, LANGUAGES, SHIFTS } from "./worker-preferences.vocabulary";

/**
 * The options endpoint's WIRE CONTRACT.
 *
 * Asserted at the controller because that is where the contract with the Flutter client lives, and
 * a break here is silent rather than a failing request. Be precise about which half is live:
 * `WorkPrefOptionsDto.fromJson` decodes the FOUR dictionaries today, so renaming one of those is
 * an empty chip row on a worker's phone. `cities` is served ahead of its consumer (#1406) and is
 * currently read by nothing — which is exactly why adding it was safe, and why this pin matters:
 * it is the contract the client work will be built against.
 *
 * The service is not constructed: `options()` is a pure read of two static modules and touches no
 * dependency. Passing a null service is the assertion — if this ever starts needing one, the
 * response has stopped being static and the docstring's "NO WORKER DATA" claim needs re-earning.
 */
function controller(): WorkerPreferencesController {
  return new WorkerPreferencesController(null as unknown as WorkerPreferencesService);
}

describe("GET /workers/me/work-preferences/options", () => {
  it("serves exactly five option sets", () => {
    // Pinned as a whole, not key by key: a SIXTH key added without a client change is a payload
    // every worker downloads and nothing renders, and this list is where that gets noticed.
    expect(Object.keys(controller().options()).sort()).toEqual([
      "cities",
      "documents_ready",
      "job_type",
      "languages",
      "shift",
    ]);
  });

  it("serves the four closed vocabularies by reference, not a copy", () => {
    // The dictionaries are the single source of truth for both the zod enums and the printed
    // résumé labels. Copying them here would be a third place an option could exist.
    const res = controller().options();
    expect(res.languages).toBe(LANGUAGES);
    expect(res.documents_ready).toBe(DOCUMENTS_READY);
    expect(res.job_type).toBe(JOB_TYPES);
    expect(res.shift).toBe(SHIFTS);
  });

  it("serves the city catalogue, so city entry stops being free-text-and-hope (#1406)", () => {
    const { cities } = controller().options();
    expect(cities).toBe(CITY_CATALOGUE);
    expect(cities.length).toBeGreaterThan(0);

    // The shape, pinned. `value` is what a chip shows AND what `preferred_cities` must be sent —
    // there is no slug layer to get wrong — and `aliases` are lowercase search keys only.
    for (const city of cities) {
      expect(Object.keys(city).sort()).toEqual(["aliases", "value"]);
      expect(typeof city.value).toBe("string");
      expect(Array.isArray(city.aliases)).toBe(true);
    }

    // The four spellings a Hinglish speaker actually types. These are the reason the entry is an
    // object rather than a bare string: filtering on display labels alone would show him nothing.
    const aliases = new Set(cities.flatMap((c) => c.aliases));
    for (const spelling of ["dilli", "bombay", "banglore", "poona"]) {
      expect(aliases, `no city is searchable as "${spelling}"`).toContain(spelling);
    }
  });

  it("discloses no worker data and stays small enough to ship on every page mount", () => {
    const body = JSON.stringify(controller().options());
    expect(body).not.toMatch(/worker_?id|phone|full_?name|email/i);
    // A backstop, not a budget — honest about which. The whole response is ~2 KB today, so this
    // ceiling has an order of magnitude of slack and will not notice the gazetteer doubling. It
    // catches only the change that turns a static dictionary into something large enough that
    // "serve it on every page mount instead of a `?q=` route" stops being obviously right.
    expect(body.length).toBeLessThan(16_000);
  });
});

describe("PUT /workers/me/work-preferences", () => {
  const WORKER: AuthenticatedWorker = { id: "w-1", sid: "s-1" };
  const CTX = { requestId: "r-1" } as RequestContext;

  function withService() {
    const preferences = {
      setForWorker: vi.fn(async () => ({ worker_id: "w-1", keys_written: 3, keys_cleared: 1 })),
    };
    return {
      controller: new WorkerPreferencesController(
        preferences as unknown as WorkerPreferencesService,
      ),
      preferences,
    };
  }

  it("takes the worker id from the session, never from the body", async () => {
    // The controller's own docstring makes this claim and nothing tested it. A body-supplied id
    // silently winning would be an IDOR on every worker's preferences.
    const { controller, preferences } = withService();
    const dto = { languages: ["hindi"], worker_id: "someone-else" } as never;

    await controller.setMyPreferences(WORKER, dto, CTX);

    expect(preferences.setForWorker).toHaveBeenCalledWith("w-1", dto, CTX);
  });

  it("answers with counts and never echoes the answers back", async () => {
    const { controller } = withService();

    const res = await controller.setMyPreferences(
      WORKER,
      { preferred_cities: ["Mumbai"] } as never,
      CTX,
    );

    expect(res).toEqual({ ok: true, keys_written: 3, keys_cleared: 1 });
    expect(JSON.stringify(res)).not.toContain("Mumbai");
  });
});
