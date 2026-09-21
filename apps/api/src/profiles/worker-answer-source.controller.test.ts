import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { BadRequestException, NotFoundException, RequestMethod } from "@nestjs/common";
import { METHOD_METADATA, PATH_METADATA, ROUTE_ARGS_METADATA } from "@nestjs/common/constants";

import { WorkerAnswerSourceController } from "./worker-answer-source.controller";
import type { WorkerAnswerSourceService } from "./worker-answer-source.service";
import {
  DECLINABLE_ATTRIBUTE_KEYS,
  DeclinableAttributeKeySchema,
  SetAnswerTextSourceSchema,
  type DeclinableAttributeKey,
  type SetAnswerTextSourceDto,
} from "./worker-answer-source.dto";
import { WorkerAuthGuard, type AuthenticatedWorker } from "../auth/worker-auth.guard";
import { ConsentGuard } from "../auth/consent.guard";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import type { RequestContext } from "../common/request-context";

/**
 * `PUT /workers/me/answers/:attributeKey/text-source` (#1485) — the worker's refusal of a model's
 * rewrite of his own ITI project sentence.
 *
 * The handler is two lines and the decision it records lives in the service and the repository. What
 * is asserted here is everything the two lines CANNOT be trusted to have got right by inspection,
 * because every one of them fails silently:
 *
 *   - WHOSE answer is written. The worker comes from the token; the body and the path have no say.
 *   - WHAT may be addressed. `:attributeKey` is the only client-supplied value that names a row, and
 *     it is allow-listed, not shape-checked — see the pipe block below for why the difference is the
 *     whole security posture of the route.
 *   - THE GUARD ORDER. `guard-contract.test.ts` pins the guard SET (it sorts, and unions class with
 *     method), so the order — the load-bearing half — is pinned nowhere but here.
 *   - WHAT COMES BACK. A count, and never either version of the sentence.
 */

/** 400 if the pipe refused, `"accepted"` if it let the value through — so a pass cannot read as a 400. */
function statusOf(run: () => unknown): number | string {
  try {
    run();
    return "accepted";
  } catch (err) {
    if (err instanceof BadRequestException) return err.getStatus();
    return `threw ${(err as Error)?.constructor?.name ?? "unknown"}`;
  }
}

const WORKER: AuthenticatedWorker = { id: "w-1", sid: "s-1" };
const OTHER_WORKER_ID = "99999999-9999-9999-9999-999999999999";
const CTX: RequestContext = { requestId: "r-1", correlationId: "c-1" };
const KEY: DeclinableAttributeKey = "iti_project_work";

interface Outcome {
  /** What the service resolves with. Typed loosely so a GROWN return value can be simulated. */
  readonly result?: Record<string, unknown> & { answers_updated: number };
  /** What the service throws instead — the 404-on-zero-rows path. */
  readonly fail?: Error;
}

function make(outcome: Outcome = {}) {
  const resolved = outcome.result ?? { answers_updated: 1 };
  const answers = {
    // Every parameter is typed: `vi.fn(async () => x)` infers a zero-arg signature and the
    // `mock.calls[0]![2]` reads below would then fail `tsc` while the test passed.
    setTextSource: vi.fn(
      async (
        _workerId: string,
        _attributeKey: DeclinableAttributeKey,
        _dto: SetAnswerTextSourceDto,
        _ctx: RequestContext,
      ): Promise<{ answers_updated: number }> => {
        if (outcome.fail) throw outcome.fail;
        return resolved;
      },
    ),
  };
  const controller = new WorkerAnswerSourceController(
    answers as unknown as WorkerAnswerSourceService,
  );
  return { controller, answers };
}

describe("WorkerAnswerSourceController — thin delegation", () => {
  it("passes the token worker, the validated key, the dto and the ctx through unchanged", async () => {
    const { controller, answers } = make();
    const dto: SetAnswerTextSourceDto = { source: "own_words" };

    await controller.setAnswerTextSource(WORKER, KEY, dto, CTX);

    expect(answers.setTextSource).toHaveBeenCalledTimes(1);
    expect(answers.setTextSource).toHaveBeenCalledWith(WORKER.id, KEY, dto, CTX);
    // The dto is handed over as-is, not rebuilt: the service reads `source` to decide `declined`,
    // and a handler that re-derived it would be a second place the refusal could be inverted.
    expect(answers.setTextSource.mock.calls[0]![2]).toBe(dto);
  });

  it("takes the worker id from the TOKEN even when the body carries one", async () => {
    // `SetAnswerTextSourceSchema` is `.strict()` so a `worker_id` key cannot reach a live handler
    // today — which is exactly why this is asserted at the handler too. The strictness and the
    // identity source are independent decisions, and relaxing the schema later must not quietly
    // turn this route into an IDOR on another worker's answer row.
    const { controller, answers } = make();

    await controller.setAnswerTextSource(
      WORKER,
      KEY,
      { source: "polished", worker_id: OTHER_WORKER_ID } as never,
      CTX,
    );

    expect(answers.setTextSource.mock.calls[0]![0]).toBe(WORKER.id);
    expect(JSON.stringify(answers.setTextSource.mock.calls[0]![0])).not.toContain(OTHER_WORKER_ID);
  });

  it("reads the worker off the argument, not a constant — a second worker reaches his own row", async () => {
    // The discriminating half of the assertion above. A handler that hardcoded or cached an id
    // would pass "takes it from the token" and fail here.
    const { controller, answers } = make();
    const second: AuthenticatedWorker = { id: "w-2", sid: "s-2" };

    await controller.setAnswerTextSource(WORKER, KEY, { source: "own_words" }, CTX);
    await controller.setAnswerTextSource(second, KEY, { source: "own_words" }, CTX);

    expect(answers.setTextSource.mock.calls.map((c) => c[0])).toEqual(["w-1", "w-2"]);
  });

  it("accepts exactly four arguments — a fifth would be a new client-supplied value", () => {
    // Arity survives refactors in a way a docstring does not. Adding `@Body('worker_id')` or a
    // second `@Param` changes it, and this fails before the route ships.
    expect(WorkerAnswerSourceController.prototype.setAnswerTextSource.length).toBe(4);
  });

  it("answers with the count and nothing else, and never echoes the sentence", async () => {
    const { controller } = make({ result: { answers_updated: 3 } });

    const res = await controller.setAnswerTextSource(WORKER, KEY, { source: "own_words" }, CTX);

    // An allow-list, not a field-by-field check: the premise of this route is that one of the two
    // sentences may be false, so a response that GROWS a `value_text` / `value_text_polished`
    // field has to fail here rather than be noticed on an employer's screen.
    expect(res).toEqual({ ok: true, answers_updated: 3 });
  });

  it("drops anything EXTRA the service returns — the response is rebuilt, not forwarded", async () => {
    // The discriminating case for the allow-list above: it proves `toEqual` is guarding a handler
    // that constructs its own object, not one that happens to be fed a two-key result today.
    const { controller } = make({
      result: { answers_updated: 1, value_text: "I made a shaft on the lathe", declined: true },
    });

    const res = await controller.setAnswerTextSource(WORKER, KEY, { source: "own_words" }, CTX);

    expect(res).toEqual({ ok: true, answers_updated: 1 });
    expect(JSON.stringify(res)).not.toContain("lathe");
  });

  it("lets the service's 404 through untouched — the handler adds no existence oracle", async () => {
    // Zero updated rows means "not this worker's answer" and "nobody's answer" indistinguishably.
    // A handler that caught this and answered `{ ok: true, answers_updated: 0 }` would turn a
    // deliberate non-answer into a 200 and tell a client the row was absent rather than unowned.
    const { controller } = make({ fail: new NotFoundException(`Answer ${KEY} not found`) });

    await expect(
      controller.setAnswerTextSource(WORKER, KEY, { source: "own_words" }, CTX),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("WorkerAnswerSourceController — guards, in order", () => {
  it("is guarded [WorkerAuthGuard, ConsentGuard] IN THAT ORDER", () => {
    // Not cosmetic. `ConsentGuard.canActivate` reads `req.worker`, which `WorkerAuthGuard` attaches;
    // reversed, consent runs first, finds no worker and throws 401 — so every consented worker gets
    // a 401 on a route he is entitled to, and an unauthenticated caller gets the same 401 he always
    // got. The bug is invisible to any test that asserts the guard SET, which is what
    // `guard-contract.test.ts` does (it sorts and de-dupes).
    const guards = (Reflect.getMetadata(
      "__guards__",
      WorkerAnswerSourceController.prototype.setAnswerTextSource,
    ) ?? []) as unknown[];

    expect(guards).toEqual([WorkerAuthGuard, ConsentGuard]);
  });

  it("carries NO class-level guards, so the handler metadata is the whole protection", () => {
    // Stated so the assertion above is known to be the only one that matters. If a class-level
    // `@UseGuards` is ever added, Nest runs class guards BEFORE method guards and the effective
    // order is no longer the list read above — this test is the tripwire for that.
    const classGuards = (Reflect.getMetadata("__guards__", WorkerAnswerSourceController) ??
      []) as unknown[];
    expect(classGuards).toEqual([]);
  });
});

describe("WorkerAnswerSourceController — route shape", () => {
  it("mounts PUT workers/me/answers/:attributeKey/text-source", () => {
    expect(Reflect.getMetadata(PATH_METADATA, WorkerAnswerSourceController)).toBe("workers");
    const path = Reflect.getMetadata(
      PATH_METADATA,
      WorkerAnswerSourceController.prototype.setAnswerTextSource,
    ) as string;
    expect(path).toBe("me/answers/:attributeKey/text-source");
    expect(
      Reflect.getMetadata(
        METHOD_METADATA,
        WorkerAnswerSourceController.prototype.setAnswerTextSource,
      ),
    ).toBe(RequestMethod.PUT);

    // NO WORKER ID IN THE PATH. `me` is resolved from the token, so there is no route shape that
    // could address another worker's answer even before the guards and the UPDATE's predicates.
    expect(path).not.toMatch(/worker/i);
  });

  it("answers 200, not 201 — setting the choice twice creates nothing", () => {
    // PUT of a state the worker re-sets: sending `own_words` again must mean what sending it once
    // meant, and a 201 would tell every client and proxy that a second send made a second thing.
    expect(
      Reflect.getMetadata(
        "__httpCode__",
        WorkerAnswerSourceController.prototype.setAnswerTextSource,
      ),
    ).toBe(200);
  });

  it("wires the allow-list and the strict body schema onto the params themselves", () => {
    // Without this, the pipe blocks below would be testing two schemas that merely EXIST. The
    // route's narrowness comes from these two objects being mounted on `:attributeKey` and the
    // body; a `@Param('attributeKey')` that lost its pipe would accept any string and still pass
    // every other test in this file.
    const args = (Reflect.getMetadata(
      ROUTE_ARGS_METADATA,
      WorkerAnswerSourceController,
      "setAnswerTextSource",
    ) ?? {}) as Record<string, { pipes?: unknown[] }>;
    const schemas = Object.values(args).flatMap((arg) =>
      (arg.pipes ?? []).map((pipe) => (pipe as { schema?: unknown }).schema),
    );

    expect(schemas).toContain(DeclinableAttributeKeySchema);
    expect(schemas).toContain(SetAnswerTextSourceSchema);
  });
});

/**
 * The `:attributeKey` ALLOW-LIST, exercised through the pipe the route actually mounts.
 *
 * WHY A SHAPE CHECK WOULD NOT HAVE BEEN ENOUGH — and this is the fail-closed half of the route, not
 * an input-hygiene detail. `^[a-z_]+$` accepts `employer_name`, `turning_machine`, `iti_trade`,
 * every pack answer key there is. The route would then have been a generic "set a flag on any
 * attribute row of mine" surface: reachable for keys no rewrite exists for (the flag means nothing
 * there, so it would sit in the column waiting for a future reader to give it a second meaning),
 * and reachable for the keys where a rewrite must NEVER be offered — every other worker-typed value
 * that reaches the sheet is a proper noun or a job title, and rephrasing one renames his employer or
 * promotes him from operator.
 *
 * The CHECK constraint and the repository's `value_kind = 'text'` predicate keep the DATA honest
 * whatever arrives. The allow-list is what keeps the API CONTRACT one sentence wide.
 */
describe("the :attributeKey pipe — a closed set, not a slug shape", () => {
  const pipe = new ZodValidationPipe(DeclinableAttributeKeySchema);

  it("accepts iti_project_work and returns it unchanged", () => {
    expect(pipe.transform("iti_project_work")).toBe("iti_project_work");
  });

  it("accepts every key in the allow-list, and the list is one key wide today", () => {
    // The positive half, driven off the list itself so a key added to the constant without a
    // renderer that honours it is at least visible in this diff.
    for (const key of DECLINABLE_ATTRIBUTE_KEYS) expect(pipe.transform(key)).toBe(key);
    expect([...DECLINABLE_ATTRIBUTE_KEYS]).toEqual(["iti_project_work"]);
  });

  it.each([
    ["employer_name", "a proper noun — rephrasing it renames his employer"],
    ["turning_machine", "a pack answer no model may restate"],
    ["iti_trade", "his trade, not his sentence about it"],
    ["full_name", "his name"],
    ["iti_project_work_extra", "a prefix of the allowed key is not the allowed key"],
    ["ITI_PROJECT_WORK", "case is not normalised away"],
    ["iti project work", "spaces are not slugs"],
    ["", "an empty segment"],
  ])("400s on %s (%s) — slug-shaped is not the test", (key) => {
    expect(statusOf(() => pipe.transform(key))).toBe(400);
  });

  it.each([
    "../../employer_name",
    "..%2Fiti_project_work",
    "iti_project_work/../employer_name",
    "iti_project_work\u0000",
  ])("400s on path junk (%s)", (key) => {
    expect(statusOf(() => pipe.transform(key))).toBe(400);
  });

  it("400s on a non-string param", () => {
    // Express always hands a string, so this is a guard against a future caller of the same pipe
    // and against an array-shaped param sneaking through a parser change.
    for (const key of [null, undefined, 7, ["iti_project_work"], { key: "iti_project_work" }]) {
      expect(statusOf(() => pipe.transform(key))).toBe(400);
    }
  });
});

/**
 * The BODY schema. `.strict()` is the point: this route's entire vocabulary is one field with two
 * values, and an unknown key is a client that believes it is saying something this route will act on.
 */
describe("the body pipe — one field, two values, nothing else", () => {
  const pipe = new ZodValidationPipe(SetAnswerTextSourceSchema);

  it("accepts both sources and strips nothing from them", () => {
    expect(pipe.transform({ source: "own_words" })).toEqual({ source: "own_words" });
    expect(pipe.transform({ source: "polished" })).toEqual({ source: "polished" });
  });

  it("400s on an UNKNOWN extra field rather than ignoring it", () => {
    // `.strict()`, not `.passthrough()`. A client sending `{ source: 'polished', declined: true }`
    // is contradicting itself; silently honouring `source` and dropping the rest would record the
    // opposite of what that client meant about the one sentence an employer reads.
    expect(statusOf(() => pipe.transform({ source: "own_words", declined: false }))).toBe(400);
    expect(statusOf(() => pipe.transform({ source: "polished", worker_id: OTHER_WORKER_ID }))).toBe(
      400,
    );
    expect(
      statusOf(() => pipe.transform({ source: "own_words", attribute_key: "employer_name" })),
    ).toBe(400);
  });

  it("400s on a missing or unknown source", () => {
    for (const body of [
      {},
      { source: "" },
      { source: null },
      { source: "OWN_WORDS" },
      { source: "original" },
      { source: "raw" },
      { source: "own words" },
      { source: true },
      { source: ["own_words"] },
    ]) {
      expect(statusOf(() => pipe.transform(body))).toBe(400);
    }
  });

  it("400s on a body that is not an object at all", () => {
    for (const body of [null, undefined, "own_words", 1, ["own_words"]]) {
      expect(statusOf(() => pipe.transform(body))).toBe(400);
    }
  });
});
