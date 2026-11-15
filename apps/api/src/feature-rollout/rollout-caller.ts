import type { AuthenticatedAdmin } from "../admin/admin-auth.guard";
import type { AuthenticatedWorker } from "../auth/worker-auth.guard";
import type { PayerTenantScope, TenantKey } from "../payers/payer-tenant-scope";

/** Module-private, so no other file can write the key a {@link RolloutCaller} must carry. */
const SEALED: unique symbol = Symbol("RolloutCaller");

/**
 * WHO asks a per-login rollout question (#2820): a worker, a company (by its TENANT key, so a team
 * member inherits the company's pilot place under `PAYER_ORG_TENANCY_MODE=on`) or an admin.
 *
 * SEALED, so a caller is built only from what an auth guard put on the request, never from a body
 * or a path: every variant carries a module-private symbol, and the builders in
 * {@link rolloutCaller} are the only code that can write it. `{ kind: "worker", workerId: body.id }`
 * does not compile. A cast would, but this type carries a `TenantKey`, so
 * `payer-tenancy.static.test.ts` (S-F1) already fails on any assertion to it outside
 * `payer-tenant-scope.ts`. What the seal cannot stop: the guards' types are plain interfaces, so a
 * builder handed a hand-made `{ id: body.id, … }` compiles. Pass the decorator's object as it came.
 */
export type RolloutCaller =
  | { readonly kind: "worker"; readonly workerId: string; readonly [SEALED]: true }
  | { readonly kind: "payer"; readonly tenantKey: TenantKey; readonly [SEALED]: true }
  | { readonly kind: "admin"; readonly adminId: string; readonly [SEALED]: true };

/** The three ways to name a caller, one per auth guard. */
export const rolloutCaller = {
  /** `@CurrentWorker()` (WorkerAuthGuard). */
  worker: (worker: AuthenticatedWorker): RolloutCaller => ({
    kind: "worker",
    workerId: worker.id,
    [SEALED]: true,
  }),
  /**
   * A company: its resolved tenant key, never a raw payer id. From `PayerTenantScopeService.resolve`
   * or `@CurrentTenantScope()`; or from `resolveSelfView` where a route must not 403 (a `null`
   * key there means tenancy refused the login, so do not ask: the theme is closed).
   */
  payer: (scope: Pick<PayerTenantScope, "tenantKey">): RolloutCaller => ({
    kind: "payer",
    tenantKey: scope.tenantKey,
    [SEALED]: true,
  }),
  /** `@CurrentAdmin()` (AdminAuthGuard). */
  admin: (admin: AuthenticatedAdmin): RolloutCaller => ({
    kind: "admin",
    adminId: admin.id,
    [SEALED]: true,
  }),
} as const;
