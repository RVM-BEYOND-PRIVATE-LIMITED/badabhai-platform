import "reflect-metadata";
import { describe, it, expect } from "vitest";
import { MACHINES, SKILLS } from "@badabhai/taxonomy";
import { WorkerCatalogueController } from "./worker-catalogue.controller";

/**
 * The two catalogue endpoints' WIRE CONTRACT (#1596). Asserted at the controller because that is
 * where the contract with the Flutter client lives, and a renamed key is a silently empty picker
 * rather than a failing request.
 *
 * The controller takes no dependencies: both routes are pure reads of `@badabhai/taxonomy`.
 * Constructing it bare is the assertion — if either route ever starts needing a service, the
 * response has stopped being static and this docstring's "no worker data" claim needs re-earning.
 */
function controller(): WorkerCatalogueController {
  return new WorkerCatalogueController();
}

describe("GET /workers/me/skills/options", () => {
  it("serves the whole skill catalogue as skill_id + label pairs, in taxonomy order", () => {
    const body = controller().skills();
    expect(Object.keys(body)).toEqual(["skills"]);
    expect(body.skills).toHaveLength(SKILLS.length);
    expect(body.skills[0]).toEqual({ skill_id: SKILLS[0]!.id, label: SKILLS[0]!.name });
    expect(body.skills.map((o) => o.skill_id)).toEqual(SKILLS.map((n) => n.id));
  });

  it("carries no worker data and no field beyond the closed pair", () => {
    const body = controller().skills();
    for (const option of body.skills) {
      expect(Object.keys(option).sort()).toEqual(["label", "skill_id"]);
    }
    expect(JSON.stringify(body)).not.toMatch(/worker|phone|name|count/i);
  });
});

describe("GET /workers/me/machines/options", () => {
  it("serves the whole machine catalogue as machine_id + label pairs, in taxonomy order", () => {
    const body = controller().machines();
    expect(Object.keys(body)).toEqual(["machines"]);
    expect(body.machines).toHaveLength(MACHINES.length);
    expect(body.machines[0]).toEqual({ machine_id: MACHINES[0]!.id, label: MACHINES[0]!.name });
    expect(body.machines.map((o) => o.machine_id)).toEqual(MACHINES.map((n) => n.id));
  });

  it("carries no worker data and no field beyond the closed pair", () => {
    const body = controller().machines();
    for (const option of body.machines) {
      expect(Object.keys(option).sort()).toEqual(["label", "machine_id"]);
    }
    expect(JSON.stringify(body)).not.toMatch(/worker|phone|name|count/i);
  });
});
