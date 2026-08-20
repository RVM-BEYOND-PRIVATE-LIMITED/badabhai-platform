import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";

import { AdminFeedbackController } from "./admin-feedback.controller";
import type { AdminFeedbackService } from "./admin-feedback.service";
import type { AuthenticatedAdmin } from "./admin-auth.guard";
import type { AdminFeedbackQueryDto } from "./admin-feedback.dto";
import type { RequestContext } from "../common/request-context";

/**
 * `GET /admin/feedback` — the CONTROLLER, which had no test of its own (#997).
 *
 * `admin-feedback.authz.test.ts` is reflection-only: it reads the capability decorators and
 * never calls `list`. `admin-feedback.service.test.ts` proves the service forwards its own
 * first parameter. Neither reaches the wiring BETWEEN them, so the controller's own claim —
 * "The ADMIN comes from the session the guard resolved, never from the request" — and the
 * service test's title ("from the SESSION admin") both rested on a line nothing executed.
 * Swapping `admin.id` for any request-derived value shipped green.
 *
 * This is the `worker-feedback.controller.test.ts` equivalent ("stamps the submitting worker
 * from the TOKEN, never from the body") for the read side: the audited actor is the one thing
 * on this surface that must not be attacker-chosen, because `admin.feedback_viewed` is the
 * compensating control that makes reading a worker's own prose acceptable at all.
 */

const ADMIN: AuthenticatedAdmin = {
  id: "aaaaaaaa-0000-4000-8000-000000000001",
  role: "ops_admin",
} as AuthenticatedAdmin;

/** The admin a forged query would try to attribute the read to. */
const SOMEONE_ELSE = "bbbbbbbb-0000-4000-8000-000000000002";
const CTX = { correlationId: "c", requestId: "r" } as RequestContext;

type ListResult = Awaited<ReturnType<AdminFeedbackService["list"]>>;

function make() {
  const service = {
    // Parameters declared so `mock.calls[0][0]` is the ADMIN ID and typechecks as one — an
    // untyped `vi.fn` makes the call tuple `[]` and the assertion below unwritable.
    list: vi.fn(
      async (
        _adminId: string,
        _query: AdminFeedbackQueryDto,
        _ctx: RequestContext,
      ): Promise<ListResult> => ({ items: [], nextCursor: null }),
    ),
  };
  const controller = new AdminFeedbackController(service as unknown as AdminFeedbackService);
  return { controller, service };
}

describe("AdminFeedbackController.list — the audited actor comes from the SESSION", () => {
  it("passes the session admin's id, the parsed query and the context, in that order", async () => {
    const { controller, service } = make();
    const query = { category: "problem", limit: 25 } as AdminFeedbackQueryDto;
    await controller.list(ADMIN, query, CTX);
    expect(service.list).toHaveBeenCalledWith(ADMIN.id, query, CTX);
  });

  it("ignores an admin id smuggled through the query string", async () => {
    // The realistic shape of the attack: a hand-edited URL. `AdminFeedbackQuerySchema` is
    // `.strict()` so this 400s at the pipe in production — but the pipe is not what makes the
    // audit trail honest. This is: even handed the field, the controller reads the session.
    const { controller, service } = make();
    const forged = {
      limit: 25,
      adminId: SOMEONE_ELSE,
      admin_id: SOMEONE_ELSE,
    } as unknown as AdminFeedbackQueryDto;
    await controller.list(ADMIN, forged, CTX);
    expect(service.list).toHaveBeenCalledWith(ADMIN.id, forged, CTX);
    expect(service.list.mock.calls[0]![0]).not.toBe(SOMEONE_ELSE);
  });

  it("returns exactly what the service returned — no re-shaping at the HTTP layer", async () => {
    // Controllers are HTTP only (CLAUDE.md §4). A projection applied here would be a second
    // place the faceless contract is decided, and the one nobody reviews.
    const { controller, service } = make();
    const page: ListResult = { items: [], nextCursor: "bmV4dA" };
    service.list.mockResolvedValueOnce(page);
    await expect(controller.list(ADMIN, { limit: 25 } as AdminFeedbackQueryDto, CTX)).resolves.toBe(
      page,
    );
  });
});
