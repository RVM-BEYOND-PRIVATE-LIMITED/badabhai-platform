import "reflect-metadata";
import { describe, expect, it } from "vitest";
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
});
