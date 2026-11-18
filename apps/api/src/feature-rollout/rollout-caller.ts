import type { AuthenticatedAdmin } from "../admin/admin-auth.guard";
import type { AuthenticatedWorker } from "../auth/worker-auth.guard";
import type { PayerTenantScope, TenantKey } from "../payers/payer-tenant-scope";

/** Module-private, so no other file can write the key a {@link RolloutCaller} must carry. */
const SEALED: unique symbol = Symbol("RolloutCaller");

/**
 * Every caller the builders below made, and nothing else. Module-private: nothing outside this
 * file can add to it, and membership is by IDENTITY, so a copy of a real caller is not in it.
 */
const BUILT = new WeakSet<object>();

/**
 * WHO asks a per-login rollout question (#2820): a worker, a company (by its TENANT key, so a team
 * member inherits the company's pilot place under `PAYER_ORG_TENANCY_MODE=on`) or an admin.
 *
 * SEALED TWICE, so a caller is built only from what an auth guard put on the request, never from a
 * body or a path:
 *   - at compile time, every variant carries a module-private symbol, so
 *     `{ kind: "worker", workerId: body.id }` does not compile, and a cast to this type (it carries
 *     a `TenantKey`) fails `payer-tenancy.static.test.ts` (S-F1) outside `payer-tenant-scope.ts`;
 *   - at run time, because a SPREAD copies the symbol (`{ ...rolloutCaller.admin(a), kind:
 *     "worker", workerId: body.id }` compiles with no cast): each builder freezes what it makes
 *     and records it, and `FeatureRolloutService` answers `false` for any caller it did not record.
 * What neither seal can stop: the guards' types are plain interfaces, so a builder handed a
 * hand-made `{ id: body.id, … }` compiles and seals. Pass the decorator's object as it came.
 */
export type RolloutCaller =
  | { readonly kind: "worker"; readonly workerId: string; readonly [SEALED]: true }
  | { readonly kind: "payer"; readonly tenantKey: TenantKey; readonly [SEALED]: true }
  | { readonly kind: "admin"; readonly adminId: string; readonly [SEALED]: true };

/** Freeze and record a caller one of the builders made. Never exported. */
function seal(caller: RolloutCaller): RolloutCaller {
  BUILT.add(Object.freeze(caller));
  return caller;
}

/** The three ways to name a caller, one per auth guard. */
export const rolloutCaller = Object.freeze({
  /** `@CurrentWorker()` (WorkerAuthGuard). */
  worker: (worker: AuthenticatedWorker): RolloutCaller =>
    seal({ kind: "worker", workerId: worker.id, [SEALED]: true }),
  /**
   * A company: its resolved tenant key, never a raw payer id. From `PayerTenantScopeService.resolve`
   * or `@CurrentTenantScope()`, passed straight in. A route that must not 403 asks
   * `FeatureRolloutService.isThemeOpenForPayer` instead, which resolves only in `pilot` (#2819).
   */
  payer: (scope: Pick<PayerTenantScope, "tenantKey">): RolloutCaller =>
    seal({ kind: "payer", tenantKey: scope.tenantKey, [SEALED]: true }),
  /** `@CurrentAdmin()` (AdminAuthGuard). */
  admin: (admin: AuthenticatedAdmin): RolloutCaller =>
    seal({ kind: "admin", adminId: admin.id, [SEALED]: true }),
});

/**
 * Did one of the builders above make exactly this object? For `FeatureRolloutService` only (a
 * static test pins its one caller). It READS the record and adds nothing, and it answers a plain
 * boolean, not a type predicate, so importing it cannot turn any value into a caller: `null`, a
 * non-object, a hand-made object and a spread copy of a real caller are all `false`.
 */
export function isSealedRolloutCaller(value: unknown): boolean {
  return typeof value === "object" && value !== null && BUILT.has(value);
}
