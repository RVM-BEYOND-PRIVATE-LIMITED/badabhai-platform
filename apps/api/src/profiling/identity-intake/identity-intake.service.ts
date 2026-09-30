import { Injectable, Logger } from "@nestjs/common";

import { logSafeReason } from "../../common/db-error";
import { PiiCryptoService } from "../../common/pii-crypto.service";
import type { RequestContext } from "../../common/request-context";
import { EventsService } from "../../events/events.service";
import { WorkersService } from "../../workers/workers.service";
import { composeFullName, type IntakeSettlement, type IntakeTransition } from "./identity-intake";

/**
 * What one intake turn writes to the worker's record, resolved and validated.
 *
 * `fullName` IS PLAINTEXT, AND LIVES ONLY IN THIS REQUEST'S MEMORY: it is built from the sealed
 * first name and this turn's answer, handed to `WorkersService.setFullName` (which encrypts it
 * before it touches the database) and dropped. It is never put in the envelope, a log, or an event.
 */
export interface IntakeWrite {
  readonly fullName: string | null;
  readonly location: { readonly state?: string; readonly city?: string } | null;
}

/** Who and where — the ids every write and event of one intake turn is attributed to. */
export interface IntakeRef {
  readonly workerId: string;
  readonly sessionId: string;
  readonly ctx: RequestContext;
}

/**
 * The identity intake's I/O (ADR-0048): the seal on the held first name, the two record writes,
 * and the funnel event. The decisions are `identity-intake.ts`'s; the orchestrator wires both.
 *
 * THE WRITES GO THROUGH `WorkersService`, NEVER AROUND IT. `setFullName` and `setLocation` are the
 * one write path each for `workers.full_name` and `current_city`/`current_state` — encryption, the
 * PII-free `worker.name_recorded` / `worker.location_recorded` events, the résumé re-render and the
 * `resume.edited_v2` signal all live there, so the chat inherits every one of them rather than
 * re-implementing them. `worker_self`, because the worker typed it in his own authenticated
 * session — the same origin as `PATCH /workers/me/name`.
 *
 * LOGS CARRY IDS, STEP NAMES AND BOOLEANS — never a value, not even the city (CLAUDE.md §3).
 */
@Injectable()
export class IdentityIntakeService {
  private readonly logger = new Logger(IdentityIntakeService.name);

  constructor(
    private readonly workers: WorkersService,
    private readonly pii: PiiCryptoService,
    private readonly events: EventsService,
  ) {}

  /** D2 — the first name, sealed for the Redis envelope between the two name steps. */
  seal(firstName: string): string {
    return this.pii.encrypt(firstName);
  }

  /**
   * The name and location this transition finished, or `null` when it finished neither.
   *
   * A HELD FIRST NAME THAT WILL NOT UNSEAL WRITES NO NAME. A key rotated between the two steps
   * degrades to "not captured this session" — the gap stays, and the worker's next new session
   * asks again (D9) — rather than to a surname stored as his whole name.
   */
  resolveWrite(
    transition: Pick<IntakeTransition, "name" | "location">,
    heldFirstNameEnc: string | null,
    sessionId: string,
  ): IntakeWrite | null {
    const name = transition.name;
    const fullName =
      name === null
        ? null
        : name.kind === "full"
          ? name.value
          : composeFullName(this.unseal(heldFirstNameEnc, sessionId), name.surname);
    if (fullName === null && transition.location === null) return null;
    return { fullName, location: transition.location };
  }

  /**
   * Write the record — BEFORE the turn's CAS, and allowed to throw.
   *
   * The orchestrator turns a throw into the retryable "unavailable" reply with nothing advanced,
   * so the worker is asked the same question again and a retry writes again. That is why both
   * writes carry a per-session idempotency key: a retried or CAS-lost turn re-runs the SAME write
   * (an UPDATE to the same value), and the key keeps the audit spine at one event per fact.
   */
  async apply(write: IntakeWrite, ref: IntakeRef): Promise<void> {
    if (write.fullName !== null) {
      await this.workers.setFullName(ref.workerId, write.fullName, ref.ctx, {
        origin: "worker_self",
        idempotencyKey: `worker.name_recorded:identity_intake:${ref.sessionId}`,
      });
    }
    if (write.location !== null) {
      await this.workers.setLocation(ref.workerId, write.location, ref.ctx, {
        idempotencyKey: `worker.location_recorded:identity_intake:${ref.sessionId}`,
      });
    }
    this.logger.log(
      `identity intake wrote session=${ref.sessionId} name=${write.fullName !== null} ` +
        `location=${write.location !== null}`,
    );
  }

  /**
   * One `profile.identity_intake_answered` per step settled — AFTER the CAS, and it NEVER throws.
   *
   * After, because a turn that loses the write did not happen. Never throws, because the record
   * write and the conversation have both already landed: a worker must not be told "try again"
   * because a funnel row hit a connection blip. Keyed per (session, step), so a replayed or
   * re-driven turn records each step once.
   */
  async record(settled: readonly IntakeSettlement[], ref: IntakeRef): Promise<void> {
    for (const settlement of settled) {
      try {
        await this.events.emit({
          event_name: "profile.identity_intake_answered",
          actor: { actor_type: "worker", actor_id: ref.workerId },
          subject: { subject_type: "chat_session", subject_id: ref.sessionId },
          payload: {
            worker_id: ref.workerId,
            session_id: ref.sessionId,
            step: settlement.step,
            outcome: settlement.outcome,
            recognized: settlement.recognized,
          },
          idempotencyKey: `profile.identity_intake_answered:${ref.sessionId}:${settlement.step}`,
          correlationId: ref.ctx.correlationId,
          requestId: ref.ctx.requestId,
        });
      } catch (error) {
        this.logger.error(
          `identity intake step ${settlement.step} was not recorded session=${ref.sessionId}; ` +
            `the answer stands: ${logSafeReason(error, "identity intake event")}`,
        );
      }
    }
  }

  private unseal(token: string | null, sessionId: string): string | null {
    if (token === null) return null;
    try {
      return this.pii.decrypt(token);
    } catch {
      this.logger.warn(
        `identity intake: the held first name could not be unsealed session=${sessionId}; ` +
          `no name is written and the worker's next new session asks again`,
      );
      return null;
    }
  }
}
