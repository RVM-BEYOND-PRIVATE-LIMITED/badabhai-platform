import "reflect-metadata";
import { describe, it, expect } from "vitest";
import { MACHINES, SKILLS, getMachine, getSkill } from "@badabhai/taxonomy";
import {
  MAX_CORRECTION_MACHINES,
  MAX_CORRECTION_SKILLS,
  machineOptions,
  skillOptions,
} from "./worker-catalogue.options";

/**
 * The PARITY pin for #1596. The whole point of the endpoint is that the client never mints an id:
 * every option it renders must be an id the correction contract ACCEPTS, paired with the label the
 * taxonomy itself gives it. A drifted pair here is a worker tapping a chip that 400s, with nothing
 * on either side naming the cause.
 */
describe("worker correction catalogues — parity with @badabhai/taxonomy (#1596)", () => {
  it("every SKILL option resolves in the taxonomy, with the SAME label", () => {
    const options = skillOptions();
    expect(options.length).toBeGreaterThan(0);
    for (const option of options) {
      const node = getSkill(option.id);
      expect(node, `${option.id} must be a canonical skill id`).toBeDefined();
      expect(option.label).toBe(node?.name);
      expect(option.label.trim().length).toBeGreaterThan(0);
    }
  });

  it("every MACHINE option resolves in the taxonomy, with the SAME label", () => {
    const options = machineOptions();
    expect(options.length).toBeGreaterThan(0);
    for (const option of options) {
      const node = getMachine(option.id);
      expect(node, `${option.id} must be a canonical machine id`).toBeDefined();
      expect(option.label).toBe(node?.name);
      expect(option.label.trim().length).toBeGreaterThan(0);
    }
  });

  it("serves the WHOLE catalogue, in the taxonomy's own order, with unique ids", () => {
    expect(skillOptions().map((o) => o.id)).toEqual(SKILLS.map((n) => n.id));
    expect(machineOptions().map((o) => o.id)).toEqual(MACHINES.map((n) => n.id));
    expect(new Set(skillOptions().map((o) => o.id)).size).toBe(SKILLS.length);
    expect(new Set(machineOptions().map((o) => o.id)).size).toBe(MACHINES.length);
  });

  it("stays inside the correction contract's caps — a bigger catalogue would ship an unpickable tail", () => {
    expect(skillOptions().length).toBeLessThanOrEqual(MAX_CORRECTION_SKILLS);
    expect(machineOptions().length).toBeLessThanOrEqual(MAX_CORRECTION_MACHINES);
  });
});
