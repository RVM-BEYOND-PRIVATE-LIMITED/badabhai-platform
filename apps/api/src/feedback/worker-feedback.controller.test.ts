import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { BadRequestException, HttpException, HttpStatus } from "@nestjs/common";
import { WORKER_FEEDBACK_CATEGORIES, WORKER_FEEDBACK_MESSAGE_MAX } from "@badabhai/types";

import { WorkerFeedbackController } from "./worker-feedback.controller";
import { SubmitFeedbackSchema, type SubmitFeedbackDto } from "./feedback.dto";
import type { FeedbackService } from "./feedback.service";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import type { SubjectRateLimit } from "../common/rate-limit/subject-rate-limit.service";
import type { RequestContext } from "../common/request-context";

const WORKER = { id: "11111111-1111-4111-8111-111111111111", sid: "s" };
/** The worker a hostile body would try to file feedback as. */
const SOMEONE_ELSE = "99999999-9999-4999-8999-999999999999";
const CTX = { correlationId: "c", requestId: "r" } as RequestContext;
const PER_MINUTE = 3;
const PER_HOUR = 20;
const DTO: SubmitFeedbackDto = { message: "the app logs me out every morning" };

function make(opts: { overMinute?: boolean; overHour?: boolean } = {}) {
  /** The order the two caps were charged in — the assertion the 429 path depends on. */
  const charged: string[] = [];
  const feedback = {
    submit: vi.fn(async () => ({ id: "ffffffff-0000-4000-8000-000000000001" })),
  };
  const rateLimit = {
    assertWithinMinuteCap: vi.fn(async () => {
      charged.push("minute");
      if (opts.overMinute) throw new HttpException("Too many requests", 429);
    }),
    assertWithinHourlyCap: vi.fn(async () => {
      charged.push("hour");
      if (opts.overHour) throw new HttpException("Too many requests", 429);
    }),
  };
  const controller = new WorkerFeedbackController(
    feedback as unknown as FeedbackService,
    rateLimit as unknown as SubjectRateLimit,
    {
      WORKER_FEEDBACK_PER_MINUTE: PER_MINUTE,
      WORKER_FEEDBACK_PER_HOUR: PER_HOUR,
    } as never,
  );
  return { controller, feedback, rateLimit, charged };
}

describe("the worker's OWN feedback sink (#997)", () => {
  it("stamps the submitting worker from the TOKEN, never from the body", async () => {
    const { controller, feedback } = make();
    await controller.submit(WORKER as never, DTO, "abc1234", CTX);
    expect(feedback.submit).toHaveBeenCalledWith(
      WORKER.id,
      DTO,
      { appBuild: "abc1234", screenContext: null },
      CTX,
    );
  });

  it("REJECTS a body that carries a worker_id rather than ignoring it", () => {
    // Ignoring would be equally safe and much worse to reason about: a client could ship code
    // that believes it is filing feedback on someone else's behalf and never be told otherwise.
    // `.strict()` makes the contract legible at the first request instead of at a post-mortem.
    const parsed = SubmitFeedbackSchema.safeParse({ ...DTO, worker_id: SOMEONE_ELSE });
    expect(parsed.success).toBe(false);
  });

  it("answers exactly { ok: true } — nothing the worker typed comes back", async () => {
    // Not even the row id: the client ignores the body, and every extra field is one more copy
    // of a worker's own words (or a key into them) on a wire that did not need it.
    const { controller } = make();
    const res = await controller.submit(WORKER as never, DTO, undefined, CTX);
    expect(res).toEqual({ ok: true });
    expect(Object.keys(res)).toEqual(["ok"]);
  });
});

describe("the two caps on the feedback route", () => {
  it("charges the MINUTE bucket before the HOUR bucket", async () => {
    // Minute first so a refused burst never inflates the hourly counter it was refused by.
    // Reversed, a flood the minute rule would have stopped still costs an honest worker the
    // rest of their hour.
    const { controller, charged } = make();
    await controller.submit(WORKER as never, DTO, undefined, CTX);
    expect(charged).toEqual(["minute", "hour"]);
  });

  it("uses one scope for both buckets, with the configured caps", async () => {
    const { controller, rateLimit } = make();
    await controller.submit(WORKER as never, DTO, undefined, CTX);
    expect(rateLimit.assertWithinMinuteCap).toHaveBeenCalledWith(
      "worker_feedback",
      WORKER.id,
      PER_MINUTE,
    );
    expect(rateLimit.assertWithinHourlyCap).toHaveBeenCalledWith(
      "worker_feedback",
      WORKER.id,
      PER_HOUR,
    );
  });

  it("WRITES NOTHING when the minute cap rejects — and never reaches the hour bucket", async () => {
    const { controller, feedback, rateLimit } = make({ overMinute: true });
    await expect(controller.submit(WORKER as never, DTO, undefined, CTX)).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
    });
    expect(feedback.submit).not.toHaveBeenCalled();
    expect(rateLimit.assertWithinHourlyCap).not.toHaveBeenCalled();
  });

  it("WRITES NOTHING when the hour cap rejects", async () => {
    const { controller, feedback } = make({ overHour: true });
    await expect(controller.submit(WORKER as never, DTO, undefined, CTX)).rejects.toBeInstanceOf(
      HttpException,
    );
    expect(feedback.submit).not.toHaveBeenCalled();
  });
});

describe("the x-app-build stamp on a submission", () => {
  it("passes a well-formed build straight through", async () => {
    const { controller, feedback } = make();
    await controller.submit(WORKER as never, DTO, "1.4.2+318", CTX);
    expect(feedback.submit).toHaveBeenCalledWith(
      WORKER.id,
      DTO,
      { appBuild: "1.4.2+318", screenContext: null },
      CTX,
    );
  });

  it("turns an absent or malformed stamp into null WITHOUT refusing the feedback", async () => {
    // THE WHOLE POINT of sanitizing rather than validating: `x-app-build` is telemetry nobody
    // asked the worker for, so it must never be the reason their typed message is lost.
    for (const raw of [undefined, "", "   ", "<script>", "a b", "x".repeat(65)]) {
      const { controller, feedback } = make();
      await expect(controller.submit(WORKER as never, DTO, raw, CTX)).resolves.toEqual({
        ok: true,
      });
      expect(feedback.submit).toHaveBeenCalledWith(
        WORKER.id,
        DTO,
        { appBuild: null, screenContext: null },
        CTX,
      );
    }
  });
});

describe("what the request schema will and will not accept", () => {
  it("accepts a submission with NO category — untagged is a real state", () => {
    const parsed = SubmitFeedbackSchema.safeParse({ message: "please add Marathi" });
    expect(parsed.success).toBe(true);
    // `.optional()`, not `.nullable()`: the shipped client omits the key entirely rather than
    // sending an explicit null, and the absent key must not become a defaulted tag.
    expect(parsed.success && "category" in parsed.data).toBe(false);
  });

  it("accepts every category the shipped client can send, and nothing else", () => {
    for (const category of WORKER_FEEDBACK_CATEGORIES) {
      expect(SubmitFeedbackSchema.safeParse({ ...DTO, category }).success).toBe(true);
    }
    // A 400, NOT a coercion to "other". Relabelling an unknown tag would put a lie into the
    // category histogram ops make decisions from.
    expect(SubmitFeedbackSchema.safeParse({ ...DTO, category: "urgent" }).success).toBe(false);
    expect(SubmitFeedbackSchema.safeParse({ ...DTO, category: null }).success).toBe(false);
  });

  it("refuses an empty or whitespace-only message", () => {
    // Trim runs BEFORE the bounds, so a box full of spaces is an empty message rather than a
    // long one — a row that says nothing helps neither the worker nor the admin reading it.
    expect(SubmitFeedbackSchema.safeParse({ message: "" }).success).toBe(false);
    expect(SubmitFeedbackSchema.safeParse({ message: "     " }).success).toBe(false);
    expect(SubmitFeedbackSchema.safeParse({}).success).toBe(false);
  });

  it("bounds the message at WORKER_FEEDBACK_MESSAGE_MAX, and the bound IS the constant", () => {
    // Derived from the shared constant rather than a re-typed 4000: the DB CHECK pins the same
    // number and a literal here is how the two drift apart.
    const atMax = "a".repeat(WORKER_FEEDBACK_MESSAGE_MAX);
    expect(SubmitFeedbackSchema.safeParse({ message: atMax }).success).toBe(true);
    expect(SubmitFeedbackSchema.safeParse({ message: `${atMax}a` }).success).toBe(false);
  });

  it("keeps newlines and tabs, refuses the control bytes Postgres cannot store", () => {
    // A worker pressing Enter is not an attack. A NUL is a different thing: `text` cannot hold
    // one, so accepting it would surface as a driver 500 after they typed a paragraph.
    expect(SubmitFeedbackSchema.safeParse({ message: "line one\nline two\tend" }).success).toBe(
      true,
    );
    expect(SubmitFeedbackSchema.safeParse({ message: "ok\u0000bad" }).success).toBe(false);
    expect(SubmitFeedbackSchema.safeParse({ message: "ok\u0007bad" }).success).toBe(false);
  });

  it("is a 400 through the pipe the route actually uses, never a 500", () => {
    // The schema rejecting is only half the contract; what the worker sees is the other half.
    const pipe = new ZodValidationPipe(SubmitFeedbackSchema);
    expect(() => pipe.transform({ message: "" })).toThrow(BadRequestException);
    expect(() => pipe.transform({ ...DTO, category: "urgent" })).toThrow(BadRequestException);
    expect(pipe.transform({ message: "  spaces around  " })).toEqual({
      message: "spaces around",
    });
  });
});

describe("the screen context on a submission — normalized at the edge, never trusted", () => {
  it("normalizes the route BEFORE the service sees it, so no id can reach the row", async () => {
    // The controller is the ONLY place this happens, and that is deliberate: with the id
    // stripped here, there is no later layer — repository, event emitter, logger — that could
    // forget. A concrete job id arriving from an unofficial client dies at this line.
    const { controller, feedback } = make();
    await controller.submit(
      WORKER as never,
      { ...DTO, screen: "/jobs/6f2c04e0-4f89-41d3-9a0c-0305e82c3301/apply?src=push#top" },
      undefined,
      CTX,
    );
    expect(feedback.submit).toHaveBeenCalledWith(
      WORKER.id,
      expect.anything(),
      { appBuild: null, screenContext: "/jobs/:id/apply" },
      CTX,
    );
  });

  it("turns an unusable screen into null WITHOUT refusing the feedback", async () => {
    // Same rule as `x-app-build`, and it matters more here: `screen` is filled in by the CLIENT,
    // not the worker, so a client bug must never cost the worker the paragraph they typed. Every
    // value below is a 400 under any schema that validated it, and a `{ ok: true }` under this one.
    for (const screen of [
      undefined,
      "",
      "   ",
      42,
      { path: "/jobs" },
      "jobs/apply", // not rooted
      "/jobs/<script>alert(1)</script>", // injection primitive on the admin screen
      "/jobs/my job", // whitespace — a label, not a route
      `/${"a".repeat(200)}`, // past the bound
    ]) {
      const { controller, feedback } = make();
      await expect(
        controller.submit(WORKER as never, { ...DTO, screen } as never, undefined, CTX),
      ).resolves.toEqual({ ok: true });
      expect(feedback.submit).toHaveBeenCalledWith(
        WORKER.id,
        expect.anything(),
        { appBuild: null, screenContext: null },
        CTX,
      );
    }
  });

  it("the schema ACCEPTS a submission with no screen at all — every released client omits it", () => {
    // The additivity assertion. `screen` shipped after the app did, so a `.strict()` schema that
    // required it would 400 every client already in workers' hands.
    expect(SubmitFeedbackSchema.safeParse({ message: "button kaam nahi kar raha" }).success).toBe(
      true,
    );
    // ...and it accepts one that DOES send it, without validating it — that is the sanitizer's job.
    expect(
      SubmitFeedbackSchema.safeParse({ message: "button kaam nahi kar raha", screen: "/home" })
        .success,
    ).toBe(true);
    // `.strict()` still holds for everything else, `screen` being declared changes nothing there.
    expect(
      SubmitFeedbackSchema.safeParse({ message: "hi", screen_context: "/home" }).success,
    ).toBe(false);
  });
});
