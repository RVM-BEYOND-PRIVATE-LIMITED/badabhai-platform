import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BadRequestException,
  HttpException,
  HttpStatus,
  NotFoundException,
  ParseUUIDPipe,
  RequestMethod,
} from "@nestjs/common";
import {
  GUARDS_METADATA,
  HEADERS_METADATA,
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
  ROUTE_ARGS_METADATA,
} from "@nestjs/common/constants";
import { RouteParamtypes } from "@nestjs/common/enums/route-paramtypes.enum";
import type { ServerConfig } from "@badabhai/config";
import type { RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { PayerAuthGuard, type AuthenticatedPayer } from "../payers/payer-auth.guard";
import { PayerUnlockOutcomesController } from "./payer-unlock-outcomes.controller";
import { UnlockFollowupEnabledGuard, unlockFollowupEnabled } from "./unlock-outcomes.flag";
import {
  DUE_DEFAULT_LIMIT,
  DueUnlocksQuerySchema,
  RecordUnlockOutcomeSchema,
  encodeDueCursor,
  type DueUnlocksPageDto,
  type RecordUnlockOutcomeResponseDto,
} from "./unlock-outcomes.dto";

const PAYER: AuthenticatedPayer = {
  id: "aaaaaaaa-0000-4000-8000-000000000001",
  sid: "sid-a",
  role: "employer",
};
const CTX: RequestContext = {
  correlationId: "22222222-2222-4222-8222-222222222222",
  requestId: "req-1",
};
const UNLOCK = "0a000000-0000-4000-8000-000000000001";
const WORKER = "33333333-3333-4333-8333-000000000001";

const req = (key?: string) =>
  ({
    header: (n: string) => (n.toLowerCase() === "idempotency-key" ? key : undefined),
  }) as never;

function makeCtrl() {
  const answer: RecordUnlockOutcomeResponseDto = {
    unlock_id: UNLOCK,
    worker_id: WORKER,
    outcome: "hired",
    previous_outcome: null,
    answered_at: "2026-11-16T04:00:00.000Z",
    changed: true,
  };
  const page: DueUnlocksPageDto = { items: [], nextCursor: null };
  const outcomes = {
    recordCompanyOutcome: vi.fn(async () => answer),
    listDue: vi.fn(async () => page),
  };
  const rateLimit = { assertWithinHourlyCap: vi.fn(async () => undefined) };
  // runOnce with no stored outcome runs the work unchanged; the seam itself has its own suite.
  const idempotency = {
    runOnce: vi.fn(async (o: { work: () => Promise<unknown> }) => o.work()),
  };
  const config = { PAYER_UNLOCK_OUTCOME_MAX_PER_HOUR: 600 } as unknown as ServerConfig;
  const ctrl = new PayerUnlockOutcomesController(
    outcomes as never,
    rateLimit as never,
    idempotency as never,
    config,
  );
  return { ctrl, outcomes, rateLimit, idempotency, answer, page };
}

/**
 * The follow-up routes at the HTTP boundary. Ownership, the upsert, the event and the hire link are
 * proven in unlock-outcomes.service.test.ts; this file pins that the controller is HTTP-only — the
 * switch guard after the auth guard, the strict body (no `not_reached`), the write cap FIRST on its
 * own bucket, Idempotency-Key scoped to the session payer, then one delegation.
 */
describe("PayerUnlockOutcomesController — routes and guards", () => {
  it("POST payer/unlocks/:unlockId/outcome answers 200", () => {
    const handler = PayerUnlockOutcomesController.prototype.recordOutcome;
    expect(Reflect.getMetadata(PATH_METADATA, PayerUnlockOutcomesController)).toBe("payer");
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe("unlocks/:unlockId/outcome");
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(200);
  });

  it("GET payer/unlock-outcomes/due, sent no-store", () => {
    const handler = PayerUnlockOutcomesController.prototype.listDue;
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe("unlock-outcomes/due");
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata(HEADERS_METADATA, handler)).toEqual([
      { name: "Cache-Control", value: "no-store" },
    ]);
  });

  it("guards: PayerAuthGuard FIRST (401 before anything), then the switch (404 while off)", () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, PayerUnlockOutcomesController)).toEqual([
      PayerAuthGuard,
      UnlockFollowupEnabledGuard,
    ]);
    // No method adds or replaces a guard.
    for (const m of ["recordOutcome", "listDue"] as const) {
      expect(
        Reflect.getMetadata(GUARDS_METADATA, PayerUnlockOutcomesController.prototype[m]),
      ).toBeUndefined();
    }
  });

  it("takes no data-access dependency: service + cap + idempotency + config only", () => {
    expect(PayerUnlockOutcomesController.length).toBe(4);
  });
});

describe("POST …/outcome — cap, idempotency, delegation", () => {
  let d: ReturnType<typeof makeCtrl>;
  beforeEach(() => {
    d = makeCtrl();
  });

  it("delegates with the SESSION payer, the route's unlock id and the body's outcome", async () => {
    await expect(
      d.ctrl.recordOutcome(UNLOCK, { outcome: "hired" }, PAYER, req(), CTX),
    ).resolves.toBe(d.answer);
    expect(d.outcomes.recordCompanyOutcome).toHaveBeenCalledWith(PAYER.id, UNLOCK, "hired", CTX);
  });

  it("charges its OWN bucket (payer_unlock_outcome) at PAYER_UNLOCK_OUTCOME_MAX_PER_HOUR, BEFORE anything", async () => {
    await d.ctrl.recordOutcome(UNLOCK, { outcome: "not_hired" }, PAYER, req("k-1"), CTX);
    expect(d.rateLimit.assertWithinHourlyCap).toHaveBeenCalledOnce();
    expect(d.rateLimit.assertWithinHourlyCap).toHaveBeenCalledWith(PAYER.id, {
      scope: "payer_unlock_outcome",
      cap: 600,
    });
    const capAt = d.rateLimit.assertWithinHourlyCap.mock.invocationCallOrder[0]!;
    expect(capAt).toBeLessThan(d.idempotency.runOnce.mock.invocationCallOrder[0]!);
    expect(capAt).toBeLessThan(d.outcomes.recordCompanyOutcome.mock.invocationCallOrder[0]!);
  });

  it("a tripped cap (or Redis down, the same 429) blocks the answer entirely", async () => {
    d.rateLimit.assertWithinHourlyCap.mockRejectedValueOnce(
      new HttpException("Too many requests; please try again later", HttpStatus.TOO_MANY_REQUESTS),
    );
    await expect(
      d.ctrl.recordOutcome(UNLOCK, { outcome: "hired" }, PAYER, req("k-1"), CTX),
    ).rejects.toMatchObject({ status: 429 });
    expect(d.idempotency.runOnce).not.toHaveBeenCalled();
    expect(d.outcomes.recordCompanyOutcome).not.toHaveBeenCalled();
  });

  it("runs under Idempotency-Key: payer_idem / its own scope / the SESSION payer, 409 in flight", async () => {
    await d.ctrl.recordOutcome(UNLOCK, { outcome: "hired" }, PAYER, req("key-123"), CTX);
    const opts = d.idempotency.runOnce.mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(opts).toMatchObject({
      namespace: "payer_idem",
      scope: "unlock_outcome",
      subject: PAYER.id,
      subjectLabel: "payer",
      logLabel: "payer",
      idempotencyKey: "key-123",
    });
    expect(opts.secret).toBeUndefined();
    let thrown: unknown;
    try {
      (opts.inFlight as () => unknown)();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(HttpException);
    expect((thrown as HttpException).getStatus()).toBe(409);
    expect((thrown as HttpException).getResponse()).toMatchObject({ reason: "in_flight" });
  });

  it("no key: the work still runs once (the seam runs it unguarded)", async () => {
    await d.ctrl.recordOutcome(UNLOCK, { outcome: "still_talking" }, PAYER, req(), CTX);
    expect(
      (d.idempotency.runOnce.mock.calls[0]![0] as unknown as { idempotencyKey?: string })
        .idempotencyKey,
    ).toBeUndefined();
    expect(d.outcomes.recordCompanyOutcome).toHaveBeenCalledOnce();
  });

  it("passes the neutral 404 through unchanged", async () => {
    d.outcomes.recordCompanyOutcome.mockRejectedValueOnce(new NotFoundException());
    await expect(
      d.ctrl.recordOutcome(UNLOCK, { outcome: "hired" }, PAYER, req(), CTX),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("GET …/due — delegation", () => {
  it("delegates with the SESSION payer id and the parsed query, and returns the page verbatim", async () => {
    const d = makeCtrl();
    const query = { limit: 20 };
    await expect(d.ctrl.listDue(query as never, PAYER)).resolves.toBe(d.page);
    expect(d.outcomes.listDue).toHaveBeenCalledWith(PAYER.id, query);
    // A read: no write cap and no idempotency.
    expect(d.rateLimit.assertWithinHourlyCap).not.toHaveBeenCalled();
    expect(d.idempotency.runOnce).not.toHaveBeenCalled();
  });
});

describe("UnlockFollowupEnabledGuard + unlockFollowupEnabled — the one switch read", () => {
  it("off (false / unset) → the bare Nest 404; on → passes", () => {
    for (const value of [false, undefined]) {
      const guard = new UnlockFollowupEnabledGuard({ UNLOCK_FOLLOWUP_ENABLED: value as boolean });
      let thrown: unknown;
      try {
        guard.canActivate();
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(NotFoundException);
      expect((thrown as NotFoundException).getResponse()).toEqual(
        new NotFoundException().getResponse(),
      );
    }
    expect(new UnlockFollowupEnabledGuard({ UNLOCK_FOLLOWUP_ENABLED: true }).canActivate()).toBe(
      true,
    );
  });

  it("only a literal true turns it on", () => {
    expect(unlockFollowupEnabled({ UNLOCK_FOLLOWUP_ENABLED: true })).toBe(true);
    expect(unlockFollowupEnabled({ UNLOCK_FOLLOWUP_ENABLED: false })).toBe(false);
    expect(unlockFollowupEnabled(undefined)).toBe(false);
    expect(unlockFollowupEnabled({} as never)).toBe(false);
    expect(unlockFollowupEnabled({ UNLOCK_FOLLOWUP_ENABLED: "true" } as never)).toBe(false);
  });
});

describe("validation (the pipes the decorators run)", () => {
  const body = new ZodValidationPipe(RecordUnlockOutcomeSchema);
  const query = new ZodValidationPipe(DueUnlocksQuerySchema);

  it("the body takes exactly the three company answers", () => {
    for (const outcome of ["hired", "not_hired", "still_talking"]) {
      expect(body.transform({ outcome })).toEqual({ outcome });
    }
  });

  it.each([
    [{ outcome: "not_reached" }],
    [{}],
    [{ outcome: "Hired" }],
    [{ outcome: null }],
    [{ outcome: "hired", payer_id: PAYER.id }],
    [{ outcome: "hired", worker_id: WORKER }],
    [{ outcome: "hired", answered_by: "desk" }],
    [{ outcome: "hired", note: "joined monday" }],
  ])("anything else is a 400 — not_reached is the desk's (%j)", (bad) => {
    expect(() => body.transform(bad)).toThrow(BadRequestException);
  });

  it("the due query: limit 1-50 (default 20), a minted cursor, nothing else", () => {
    expect(query.transform({})).toEqual({ limit: DUE_DEFAULT_LIMIT });
    expect(query.transform({ limit: "50", cursor: "" })).toEqual({ limit: 50 });
    const cursor = encodeDueCursor({
      grantedKey: "2026-11-01T04:00:00.123456Z",
      unlockId: UNLOCK,
    });
    expect(query.transform({ cursor })).toEqual({
      limit: DUE_DEFAULT_LIMIT,
      cursor: { grantedKey: "2026-11-01T04:00:00.123456Z", unlockId: UNLOCK },
    });
    for (const bad of [
      { limit: "0" },
      { limit: "51" },
      { cursor: "not!base64" },
      { cursor: Buffer.from('{"v":2}').toString("base64url") },
      { payer_id: PAYER.id },
    ]) {
      expect(() => query.transform(bad), JSON.stringify(bad)).toThrow(BadRequestException);
    }
  });

  /** The pipes Nest runs for one handler argument of `type`. */
  function pipesFor(method: string, type: RouteParamtypes): unknown[] {
    const args = Reflect.getMetadata(
      ROUTE_ARGS_METADATA,
      PayerUnlockOutcomesController,
      method,
    ) as Record<string, { pipes: unknown[] }>;
    const entries = Object.entries(args).filter(([k]) => k.startsWith(`${type}:`));
    expect(entries, `exactly one ${RouteParamtypes[type]} argument`).toHaveLength(1);
    return entries[0]![1].pipes;
  }

  it("the decorators are WIRED: ParseUUIDPipe on the id, the strict body, the strict query", () => {
    expect(pipesFor("recordOutcome", RouteParamtypes.PARAM)[0]).toBeInstanceOf(ParseUUIDPipe);
    const bodyPipe = pipesFor("recordOutcome", RouteParamtypes.BODY)[0];
    expect(bodyPipe).toBeInstanceOf(ZodValidationPipe);
    expect(Reflect.get(bodyPipe as object, "schema")).toBe(RecordUnlockOutcomeSchema);
    const queryPipe = pipesFor("listDue", RouteParamtypes.QUERY)[0];
    expect(queryPipe).toBeInstanceOf(ZodValidationPipe);
    expect(Reflect.get(queryPipe as object, "schema")).toBe(DueUnlocksQuerySchema);
  });
});
