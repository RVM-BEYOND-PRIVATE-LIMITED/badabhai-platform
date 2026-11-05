import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { AuthController } from "./auth.controller";
import { ConsentController } from "../consent/consent.controller";
import { ALLOW_SUSPENDED_KEY } from "./worker-auth.guard";

/**
 * #2562 — WIRING PIN for the DPDP exits.
 *
 * The guard's behaviour is covered in `worker-auth.guard.test.ts`; this file makes sure the
 * routes that MUST stay reachable while a worker is suspended actually carry the decorator.
 * A missing `@AllowSuspended()` here would silently trap a suspended worker away from account
 * deletion and consent withdrawal, which the owner ruled must remain open (DPDP).
 */
describe("#2562 — suspension exemptions are wired to the exact DPDP routes", () => {
  const exempt = [
    ["AuthController.accountDeleteRequest", AuthController.prototype.accountDeleteRequest],
    ["AuthController.accountDeleteConfirm", AuthController.prototype.accountDeleteConfirm],
    ["AuthController.accountDeleteCancel", AuthController.prototype.accountDeleteCancel],
    ["ConsentController.withdraw", ConsentController.prototype.withdraw],
    [
      "ConsentController.withdrawEmployerContact",
      ConsentController.prototype.withdrawEmployerContact,
    ],
  ] as const;

  it.each(exempt)("%s carries @AllowSuspended", (_name, handler) => {
    expect(Reflect.getMetadata(ALLOW_SUSPENDED_KEY, handler)).toBe(true);
  });

  const refused = [
    ["AuthController.me", AuthController.prototype.me],
    ["AuthController.logout", AuthController.prototype.logout],
    ["AuthController.logoutAll", AuthController.prototype.logoutAll],
    ["AuthController.session", AuthController.prototype.session],
    ["ConsentController.accept", ConsentController.prototype.accept],
    ["ConsentController.mine", ConsentController.prototype.mine],
  ] as const;

  it.each(refused)("%s does NOT carry @AllowSuspended (stays refused)", (_name, handler) => {
    expect(Reflect.getMetadata(ALLOW_SUSPENDED_KEY, handler)).toBeUndefined();
  });

  it("is wired to EXACTLY five handlers in the whole controller tree (#2701)", () => {
    // A SOURCE scan, not reflection: a future controller could import the decorator and put it
    // on a sixth route; the reflection list above would still pass. The count is the invariant.
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (entry.endsWith(".controller.ts")) {
          const src = readFileSync(full, "utf8");
          const count = src.split("@AllowSuspended()").length - 1;
          for (let i = 0; i < count; i += 1) {
            hits.push(relative(join(__dirname, ".."), full).split(sep).join("/"));
          }
        }
      }
    };
    walk(join(__dirname, ".."));

    expect(hits).toHaveLength(5);
    expect(hits.sort()).toEqual([
      "auth/auth.controller.ts",
      "auth/auth.controller.ts",
      "auth/auth.controller.ts",
      "consent/consent.controller.ts",
      "consent/consent.controller.ts",
    ]);
  });
});
