import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { NotFoundException, UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import type { Payer } from "@badabhai/db";
import { PayerAuthGuard, type AuthenticatedPayer } from "./payer-auth.guard";
import type { PayerSessionService } from "./payer-session.service";
import { PayerAccountController } from "./payer-account.controller";
import { PayerAccountService } from "./payer-account.service";
import type { PayersRepository } from "./payers.repository";

/**
 * Horizontal-authz / IDOR build-blocker (ADR-0019 Decision C / LC-1).
 *
 * Proves the `GET /payer/me` slice binds the read to the GUARD principal, so:
 *   1. payer A's token reads payer A's row ONLY (and B's token reads B's, never A's);
 *   2. nothing in the request (body/param/query) can redirect the read — the only
 *      input to the service is the guard-derived id;
 *   3. a forged / absent / tampered token → 401 (neutral) at the guard.
 */

const PAYER_A = "11111111-1111-4111-8111-111111111111";
const PAYER_B = "22222222-2222-4222-8222-222222222222";

const config = { SESSION_TTL_DAYS: 30 } as unknown as ServerConfig;
const FULL_TTL = 30 * 86400;

/** A `payers` row whose decrypted view echoes its id (so we can assert WHICH row). */
function rowFor(id: string): Payer {
  return {
    id,
    role: "employer",
    emailEnc: "enc",
    emailHash: "hash",
    phoneEnc: null,
    phoneHash: null,
    orgNameEnc: "enc",
    status: "active",
    createdAt: new Date(),
    updatedAt: new Date(),
  } as Payer;
}

/** Repository stub keyed by id: returns the matching row, decrypts to a per-id org. */
function makeRepo() {
  const rows: Record<string, Payer> = { [PAYER_A]: rowFor(PAYER_A), [PAYER_B]: rowFor(PAYER_B) };
  const findById = vi.fn(async (id: string) => rows[id]);
  const decryptContact = vi.fn((row: Payer) => ({
    id: row.id,
    role: row.role,
    status: row.status,
    email: "owner@self.example",
    orgName: `Org-${row.id.slice(0, 4)}`,
    phone: null,
  }));
  return { repo: { findById, decryptContact } as unknown as PayersRepository, findById };
}

interface GuardReq {
  header: (n: string) => string | undefined;
  payer?: AuthenticatedPayer;
}

function makeGuardCtx(authHeader?: string) {
  const headers: Record<string, string> = {};
  if (authHeader !== undefined) headers["authorization"] = authHeader;
  const req: GuardReq = {
    header: (n: string) => headers[n.toLowerCase()],
  };
  const res = { setHeader: vi.fn() };
  const ctx = {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ExecutionContext;
  return { ctx, req };
}

/** A guard whose session validates ANY bearer token to the given payer id. */
function guardFor(payerId: string | null) {
  const session = {
    // role:null → exercises the ADR-0022 fallback (resolve role from the payers row).
    validateAndTouch: vi.fn(async () =>
      payerId ? { payerId, sid: "sid", remainingSeconds: FULL_TTL, role: null } : null,
    ),
    mint: vi.fn(async () => ({ token: "fresh", expiresInSeconds: FULL_TTL })),
  } as unknown as PayerSessionService;
  // The guard's role fallback reads payers.findById; reuse the same per-id repo stub.
  const { repo } = makeRepo();
  return new PayerAuthGuard(session, config, repo);
}

/**
 * The principal the `@CurrentPayer` decorator injects = `req.payer`, which the guard
 * (and ONLY the guard) attaches. Reading it from the same `req` the guard mutated is
 * exactly what the decorator does at runtime — and proves the controller's only
 * `payerId` input is the guard-derived one (no request-supplied id path exists).
 */
function currentPayerOf(req: GuardReq): AuthenticatedPayer {
  if (!req.payer) throw new UnauthorizedException("guard did not attach a payer");
  return req.payer;
}

describe("PayerAccountController — horizontal-authz / IDOR (ADR-0019 C / LC-1)", () => {
  it("payer A's token reads ONLY payer A's account (req carries no id to vary)", async () => {
    const guard = guardFor(PAYER_A);
    const { ctx, req } = makeGuardCtx("Bearer payerA.token");
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    // role resolves via the ADR-0022 fallback from the (employer) payers row.
    expect(req.payer).toEqual({ id: PAYER_A, sid: "sid", role: "employer" });

    const { repo, findById } = makeRepo();
    const controller = new PayerAccountController(new PayerAccountService(repo));
    const result = await controller.me(currentPayerOf(req));

    expect(findById).toHaveBeenCalledExactlyOnceWith(PAYER_A);
    expect(result.id).toBe(PAYER_A);
    expect(result.orgName).toBe(`Org-${PAYER_A.slice(0, 4)}`);
  });

  it("payer B's token can NEVER read payer A — it reads B's own row only", async () => {
    const guard = guardFor(PAYER_B);
    const { ctx, req } = makeGuardCtx("Bearer payerB.token");
    await guard.canActivate(ctx);

    const { repo, findById } = makeRepo();
    const controller = new PayerAccountController(new PayerAccountService(repo));
    const result = await controller.me(currentPayerOf(req));

    // The only id reaching the repo is B's (from the guard) — A is unreachable.
    expect(findById).toHaveBeenCalledExactlyOnceWith(PAYER_B);
    expect(findById).not.toHaveBeenCalledWith(PAYER_A);
    expect(result.id).toBe(PAYER_B);
  });

  it("an absent token → 401 at the guard (route never executes)", async () => {
    const guard = guardFor(PAYER_A);
    await expect(guard.canActivate(makeGuardCtx(undefined).ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it("a forged / tampered token (session rejects) → 401, no row is read", async () => {
    const guard = guardFor(null); // validateAndTouch → null (bad/worker/tampered token)
    const { ctx } = makeGuardCtx("Bearer forged.token");
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("a valid session whose payer row is gone → neutral 404 (no oracle)", async () => {
    const guard = guardFor("99999999-9999-4999-8999-999999999999");
    const { ctx, req } = makeGuardCtx("Bearer ghost.token");
    await guard.canActivate(ctx);

    const { repo } = makeRepo(); // findById returns undefined for the unknown id
    const controller = new PayerAccountController(new PayerAccountService(repo));
    await expect(controller.me(currentPayerOf(req))).rejects.toBeInstanceOf(NotFoundException);
  });
});
