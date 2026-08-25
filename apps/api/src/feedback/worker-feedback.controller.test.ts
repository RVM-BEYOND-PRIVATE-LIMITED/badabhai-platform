import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { BadRequestException, HttpException, HttpStatus } from "@nestjs/common";
import {
  WORKER_FEEDBACK_ATTACHMENT_PATH_MAX,
  WORKER_FEEDBACK_ATTACHMENTS_MAX,
  WORKER_FEEDBACK_CATEGORIES,
  WORKER_FEEDBACK_MESSAGE_MAX,
} from "@badabhai/types";

import { WorkerFeedbackController } from "./worker-feedback.controller";
import { SubmitFeedbackSchema, type SubmitFeedbackDto } from "./feedback.dto";
import type { FeedbackService } from "./feedback.service";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import type { IpRateLimit } from "../common/rate-limit/ip-rate-limit.service";
import type { SubjectRateLimit } from "../common/rate-limit/subject-rate-limit.service";
import type { RequestContext } from "../common/request-context";

const WORKER = { id: "11111111-1111-4111-8111-111111111111", sid: "s" };
/** The worker a hostile body would try to file feedback as. */
const SOMEONE_ELSE = "99999999-9999-4999-8999-999999999999";
const CTX = { correlationId: "c", requestId: "r" } as RequestContext;
const PER_MINUTE = 3;
const PER_HOUR = 20;
/** The per-IP cap on the ATTACHMENT MINT — a different bucket from the two above. */
const MINT_PER_IP_PER_HOUR = 20;
const IP = "203.0.113.7";
/** One minted slot, as `FeedbackService` returns it. */
const TICKET = {
  storage_path: `feedback-attachments/${WORKER.id}/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jpg`,
  upload_url: "https://storage.test/upload/x?token=secret",
  expires_in: 7200,
};
const DTO: SubmitFeedbackDto = { message: "the app logs me out every morning" };

function make(opts: { overMinute?: boolean; overHour?: boolean; overIpHour?: boolean } = {}) {
  /** The order the two caps were charged in — the assertion the 429 path depends on. */
  const charged: string[] = [];
  const feedback = {
    submit: vi.fn(async () => ({ id: "ffffffff-0000-4000-8000-000000000001" })),
    createAttachmentUploadUrl: vi.fn(async () => {
      charged.push("mint");
      return TICKET;
    }),
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
  const ipRateLimit = {
    assertWithinHourlyIpCap: vi.fn(async () => {
      charged.push("ip-hour");
      if (opts.overIpHour) throw new HttpException("Too many requests", 429);
    }),
  };
  const controller = new WorkerFeedbackController(
    feedback as unknown as FeedbackService,
    rateLimit as unknown as SubjectRateLimit,
    ipRateLimit as unknown as IpRateLimit,
    {
      WORKER_FEEDBACK_PER_MINUTE: PER_MINUTE,
      WORKER_FEEDBACK_PER_HOUR: PER_HOUR,
      FEEDBACK_ATTACHMENT_RATE_LIMIT_PER_IP_PER_HOUR: MINT_PER_IP_PER_HOUR,
    } as never,
  );
  // Captured so the divergence WARN can be asserted on BOTH counts: that it fires, and that it
  // carries none of the value that triggered it.
  const logs: string[] = [];
  (controller as unknown as { logger: Record<string, (m: string) => void> }).logger = {
    log: (m) => logs.push(m),
    warn: (m) => logs.push(m),
    error: (m) => logs.push(m),
  };

  return { controller, feedback, rateLimit, ipRateLimit, charged, logs };
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

describe("the screen context on a submission — resolved at the edge, never trusted", () => {
  it("resolves the route BEFORE the service sees it, so no client byte can reach the row", async () => {
    // The controller is the ONLY place this happens, and that is deliberate: with the value
    // replaced by one of our own constants here, there is no later layer — repository, event
    // emitter, logger — that could forget. A concrete job id from an unofficial client dies here.
    const { controller, feedback } = make();
    await controller.submit(
      WORKER as never,
      { ...DTO, screen: "/jobs/detail/6f2c04e0-4f89-41d3-9a0c-0305e82c3301?src=push#top" },
      undefined,
      CTX,
    );
    expect(feedback.submit).toHaveBeenCalledWith(
      WORKER.id,
      expect.anything(),
      { appBuild: null, screenContext: "/jobs/detail/:id" },
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
      "/u/dGVzdEBleGFtcGxlLmNvbQ", // base64url of an email — the residual a denylist could not see
      "/x/AKIAIOSFODNN7EXAMPLE", // an opaque credential-shaped token, likewise
      "/admin/workers", // a real route, of a DIFFERENT app
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
    // ...and it accepts one that DOES send it, without validating it — that is the resolver's job.
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

/**
 * ⚠ THE MAINTENANCE FAILURE AN ALLOWLIST BUYS ITS GUARANTEE WITH, and the surface that makes it
 * visible in production. A repo test can catch the app and the server's table diverging inside
 * this repo; it cannot see a client released ahead of the server, or a caller we do not build.
 * Without this line that case is perfectly silent: the submission succeeds, the column holds
 * null, and one screen's feedback simply stops existing.
 */
describe("the route-table divergence warning", () => {
  it("warns when a screen ARRIVED and matched nothing", async () => {
    const { controller, logs } = make();
    await controller.submit(
      WORKER as never,
      { ...DTO, screen: "/jobs/brand-new-screen" } as never,
      undefined,
      CTX,
    );
    expect(logs.join("\n")).toContain("matched none of the");
  });

  it("stays SILENT when no screen was sent — the ordinary case is not a signal", async () => {
    // Every client in a worker's hands today omits the field. A warn per submission would bury
    // the one that means something under thousands that do not, which is how a signal dies.
    for (const screen of [undefined, "", "   "]) {
      const { controller, logs } = make();
      await controller.submit(WORKER as never, { ...DTO, screen } as never, undefined, CTX);
      expect(logs, String(screen)).toEqual([]);
    }
  });

  it("stays silent for a screen that DID resolve", async () => {
    const { controller, logs } = make();
    await controller.submit(WORKER as never, { ...DTO, screen: "/jobs" } as never, undefined, CTX);
    expect(logs).toEqual([]);
  });

  /**
   * ⚠ AND IT LOGS NONE OF THE VALUE. This is the one moment the server KNOWS the string is
   * unrecognised, which makes it exactly the string §2 keeps out of logs — so "just log it for
   * diagnosis" would reopen the hole this whole change closed, at the only point where it is
   * certain to matter. The count is the signal; `router.dart` is where the answer is.
   */
  it("logs not one byte of the value that triggered it", async () => {
    const { controller, logs } = make();
    const hostile = "/u/dGVzdEBleGFtcGxlLmNvbQ";
    await controller.submit(WORKER as never, { ...DTO, screen: hostile } as never, undefined, CTX);
    const all = logs.join("\n");
    expect(all).toContain("matched none of the");
    expect(all).not.toContain(hostile);
    expect(all).not.toContain("dGVzdEBleGFtcGxlLmNvbQ");
  });
});

describe("minting an attachment slot — POST /workers/me/feedback/attachment/upload-url (#1191)", () => {
  it("mints for the TOKEN's worker and returns the ticket unchanged", async () => {
    const { controller, feedback } = make();
    const res = await controller.createAttachmentUploadUrl(WORKER as never, IP);
    expect(feedback.createAttachmentUploadUrl).toHaveBeenCalledWith(WORKER.id);
    expect(res).toEqual(TICKET);
  });

  it("charges the PER-IP hourly cap, in its own scope, BEFORE minting", async () => {
    // Its own namespace, not the per-worker feedback one: this cap bounds ORPHAN OBJECTS, and
    // sharing a bucket would let three image mints eat a worker's whole minute of feedback —
    // which is backwards, since three mints is what ONE submission with three images looks like.
    const { controller, ipRateLimit, charged } = make();
    await controller.createAttachmentUploadUrl(WORKER as never, IP);
    expect(ipRateLimit.assertWithinHourlyIpCap).toHaveBeenCalledWith(
      "feedback_attachment_upload_url",
      IP,
      MINT_PER_IP_PER_HOUR,
    );
    expect(charged).toEqual(["ip-hour", "mint"]);
  });

  it("MINTS NOTHING when the per-IP cap rejects", async () => {
    const { controller, feedback } = make({ overIpHour: true });
    await expect(
      controller.createAttachmentUploadUrl(WORKER as never, IP),
    ).rejects.toMatchObject({ status: HttpStatus.TOO_MANY_REQUESTS });
    expect(feedback.createAttachmentUploadUrl).not.toHaveBeenCalled();
  });

  it("does NOT charge the per-worker submission caps — a mint is not a submission", async () => {
    const { controller, rateLimit } = make();
    await controller.createAttachmentUploadUrl(WORKER as never, IP);
    expect(rateLimit.assertWithinMinuteCap).not.toHaveBeenCalled();
    expect(rateLimit.assertWithinHourlyCap).not.toHaveBeenCalled();
  });

  it("answers 201 with no-store — the body carries a bearer credential", () => {
    // Asserted off the route metadata rather than through a live request: the signed url
    // authorizes a write into a private bucket for two hours, and a cached copy of it is a
    // credential sitting in a proxy. `@Header` is what stops that.
    const handler = (WorkerFeedbackController.prototype as unknown as Record<string, object>)
      .createAttachmentUploadUrl!;
    expect(Reflect.getMetadata("__httpCode__", handler)).toBe(201);
    expect(Reflect.getMetadata("__headers__", handler)).toEqual([
      { name: "Cache-Control", value: "no-store" },
    ]);
    expect(Reflect.getMetadata("path", handler)).toBe("attachment/upload-url");
  });

  it("never logs the minted url", async () => {
    const { controller, logs } = make();
    await controller.createAttachmentUploadUrl(WORKER as never, IP);
    expect(logs.join("\n")).not.toContain(TICKET.upload_url);
  });
});

describe("what the request schema will and will not accept — attachment_paths (#1191)", () => {
  const PATH = "feedback-attachments/11111111-1111-4111-8111-111111111111/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jpg";

  it("accepts a submission with NO attachment_paths — the shipped client omits the key", () => {
    const parsed = SubmitFeedbackSchema.safeParse({ message: "the app logs me out" });
    expect(parsed.success).toBe(true);
    // `.optional()`, never `.default([])`: an absent key must stay absent all the way to a NULL
    // column, so a text-only submission and one that predates the feature look the same.
    expect(parsed.success && "attachment_paths" in parsed.data).toBe(false);
  });

  it("accepts up to the product cap and refuses one more", () => {
    const at = Array.from({ length: WORKER_FEEDBACK_ATTACHMENTS_MAX }, () => PATH);
    expect(SubmitFeedbackSchema.safeParse({ ...DTO, attachment_paths: at }).success).toBe(true);
    expect(
      SubmitFeedbackSchema.safeParse({ ...DTO, attachment_paths: [...at, PATH] }).success,
    ).toBe(false);
  });

  it("accepts an EXPLICIT empty array — a truthful 'no images' must not cost a message", () => {
    expect(SubmitFeedbackSchema.safeParse({ ...DTO, attachment_paths: [] }).success).toBe(true);
  });

  it("bounds each path BEFORE it ever reaches the ownership regex", () => {
    // Not the ownership control — that is `FeedbackService` — but the reason a megabyte of
    // caller-chosen bytes is never handed to a `RegExp.test` in the first place.
    expect(SubmitFeedbackSchema.safeParse({ ...DTO, attachment_paths: [""] }).success).toBe(false);
    expect(SubmitFeedbackSchema.safeParse({ ...DTO, attachment_paths: ["   "] }).success).toBe(
      false,
    );
    expect(
      SubmitFeedbackSchema.safeParse({
        ...DTO,
        attachment_paths: ["x".repeat(WORKER_FEEDBACK_ATTACHMENT_PATH_MAX + 1)],
      }).success,
    ).toBe(false);
    expect(SubmitFeedbackSchema.safeParse({ ...DTO, attachment_paths: [42] }).success).toBe(false);
    expect(SubmitFeedbackSchema.safeParse({ ...DTO, attachment_paths: PATH }).success).toBe(false);
    expect(SubmitFeedbackSchema.safeParse({ ...DTO, attachment_paths: null }).success).toBe(false);
  });

  it("⚠ ACCEPTS a path belonging to another worker — the DTO is NOT the IDOR control", () => {
    // Stated as a test on purpose. Every shape rule above passes for a forged key, and reading
    // this schema as the boundary is exactly the mistake that would make the feature an IDOR.
    // `FeedbackService.validateAttachmentPaths` is where it is refused; see its own tests.
    const theirs =
      "feedback-attachments/99999999-9999-4999-8999-999999999999/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jpg";
    expect(SubmitFeedbackSchema.safeParse({ ...DTO, attachment_paths: [theirs] }).success).toBe(
      true,
    );
  });
});
