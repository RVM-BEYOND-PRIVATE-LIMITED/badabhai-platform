import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import {
  BadRequestException,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
  type ExecutionContext,
} from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import type { Payer } from "@badabhai/db";
import type { RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { PayerAuthGuard, type AuthenticatedPayer } from "./payer-auth.guard";
import type { PayerSessionService } from "./payer-session.service";
import { PayerAccountController } from "./payer-account.controller";
import { PayerAccountService } from "./payer-account.service";
import { PayerUpdateSchema, type PayerUpdateDto } from "./payer-account.dto";
import type { EventsService } from "../events/events.service";
import type { PayerContact, PayersRepository } from "./payers.repository";

/** A no-op EventsService stub for the read-only PROF-1 describes (no event is emitted there). */
function noopEvents(): EventsService {
  return { emit: vi.fn(async () => undefined) } as unknown as EventsService;
}

const CTX: RequestContext = { requestId: "req-1", correlationId: "corr-1" };

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
    const controller = new PayerAccountController(new PayerAccountService(repo, noopEvents()));
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
    const controller = new PayerAccountController(new PayerAccountService(repo, noopEvents()));
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
    const controller = new PayerAccountController(new PayerAccountService(repo, noopEvents()));
    await expect(controller.me(currentPayerOf(req))).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("PayerAccountController — own contact on GET /payer/me (PROF-1)", () => {
  const SELF: AuthenticatedPayer = { id: PAYER_A, sid: "sid", role: "employer" };

  /** A controller whose repo decrypts to `contact` for the self id (or throws on decrypt). */
  function controllerWith(
    contact: Partial<PayerContact>,
    opts?: { decryptThrows?: boolean },
  ): PayerAccountController {
    const findById = vi.fn(async () => rowFor(PAYER_A));
    const decryptContact = vi.fn((): PayerContact => {
      if (opts?.decryptThrows) throw new Error("gcm auth failed");
      return {
        id: PAYER_A,
        role: contact.role ?? "employer",
        status: contact.status ?? "active",
        email: contact.email ?? "owner@self.example",
        orgName: contact.orgName ?? "Org",
        phone: contact.phone ?? null,
      };
    });
    const repo = { findById, decryptContact } as unknown as PayersRepository;
    return new PayerAccountController(new PayerAccountService(repo, noopEvents()));
  }

  it("returns the caller's OWN decrypted email and a MASKED phoneLast4", async () => {
    const result = await controllerWith({
      email: "boss@acme.example",
      phone: "+91 98765 43210",
    }).me(SELF);
    expect(result.email).toBe("boss@acme.example");
    expect(result.phoneLast4).toBe("3210");
  });

  it("returns phoneLast4 = null when the payer has no phone on file", async () => {
    const result = await controllerWith({ phone: null }).me(SELF);
    expect(result.phoneLast4).toBeNull();
  });

  it("NEVER returns the full phone number — only the last 4 digits", async () => {
    const result = await controllerWith({ phone: "+919876543210" }).me(SELF);
    const json = JSON.stringify(result);
    expect(json).not.toContain("9876543210");
    expect(json).not.toContain("987654");
    expect(result.phoneLast4).toBe("3210");
  });

  it("fails CLOSED on a decrypt error — generic 500, never surfaces ciphertext", async () => {
    await expect(controllerWith({}, { decryptThrows: true }).me(SELF)).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });

  it("a pending/suspended payer still gets their OWN contact (status is not a gate here)", async () => {
    const result = await controllerWith({ status: "pending", email: "new@acme.example" }).me(SELF);
    expect(result.status).toBe("pending");
    expect(result.email).toBe("new@acme.example");
  });

  it("never logs the raw email or phone while serving the read (no-PII regression)", async () => {
    const sink: string[] = [];
    const methods = ["log", "info", "warn", "error", "debug"] as const;
    const spies = methods.map((m) =>
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
        sink.push(args.map(String).join(" "));
      }),
    );
    await controllerWith({ email: "boss@acme.example", phone: "+919876543210" }).me(SELF);
    const logged = sink.join(" ");
    expect(logged).not.toContain("boss@acme.example");
    expect(logged).not.toContain("9876543210");
    spies.forEach((s) => s.mockRestore());
  });
});

/**
 * PROF-3 — self-edit on `PATCH /payer/me`. Proves:
 *   - a partial update encrypts only the present fields (org/phone), refreshing phoneHash
 *     when phone changes, and returns the freshly-MASKED DTO;
 *   - the `payer.account_updated` event is PII-FREE: `{ payer_id, changed_fields }`, KEYS
 *     only — never the new org-name/phone VALUES;
 *   - the body cannot carry an id/email/role/status or any unknown key (`.strict()` → 400),
 *     an empty body is a 400, and an invalid phone is a 400;
 *   - the write binds to the GUARD principal id (a body `payer_id` is ignored / rejected);
 *   - no raw org-name/phone is ever logged across the update path.
 */
describe("PayerAccountController — self-edit on PATCH /payer/me (PROF-3)", () => {
  const SELF: AuthenticatedPayer = { id: PAYER_A, sid: "sid", role: "employer" };

  /**
   * A repo stub whose `update` records its args and returns a row whose decrypted contact
   * reflects the patch (so the returned DTO can be asserted). `encrypt`/`hashPhone` are spied
   * so we can prove they ran on the NEW values. The decrypted org/phone echo the patch.
   */
  function makeUpdateRepo(current?: { orgName?: string; phone?: string | null }) {
    const encrypt = vi.fn((v: string) => `enc(${v})`);
    const hashPhone = vi.fn((v: string) => `phash(${v})`);
    let stored = {
      orgName: current?.orgName ?? "Old Org",
      phone: current?.phone ?? null,
    } as { orgName: string; phone: string | null };

    const update = vi.fn(async (_id: string, patch: { orgName?: string; phone?: string }) => {
      if (patch.orgName !== undefined) encrypt(patch.orgName);
      if (patch.phone !== undefined) {
        encrypt(patch.phone);
        hashPhone(patch.phone);
      }
      stored = {
        orgName: patch.orgName ?? stored.orgName,
        phone: patch.phone ?? stored.phone,
      };
      return rowFor(_id);
    });

    const decryptContact = vi.fn(
      (row: Payer): PayerContact => ({
        id: row.id,
        role: row.role,
        status: row.status,
        email: "owner@self.example",
        orgName: stored.orgName,
        phone: stored.phone,
      }),
    );

    const repo = { update, decryptContact } as unknown as PayersRepository;
    return { repo, update, encrypt, hashPhone };
  }

  /** The single argument the service hands to `EventsService.emit` (the bit we assert). */
  interface EmittedEvent {
    event_name: string;
    subject: { subject_id?: string };
    payload: { payer_id: string; changed_fields: string[] };
  }

  /** A controller + the emit spy so we can assert the exact event payload. */
  function controllerWith(repo: PayersRepository) {
    const emit = vi.fn(async (_params: EmittedEvent) => undefined);
    const events = { emit } as unknown as EventsService;
    const controller = new PayerAccountController(new PayerAccountService(repo, events));
    return { controller, emit };
  }

  /** Run the body through the SAME ZodValidationPipe the @Body decorator applies at runtime. */
  function validate(body: unknown): PayerUpdateDto {
    return new ZodValidationPipe(PayerUpdateSchema).transform(body);
  }

  it("orgName-only update encrypts the new org and returns it (phone untouched)", async () => {
    const { repo, update, encrypt, hashPhone } = makeUpdateRepo({ phone: "+919999988888" });
    const { controller } = controllerWith(repo);

    const result = await controller.updateMe(SELF, validate({ orgName: "Acme Industries" }), CTX);

    expect(update).toHaveBeenCalledExactlyOnceWith(PAYER_A, { orgName: "Acme Industries" });
    expect(encrypt).toHaveBeenCalledWith("Acme Industries");
    expect(hashPhone).not.toHaveBeenCalled(); // phone not part of this patch
    expect(result.orgName).toBe("Acme Industries");
    expect(result.phoneLast4).toBe("8888"); // unchanged stored phone, masked
  });

  it("phone-only update re-encrypts AND refreshes the phoneHash on the NEW E.164", async () => {
    const { repo, update, encrypt, hashPhone } = makeUpdateRepo();
    const { controller } = controllerWith(repo);

    const result = await controller.updateMe(SELF, validate({ phone: "+919876543210" }), CTX);

    expect(update).toHaveBeenCalledExactlyOnceWith(PAYER_A, { phone: "+919876543210" });
    expect(encrypt).toHaveBeenCalledWith("+919876543210");
    expect(hashPhone).toHaveBeenCalledWith("+919876543210"); // lookup key kept in lockstep
    expect(result.phoneLast4).toBe("3210"); // masked — never the full number
    expect(JSON.stringify(result)).not.toContain("9876543210");
  });

  it("both fields → both encrypted + phoneHash refreshed; DTO reflects both", async () => {
    const { repo, encrypt, hashPhone } = makeUpdateRepo();
    const { controller } = controllerWith(repo);

    const result = await controller.updateMe(
      SELF,
      validate({ orgName: "BadaBhai Tools", phone: "+919812345678" }),
      CTX,
    );

    expect(encrypt).toHaveBeenCalledWith("BadaBhai Tools");
    expect(encrypt).toHaveBeenCalledWith("+919812345678");
    expect(hashPhone).toHaveBeenCalledWith("+919812345678");
    expect(result.orgName).toBe("BadaBhai Tools");
    expect(result.phoneLast4).toBe("5678");
  });

  it("emits payer.account_updated with KEYS ONLY — no org-name/phone VALUE in the payload", async () => {
    const { repo } = makeUpdateRepo();
    const { controller, emit } = controllerWith(repo);

    await controller.updateMe(
      SELF,
      validate({ orgName: "Secret Org Name", phone: "+919876543210" }),
      CTX,
    );

    expect(emit).toHaveBeenCalledTimes(1);
    const arg = emit.mock.calls[0]![0];
    expect(arg.event_name).toBe("payer.account_updated");
    // The payload is EXACTLY { payer_id, changed_fields } — field KEYS, never values.
    expect(arg.payload).toEqual({
      payer_id: PAYER_A,
      changed_fields: ["org_name", "phone"],
    });
    const payloadJson = JSON.stringify(arg.payload);
    expect(payloadJson).not.toContain("Secret Org Name");
    expect(payloadJson).not.toContain("9876543210");
  });

  it("changed_fields reflects ONLY the present keys (orgName-only → ['org_name'])", async () => {
    const { repo } = makeUpdateRepo();
    const { controller, emit } = controllerWith(repo);

    await controller.updateMe(SELF, validate({ orgName: "Just Org" }), CTX);

    const arg = emit.mock.calls[0]![0];
    expect(arg.payload.changed_fields).toEqual(["org_name"]);
  });

  it("rejects a body payer_id / email / role / status / unknown key (.strict() → 400)", () => {
    for (const body of [
      { payer_id: PAYER_B, orgName: "X1" },
      { email: "new@evil.example", orgName: "X2" },
      { role: "agent", orgName: "X3" },
      { status: "active", orgName: "X4" },
      { orgName: "X5", surprise: true },
    ]) {
      expect(() => validate(body)).toThrow(BadRequestException);
    }
  });

  it("rejects an empty body — 'nothing to update' (documented 400, no silent no-op)", () => {
    expect(() => validate({})).toThrow(BadRequestException);
  });

  it("rejects an invalid phone (not E.164) → 400 neutral field error", () => {
    for (const phone of ["98765", "+0123456789", "not-a-phone", "919876543210"]) {
      expect(() => validate({ phone })).toThrow(BadRequestException);
    }
  });

  it("rejects an orgName outside 2..120 graphemes (and counts emoji as one)", () => {
    expect(() => validate({ orgName: "a" })).toThrow(BadRequestException); // < 2
    expect(() => validate({ orgName: "x".repeat(121) })).toThrow(BadRequestException); // > 120
    // 120 emoji (each a surrogate pair) is exactly 120 by code-point count → OK, NOT > 120.
    expect(() => validate({ orgName: "😀".repeat(120) })).not.toThrow();
    // 121 emoji exceeds the grapheme cap even though .length would be 242.
    expect(() => validate({ orgName: "😀".repeat(121) })).toThrow(BadRequestException);
  });

  it("a body payer_id for ANOTHER payer is ignored — the write binds to the guard principal", async () => {
    // The body carries B's id; .strict() rejects it outright, but to PROVE the binding we
    // validate a clean body and confirm the WRITE uses A's principal id, never B's.
    const { repo, update } = makeUpdateRepo();
    const { controller } = controllerWith(repo);

    // Sanity: a body trying to smuggle payer_id is rejected before the service is reached.
    expect(() => validate({ payer_id: PAYER_B, orgName: "Evil" })).toThrow(BadRequestException);

    await controller.updateMe(SELF, validate({ orgName: "Clean" }), CTX);
    expect(update).toHaveBeenCalledExactlyOnceWith(PAYER_A, { orgName: "Clean" });
    expect(update).not.toHaveBeenCalledWith(PAYER_B, expect.anything());
  });

  it("a foreign/unknown principal id (no row) → neutral 404, no event emitted", async () => {
    const update = vi.fn(async () => undefined); // id matches no row
    const repo = { update } as unknown as PayersRepository;
    const { controller, emit } = controllerWith(repo);

    await expect(
      controller.updateMe(SELF, validate({ orgName: "Ghost" }), CTX),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(emit).not.toHaveBeenCalled(); // event-first: only AFTER a successful write
  });

  it("fails CLOSED on a decrypt error after write — generic 500, no ciphertext", async () => {
    const update = vi.fn(async () => rowFor(PAYER_A));
    const decryptContact = vi.fn(() => {
      throw new Error("gcm auth failed");
    });
    const repo = { update, decryptContact } as unknown as PayersRepository;
    const { controller } = controllerWith(repo);

    await expect(
      controller.updateMe(SELF, validate({ orgName: "Acme" }), CTX),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
  });

  it("never logs the raw org-name or phone across the update path (no-PII regression)", async () => {
    const { repo } = makeUpdateRepo();
    const { controller } = controllerWith(repo);

    const sink: string[] = [];
    const methods = ["log", "info", "warn", "error", "debug"] as const;
    const spies = methods.map((m) =>
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
        sink.push(args.map(String).join(" "));
      }),
    );
    await controller.updateMe(
      SELF,
      validate({ orgName: "Loud Org Name", phone: "+919876543210" }),
      CTX,
    );
    const logged = sink.join(" ");
    expect(logged).not.toContain("Loud Org Name");
    expect(logged).not.toContain("9876543210");
    spies.forEach((s) => s.mockRestore());
  });
});
