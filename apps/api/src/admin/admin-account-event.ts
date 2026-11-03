import type { Database } from "@badabhai/db";
import type { PayloadInputOf } from "@badabhai/event-schema";
import type { RequestContext } from "../common/request-context";
import type { EventsService } from "../events/events.service";
import type { AdminActionCode } from "./admin-actions.service";

export interface AdminAccountActionInput {
  /** Who acted — the session admin, or (unauthenticated reset) the admin the code proved. */
  actorAdminId: string;
  /** The admin the action is ABOUT. Equal to the actor for every self-service action. */
  targetAdminId: string;
  actionCode: AdminActionCode;
  ctx: RequestContext;
  /** Commit the event on the caller's transaction, atomically with the row it records (H3). */
  tx?: Database;
}

/**
 * Emit ONE value-free `admin.action_performed` about an ADMIN account (subject/target type
 * `admin_session`) — the migration-0144 account actions: created, password set/reset, device
 * trusted, two-step on/off. The SAME registered event and payload shape `AdminActionsService`
 * emits for invite/role/suspend; no event-schema change.
 *
 * The payload is the `.strict()` four-key `AdminActionPerformedPayload` — opaque ids + the code.
 * There is deliberately no parameter through which a password, a code, a device token or an
 * email could reach it.
 *
 * No idempotency key, like `admin_invite_accepted`: each of these is a distinct fact committed
 * with its own row change, and a client-chosen request id must never be able to dedupe one away.
 */
export function emitAdminAccountAction(
  events: EventsService,
  input: AdminAccountActionInput,
): Promise<unknown> {
  const payload: PayloadInputOf<"admin.action_performed"> = {
    admin_id: input.actorAdminId,
    action_code: input.actionCode,
    target_type: "admin_session",
    target_id: input.targetAdminId,
  };
  return events.emit({
    event_name: "admin.action_performed",
    actor: { actor_type: "admin", actor_id: input.actorAdminId },
    subject: { subject_type: "admin_session", subject_id: input.targetAdminId },
    payload,
    correlationId: input.ctx.correlationId,
    requestId: input.ctx.requestId,
    tx: input.tx,
  });
}
