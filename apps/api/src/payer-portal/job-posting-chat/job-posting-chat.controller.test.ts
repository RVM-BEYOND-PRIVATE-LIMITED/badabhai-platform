import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AuthenticatedPayer } from "../../payers/payer-auth.guard";
import { PayerAuthGuard } from "../../payers/payer-auth.guard";
import type { RequestContext } from "../../common/request-context";
import { JobPostingChatController } from "./job-posting-chat.controller";
import {
  PostJobPostingChatMessageSchema,
  StartJobPostingChatSchema,
  PublishJobPostingChatSchema,
  JobPostingChatSessionParamSchema,
} from "./job-posting-chat.dto";

const PAYER_A: AuthenticatedPayer = {
  id: "aaaaaaaa-0000-4000-8000-000000000001",
  sid: "sid-a",
  role: "employer",
};
const PAYER_B_ID = "bbbbbbbb-0000-4000-8000-000000000002";
const SESSION = "cccccccc-0000-4000-8000-000000000003";
const CTX: RequestContext = {
  correlationId: "11111111-1111-4111-8111-111111111111",
  requestId: "req-1",
};

function makeCtrl() {
  const chat = {
    startSession: vi.fn(async () => ({ session_id: SESSION })),
    postMessage: vi.fn(async () => ({ session_id: SESSION })),
    listSessions: vi.fn(async () => ({ sessions: [] })),
    listMessages: vi.fn(async () => ({ messages: [] })),
    publish: vi.fn(async () => ({ job_posting_id: "d" })),
  };
  return { ctrl: new JobPostingChatController(chat as never), chat };
}

const getMeta = (key: string, target: unknown): unknown[] =>
  (Reflect.getMetadata(key, target as object) as unknown[] | undefined) ?? [];

/**
 * XB-A at the payer boundary. The payer id is the VERIFIED SESSION (`@CurrentPayer`)
 * on every route; the body and the URL supply only the session id and the message.
 * These tests pin the ONE thing a controller can get wrong on this surface: passing
 * something other than `payer.id` as the owner.
 */
describe("JobPostingChatController — identity from the session, never the body (XB-A)", () => {
  let d: ReturnType<typeof makeCtrl>;
  beforeEach(() => {
    d = makeCtrl();
  });

  it("startSession forwards the SESSION payer", async () => {
    await d.ctrl.startSession(PAYER_A, {}, CTX);
    expect(d.chat.startSession).toHaveBeenCalledWith(PAYER_A.id, CTX);
  });

  it("postMessage forwards the SESSION payer alongside the body's session id", async () => {
    const dto = { session_id: SESSION, text: "we need 5 welders" };
    await d.ctrl.postMessage(PAYER_A, dto, CTX);
    expect(d.chat.postMessage).toHaveBeenCalledWith(PAYER_A.id, dto, CTX);
  });

  it("listSessions scopes to the SESSION payer (the cross-device resume entry point)", async () => {
    await d.ctrl.listSessions(PAYER_A);
    expect(d.chat.listSessions).toHaveBeenCalledWith(PAYER_A.id);
  });

  it("listMessages pairs the URL session id with the SESSION payer, never a body owner", async () => {
    await d.ctrl.listMessages(PAYER_A, { id: SESSION });
    expect(d.chat.listMessages).toHaveBeenCalledWith(PAYER_A.id, SESSION);
  });

  it("publish pairs the URL session id with the SESSION payer", async () => {
    await d.ctrl.publish(PAYER_A, { id: SESSION }, {}, CTX);
    expect(d.chat.publish).toHaveBeenCalledWith(PAYER_A.id, SESSION, CTX);
  });

  it("NO schema on this surface accepts a payer_id / org_label, so neither can be spoofed", () => {
    // A body-supplied owner is the defect XB-A exists to prevent; a body-supplied
    // org_label would let a payer post under someone else's employer name. Both are
    // rejected by the schemas, not merely ignored by the service.
    for (const spoof of [
      { session_id: SESSION, text: "hi", payer_id: PAYER_B_ID },
      { session_id: SESSION, text: "hi", org_label: "Someone Else Ltd" },
    ]) {
      const parsed = PostJobPostingChatMessageSchema.parse(spoof);
      expect(parsed).toEqual({ session_id: SESSION, text: "hi" });
    }
    expect(StartJobPostingChatSchema.parse({ payer_id: PAYER_B_ID })).toEqual({});
    expect(PublishJobPostingChatSchema.parse({ org_label: "Someone Else Ltd" })).toEqual({});
  });

  it("the :id param schema proves shape only — parsing is not permission", () => {
    expect(JobPostingChatSessionParamSchema.safeParse({ id: "not-a-uuid" }).success).toBe(false);
    expect(JobPostingChatSessionParamSchema.safeParse({ id: SESSION }).success).toBe(true);
  });
});

describe("JobPostingChatController — every route is behind PayerAuthGuard", () => {
  it("is class-guarded, so no route can be added unguarded by accident", () => {
    expect(getMeta("__guards__", JobPostingChatController)).toContain(PayerAuthGuard);
  });

  it("mounts under /payer/job-posting-chat (the external payer route group)", () => {
    expect(Reflect.getMetadata("path", JobPostingChatController)).toBe("payer/job-posting-chat");
  });
});
