import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";

import { WorkerPreferencesController } from "./worker-preferences.controller";
import type { WorkerPreferencesService } from "./worker-preferences.service";
import type { AuthenticatedWorker } from "../auth/worker-auth.guard";
import type { RequestContext } from "../common/request-context";
import { CITY_CATALOGUE, STATE_CATALOGUE } from "./worker-cities.catalogue";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import type { AvailabilityAnswersConfig } from "./availability-answers.flag";
import { SetMyPreferencesSchema } from "./worker-preferences.dto";
import {
  AVAILABILITY_STATUSES_ALL,
  AVAILABILITY_STATUSES_V1,
  AVAILABILITY_STATUSES_V2,
  DOCUMENTS_READY,
  JOB_TYPES,
  LANGUAGES,
  SHIFTS,
  WORK_TYPES,
} from "./worker-preferences.vocabulary";

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
function controller(config?: AvailabilityAnswersConfig): WorkerPreferencesController {
  return new WorkerPreferencesController(null as unknown as WorkerPreferencesService, config);
}

const FLAG_OFF: AvailabilityAnswersConfig = { AVAILABILITY_ANSWERS_V2_ENABLED: false };
const FLAG_ON: AvailabilityAnswersConfig = { AVAILABILITY_ANSWERS_V2_ENABLED: true };

describe("GET /workers/me/work-preferences/options", () => {
  it("serves exactly nine option sets", () => {
    // Pinned as a whole, not key by key: a TENTH key added without a client change is a payload
    // every worker downloads and nothing renders, and this list is where that gets noticed.
    // `states` was the sixth, added consciously by #1429 for the state-then-city cascade;
    // `city_hubs` is the seventh (#1634), the DESIGN2 picker's curated hub catalogue;
    // `availability_status` and `work_types` are the eighth and ninth (ADR-0045 R4), the chips
    // the general form's terms page asks and no other page could render.
    expect(Object.keys(controller().options()).sort()).toEqual([
      "availability_status",
      "cities",
      "city_hubs",
      "documents_ready",
      "job_type",
      "languages",
      "shift",
      "states",
      "work_types",
    ]);
  });

  it("serves the state/UT list, and every city's state is one of them (#1429)", () => {
    const { states, cities } = controller().options();
    expect(states).toBe(STATE_CATALOGUE);
    // 28 states + 8 union territories. Pinned as a count so a half-deleted list is loud.
    expect(states).toHaveLength(36);
    expect([...states]).toEqual([...states].slice().sort());

    // THE PROPERTY THE CASCADE RESTS ON. A city tagged with a state that is not offered is a city
    // no worker can ever reach by picking a state first — it would show in the flat list and
    // vanish from the filtered one, which is the #1406 dead end one layer in.
    const offered = new Set(states);
    for (const city of cities) expect(offered.has(city.state)).toBe(true);

    // FULL COVERAGE SINCE #1560. The employer-location field asks where a PREVIOUS employer
    // was, which can be anywhere in India — so every one of the 36 states/UTs must have at least
    // one city. Previously the catalogue held 36 hubs across 13 states and this asserted the gap;
    // now the gap is closed and the assertion pins the coverage instead.
    expect(new Set(cities.map((c) => c.state)).size).toBe(states.length);
  });

  it("serves the six closed vocabularies by reference, not a copy", () => {
    // The dictionaries are the single source of truth for both the zod enums and the printed
    // résumé labels. Copying them here would be a third place an option could exist.
    const res = controller().options();
    expect(res.languages).toBe(LANGUAGES);
    expect(res.documents_ready).toBe(DOCUMENTS_READY);
    expect(res.job_type).toBe(JOB_TYPES);
    expect(res.shift).toBe(SHIFTS);
    expect(res.availability_status).toBe(AVAILABILITY_STATUSES_V1);
    expect(res.work_types).toBe(WORK_TYPES);
    // ONE DICTIONARY UNDER TWO KEYS (`WORK_TYPES === JOB_TYPES`), so the multi and the single can
    // never offer different options or print different English for one slug.
    expect(res.work_types).toBe(res.job_type);
  });

  it("serves the two ADR-0045 chip sets the PUT actually accepts, and nothing it refuses", () => {
    // THE FAILURE A SERVED CHIP SET EXISTS TO PREVENT: a chip the worker can tap that the
    // `.strict()` PUT then refuses, failing the WHOLE page save. Asserted through the real schema.
    const res = controller().options();
    for (const status of Object.keys(res.availability_status)) {
      expect(
        SetMyPreferencesSchema.safeParse({ availability: { status } }).success,
        `availability status ${status}`,
      ).toBe(true);
    }
    const allTypes = Object.keys(res.work_types);
    expect(allTypes.length).toBeGreaterThan(0);
    expect(SetMyPreferencesSchema.safeParse({ work_types: allTypes }).success).toBe(true);
  });

  it("serves the city catalogue, so city entry stops being free-text-and-hope (#1406)", () => {
    const { cities } = controller().options();
    expect(cities).toBe(CITY_CATALOGUE);
    expect(cities.length).toBeGreaterThan(0);

    // The shape, pinned. `value` is what a chip shows AND what `preferred_cities` must be sent —
    // there is no slug layer to get wrong — and `aliases` are lowercase search keys only.
    for (const city of cities) {
      expect(Object.keys(city).sort()).toEqual(["aliases", "state", "value"]);
      expect(typeof city.value).toBe("string");
      expect(typeof city.state).toBe("string");
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
    // A backstop, not a budget — honest about which. MEASURED 2026-09-26 at ~8.8 KB: the city
    // catalogue (~4.7 KB) and the hub catalogue (~2.5 KB) are most of it, and ADR-0045's two chip
    // sets added ~230 bytes. The ceiling still has ~7 KB of slack; it catches only the change that
    // turns a static dictionary into something large enough that "serve it on every page mount
    // instead of a `?q=` route" stops being obviously right.
    expect(body.length).toBeLessThan(16_000);
    // The two ADR-0045 sets are dictionaries of a handful of slugs, not catalogues.
    const res = controller().options();
    expect(JSON.stringify(res.availability_status).length).toBeLessThan(512);
    expect(JSON.stringify(res.work_types).length).toBeLessThan(512);
  });
});

/**
 * #2753 item 3 — `AVAILABILITY_ANSWERS_V2_ENABLED`. The options route is the switch: off serves the
 * first four, byte for byte; on serves the brief's four. The PUT accepts both sets either way.
 */
describe("the availability answers switch (#2753 item 3)", () => {
  it.each([
    ["no config at all (a hand-built instance)", undefined],
    ["the flag off", FLAG_OFF],
  ] as const)("with %s, availability_status is today's dictionary exactly", (_label, config) => {
    const res = controller(config).options();
    expect(res.availability_status).toBe(AVAILABILITY_STATUSES_V1);
    // The wire bytes a shipped build decodes today, pinned, so "off" cannot drift.
    expect(JSON.stringify(res.availability_status)).toBe(
      '{"immediate":"Immediately","within_week":"Within a week","within_month":"Within a month","serving_notice":"Serving notice"}',
    );
  });

  it("with the flag on, availability_status is the brief's four, in the brief's order", () => {
    const res = controller(FLAG_ON).options();
    expect(res.availability_status).toBe(AVAILABILITY_STATUSES_V2);
    expect(Object.entries(res.availability_status)).toEqual([
      ["join_now", "Can join now"],
      ["in_15_days", "Can join in 15 days"],
      ["in_30_days", "Can join in 30 days"],
      ["working_open", "Working, open to a better offer"],
    ]);
  });

  it("changes nothing else in the response", () => {
    const { availability_status: _off, ...off } = controller(FLAG_OFF).options();
    const { availability_status: _on, ...on } = controller(FLAG_ON).options();
    expect(Object.keys(on).sort()).toEqual(Object.keys(off).sort());
    for (const key of Object.keys(off) as (keyof typeof off)[]) expect(on[key]).toBe(off[key]);
  });

  it.each([
    ["off", FLAG_OFF],
    ["on", FLAG_ON],
  ] as const)("with the flag %s, every served chip is one the PUT accepts", (_label, config) => {
    for (const status of Object.keys(controller(config).options().availability_status)) {
      expect(SetMyPreferencesSchema.safeParse({ availability: { status } }).success, status).toBe(
        true,
      );
    }
  });

  it.each([
    ["off", FLAG_OFF],
    ["on", FLAG_ON],
  ] as const)(
    "with the flag %s, the PUT takes a key of EITHER set through its real pipe",
    async (_label, config) => {
      // Installed builds keep sending the first set after the switch, and a key of the second can
      // arrive before it; refusing either would 400 the whole `.strict()` page save.
      const preferences = {
        setForWorker: vi.fn(async () => ({ worker_id: "w-1", keys_written: 1, keys_cleared: 0 })),
      };
      const c = new WorkerPreferencesController(
        preferences as unknown as WorkerPreferencesService,
        config,
      );
      const pipe = new ZodValidationPipe(SetMyPreferencesSchema);
      for (const status of Object.keys(AVAILABILITY_STATUSES_ALL)) {
        const dto = pipe.transform({ availability: { status } });
        await c.setMyPreferences({ id: "w-1", sid: "s-1" }, dto, { requestId: "r" } as never);
        expect(preferences.setForWorker).toHaveBeenLastCalledWith(
          "w-1",
          { availability: { status } },
          expect.anything(),
        );
      }
      expect(preferences.setForWorker).toHaveBeenCalledTimes(8);
      // Still a closed set: a status neither dictionary knows is refused, flag on or off.
      expect(() => pipe.transform({ availability: { status: "next_week" } })).toThrow();
    },
  );
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
