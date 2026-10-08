import { readFileSync } from "node:fs";

import { serverEnvSchema } from "@badabhai/config";
import { describe, expect, it } from "vitest";

import { STAGING_COMPOSE_PATH, environmentOfFile } from "../common/testing/compose-env";

/**
 * #2113 — THE ERASED-CREDENTIAL TOMBSTONE'S KILL SWITCH REACHES THE PRODUCTION API CONTAINER.
 *
 * Owner ruling 2 made `ACCOUNT_DELETION_TOKEN_TOMBSTONE_SECONDS=0` the off switch for both the
 * write and the read, and the deletion runbook (§7 "Turning it off", §9 the backup-restore
 * alternative) sends operators to it. docker-compose.staging.yml is the PRODUCTION overlay; its
 * api service has no `env_file:`, and compose forwards only the names a service declares. The
 * first cut of #2113 declared nothing, so whatever the box set, the container ran the zod default
 * and the documented lever moved nothing: a restored worker kept getting a false 410, and an
 * incident could not switch the 410 path off. The #1306 / #1264 / #798 / #794 class.
 *
 * Pinned to `${NAME:-<zod default>}`: `:-` so an unset OR empty value takes the default and the
 * box stays bootable with nothing exported (a tuning number, not a secret, so no `:?` and no
 * secret-parity bridge); the default must MIRROR the schema's, so declaring the line changes
 * nothing until an operator sets it.
 */
const NAME = "ACCOUNT_DELETION_TOKEN_TOMBSTONE_SECONDS";
const OVERRIDABLE_WITH_DEFAULT = new RegExp(`^\\$\\{${NAME}:-(\\d+)\\}$`);

describe(`${NAME} — declared on the production api, overridable, defaulting to the schema's value`, () => {
  const api = environmentOfFile(STAGING_COMPOSE_PATH, "api");
  const field = serverEnvSchema.shape[NAME];

  it("parses the api service environment (canaries: guards the parser, not the rule)", () => {
    expect(api.get("NODE_ENV")).toBe("production");
    expect(api.get("ACCOUNT_DELETION_COOLDOWN_SECONDS")).toBe(
      "${ACCOUNT_DELETION_COOLDOWN_SECONDS:-604800}",
    );
  });

  it("is declared on the api service as a `${NAME:-<n>}` substitution, never a literal or `:?`", () => {
    expect(api.get(NAME), `${NAME} missing from the api service, or not overridable`).toMatch(
      OVERRIDABLE_WITH_DEFAULT,
    );
  });

  it("its substitution default MIRRORS the zod default, so an unset box keeps today's behaviour", () => {
    const composeDefault = Number(OVERRIDABLE_WITH_DEFAULT.exec(api.get(NAME) ?? "")?.[1]);
    expect(composeDefault).toBe(field.parse(undefined));
    expect(composeDefault).toBe(604800);
  });

  it("the runbook's kill-switch value survives the schema the container boots on", () => {
    // What an operator writes into the box's project .env reaches the process as a string.
    expect(field.parse("0")).toBe(0);
  });

  it("is declared EXACTLY once in the file — a second copy would win silently (last key wins)", () => {
    // environmentOf returns a Map, so a duplicate key in one block collapses into one entry and
    // passes every assertion above; counting raw declaration lines is what sees it.
    const declarations = readFileSync(STAGING_COMPOSE_PATH, "utf8")
      .split(/\r?\n/)
      .filter((line) => new RegExp(`^\\s+${NAME}:`).test(line));
    expect(declarations).toHaveLength(1);
  });
});
