import { Injectable, Logger } from "@nestjs/common";

/** DI token for the push provider — mirrors SMS_PROVIDER (apps/api/src/sms). */
export const PUSH_PROVIDER = Symbol("PUSH_PROVIDER");

/**
 * One push to ONE device (ADR-0034).
 *
 * DATA-ONLY BY CONSTRUCTION — there is deliberately no `notification` block here. If the
 * server sent one, Android would render it in the tray ITSELF and
 * `onMessageReceived` would never run while the app is backgrounded, making every
 * client-side control (lock-screen visibility, the `target` drop, tap routing)
 * structurally unreachable. Data-only keeps the client in charge in every app state.
 */
export interface PushMessage {
  /** The device's FCM registration token. NEVER logged or evented. */
  token: string;
  /** Static, server-rendered, faceless copy — never derived from an event payload. */
  title: string;
  body: string;
  /** Coarse NotificationType (e.g. "security"). */
  type: string;
  /** Closed-enum in-app destination — never a free string (it would smuggle ids). */
  route: "devices" | "home";
  /**
   * The device's opaque `push_target` nonce. The client drops any message whose target
   * does not match its own, which is what suppresses a delivery to a handset that has
   * since been claimed by a DIFFERENT worker. Not a worker id; not correlatable.
   */
  target: string;
}

/** Why a send failed. Closed enum — never a provider response body (it echoes the token). */
export type PushFailureReason =
  | "unregistered"
  | "invalid_argument"
  | "quota"
  | "transport"
  | "provider_error";

export type PushSendResult =
  | { ok: true }
  /**
   * `unregistered` is the ONLY verdict that may clear a stored token: it is FCM saying
   * the token is permanently dead. A transport blip must never throw away a working
   * delivery address.
   */
  | { ok: false; reason: PushFailureReason };

/** The provider seam. All FCM specifics live behind it (mirrors SmsProvider). */
export interface PushProvider {
  send(message: PushMessage): Promise<PushSendResult>;
}

/**
 * Default provider while `PUSH_ENABLE_REAL` is false — the alpha posture.
 *
 * Sends NOTHING. It exists so the whole pipeline (targeting, dedupe, events, token
 * invalidation) is exercisable end-to-end with no credential and no traffic leaving the
 * process, exactly like the WhatsApp/payments mock gates.
 *
 * §2: logs the coarse type ONLY — never the token, the copy, or the target.
 */
@Injectable()
export class MockPushProvider implements PushProvider {
  private readonly logger = new Logger(MockPushProvider.name);

  async send(message: PushMessage): Promise<PushSendResult> {
    this.logger.log(`push suppressed (mock provider) type=${message.type}`);
    return { ok: true };
  }
}
