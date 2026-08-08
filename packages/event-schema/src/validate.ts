import type { z } from "zod";
import {
  EnvelopeBaseSchema,
  type ActorSchema,
  type SubjectSchema,
  type MetadataSchema,
  type EnvelopeBase,
} from "./envelope";
import {
  EVENT_REGISTRY,
  isEventName,
  type EventName,
  type PayloadOf,
  type PayloadInputOf,
} from "./registry";

/**
 * A fully-typed, validated BadaBhai event for a specific event name `N`.
 * The base envelope's loose `event_name`/`payload` are narrowed to `N` and its
 * registered payload type.
 */
export type BadaBhaiEvent<N extends EventName = EventName> = Omit<
  EnvelopeBase,
  "event_name" | "payload"
> & {
  event_name: N;
  payload: PayloadOf<N>;
};

/** Discriminated union of every possible validated event. */
export type AnyBadaBhaiEvent = { [N in EventName]: BadaBhaiEvent<N> }[EventName];

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
export type EventValidationStage = "envelope" | "event_name" | "version" | "payload";

export interface EventValidationError {
  stage: EventValidationStage;
  message: string;
  issues?: z.ZodIssue[];
}

export type EventValidationResult =
  | { success: true; event: AnyBadaBhaiEvent }
  | { success: false; error: EventValidationError };

/**
 * Two-stage validation:
 *  1. Validate the envelope shape.
 *  2. Resolve the event name + version in the registry and validate the payload.
 *
 * Returns a discriminated result instead of throwing, so callers can decide how
 * to handle invalid events (e.g. dead-letter, log, reject the request).
 */
export function validateEvent(input: unknown): EventValidationResult {
  const base = EnvelopeBaseSchema.safeParse(input);
  if (!base.success) {
    return {
      success: false,
      error: { stage: "envelope", message: "Invalid event envelope", issues: base.error.issues },
    };
  }

  const { event_name, event_version } = base.data;
  if (!isEventName(event_name)) {
    return {
      success: false,
      error: { stage: "event_name", message: `Unknown event_name: "${event_name}"` },
    };
  }

  const def = EVENT_REGISTRY[event_name];
  if (event_version !== def.version) {
    return {
      success: false,
      error: {
        stage: "version",
        message: `Unsupported version ${event_version} for "${event_name}" (expected ${def.version})`,
      },
    };
  }

  const payload = def.payload.safeParse(base.data.payload);
  if (!payload.success) {
    return {
      success: false,
      error: {
        stage: "payload",
        message: `Invalid payload for "${event_name}"`,
        issues: payload.error.issues,
      },
    };
  }

  return {
    success: true,
    event: { ...base.data, payload: payload.data } as AnyBadaBhaiEvent,
  };
}

/**
 * Thrown by `assertValidEvent` / `createEvent` when validation fails.
 *
 * THE MESSAGE NAMES THE OFFENDING FIELDS. It used to say only `Invalid payload for "x"`, which
 * is the least useful thing it could say: the caller sees a 500, the log shows a stack, and
 * finding out WHICH field was wrong took re-deriving the payload by hand from the source. The
 * `issues` array was right there the whole time.
 *
 * PATH AND CODE ONLY — never `issue.message`, and that restriction is load-bearing. Zod renders
 * an enum mismatch as "Expected 'a' | 'b', received <the value>", so echoing messages would put
 * a REJECTED payload value into a log line. Event payloads are PII-free by contract, but a
 * contract violation is exactly the case that reaches this branch, and a diagnostic that leaks
 * on precisely the malformed input is the wrong trade. `reason: invalid_enum_value` tells an
 * engineer where to look without quoting anything.
 */
export class EventValidationException extends Error {
  constructor(public readonly error: EventValidationError) {
    super(`[event-schema:${error.stage}] ${error.message}${summarizeIssues(error.issues)}`);
    this.name = "EventValidationException";
  }
}

/** `" — field: code, other.field: code"`, bounded. Empty when there is nothing to add. */
function summarizeIssues(issues: EventValidationError["issues"]): string {
  if (!issues?.length) return "";
  const rendered = issues
    .slice(0, 8)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.code}`)
    .join(", ");
  const more = issues.length > 8 ? `, +${issues.length - 8} more` : "";
  return ` — ${rendered}${more}`;
}

/** Validate and return a typed event, or throw `EventValidationException`. */
export function assertValidEvent(input: unknown): AnyBadaBhaiEvent {
  const result = validateEvent(input);
  if (!result.success) throw new EventValidationException(result.error);
  return result.event;
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------
type ActorInput = z.input<typeof ActorSchema>;
type SubjectInput = z.input<typeof SubjectSchema>;
type MetadataInput = z.input<typeof MetadataSchema>;

export interface CreateEventInput<N extends EventName> {
  event_name: N;
  /** Input payload — fields with schema defaults may be omitted. */
  payload: PayloadInputOf<N>;
  actor: ActorInput;
  subject: SubjectInput;
  source: string;
  metadata: MetadataInput;
  /** Defaults to a new random UUID. */
  event_id?: string;
  /** Defaults to a new random UUID (start of a new trace). */
  correlation_id?: string;
  /** The event that caused this one, if any. */
  causation_id?: string | null;
  /** Defaults to now (ISO 8601). */
  occurred_at?: string;
}

function newUuid(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * Build, normalize (apply defaults), and validate an event in one step.
 * Throws `EventValidationException` if the result is invalid — so a value
 * returned from `createEvent` is always schema-valid.
 */
export function createEvent<N extends EventName>(input: CreateEventInput<N>): BadaBhaiEvent<N> {
  const def = EVENT_REGISTRY[input.event_name];
  const candidate = {
    event_id: input.event_id ?? newUuid(),
    event_name: input.event_name,
    event_version: def.version,
    occurred_at: input.occurred_at ?? new Date().toISOString(),
    actor: input.actor,
    subject: input.subject,
    source: input.source,
    correlation_id: input.correlation_id ?? newUuid(),
    causation_id: input.causation_id ?? null,
    payload: input.payload,
    metadata: input.metadata,
  };

  const result = validateEvent(candidate);
  if (!result.success) throw new EventValidationException(result.error);
  return result.event as BadaBhaiEvent<N>;
}
