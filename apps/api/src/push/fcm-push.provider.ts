import { Inject, Injectable, Logger } from "@nestjs/common";
import { createSign } from "node:crypto";
import type { ServerConfig } from "@badabhai/config";
import { getFcmServiceAccount } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import type {
  PushFailureReason,
  PushMessage,
  PushProvider,
  PushSendResult,
} from "./push.provider";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const REQUEST_TIMEOUT_MS = 10_000;
/** Refresh a bit before expiry so an in-flight send never races the boundary. */
const TOKEN_SKEW_SECONDS = 60;

/**
 * Real FCM delivery over the HTTP v1 API (ADR-0034).
 *
 * MODE A, deliberately: REST + `fetch` + a service credential, no vendor SDK — the same
 * posture StorageService takes with Supabase. FCM v1 needs a short-lived OAuth2 bearer
 * minted from a service-account JWT; that is ~20 lines of `node:crypto` (RS256 sign +
 * a token exchange), so this ships WITHOUT adding `google-auth-library` or
 * `firebase-admin`. A mis-signed assertion fails LOUDLY (Google returns 400/401), never
 * silently, so the hand-rolled path has no quiet failure mode.
 *
 * PRIVACY (§2): the push token, the credential, and every provider response BODY stay
 * out of logs — an FCM error body echoes the token back. Only a status code and a
 * closed-enum reason are ever logged.
 */
@Injectable()
export class FcmPushProvider implements PushProvider {
  private readonly logger = new Logger(FcmPushProvider.name);
  private cachedToken: { value: string; expiresAtMs: number } | null = null;

  constructor(@Inject(SERVER_CONFIG) private readonly config: ServerConfig) {}

  async send(message: PushMessage): Promise<PushSendResult> {
    let accessToken: string;
    try {
      accessToken = await this.accessToken();
    } catch (err) {
      this.logger.error(
        `FCM auth failed (reason: ${err instanceof Error ? err.message : "unknown"})`,
      );
      return { ok: false, reason: "provider_error" };
    }

    const url = `https://fcm.googleapis.com/v1/projects/${this.config.FCM_PROJECT_ID}/messages:send`;
    // DATA-ONLY (see PushMessage): no `notification` block, so the client renders in
    // every app state and its privacy/targeting controls actually run. Every value is a
    // string — the v1 `data` map is string→string.
    const body = {
      message: {
        token: message.token,
        data: {
          title: message.title,
          body: message.body,
          type: message.type,
          route: message.route,
          target: message.target,
        },
        android: { priority: "HIGH" as const },
      },
    };

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      // Network/timeout — TRANSIENT. Never clears the token.
      return { ok: false, reason: "transport" };
    }

    if (res.ok) return { ok: true };

    // Read the error code WITHOUT logging the body (it echoes the token).
    const reason = await FcmPushProvider.classify(res);
    this.logger.warn(`FCM send failed status=${res.status} reason=${reason}`);
    return { ok: false, reason };
  }

  /**
   * Map an FCM v1 error to a closed reason. Only `UNREGISTERED` (and a 404) means the
   * token is permanently dead and may be cleared — everything else is transient or a
   * config fault, where discarding a good delivery address would be the worse error.
   */
  private static async classify(res: Response): Promise<PushFailureReason> {
    let errorCode = "";
    try {
      const parsed = (await res.json()) as {
        error?: { status?: string; details?: { errorCode?: string }[] };
      };
      errorCode =
        parsed.error?.details?.find((d) => d.errorCode)?.errorCode ?? parsed.error?.status ?? "";
    } catch {
      // An unparseable body tells us nothing — fall through to the status code.
    }
    if (errorCode === "UNREGISTERED" || res.status === 404) return "unregistered";
    if (errorCode === "INVALID_ARGUMENT" || res.status === 400) return "invalid_argument";
    if (res.status === 429) return "quota";
    if (res.status >= 500) return "transport";
    return "provider_error";
  }

  /** A cached OAuth2 access token, minted from the service-account JWT on demand. */
  private async accessToken(): Promise<string> {
    const now = Date.now();
    if (this.cachedToken && this.cachedToken.expiresAtMs > now) return this.cachedToken.value;

    const account = getFcmServiceAccount(this.config);
    if (!account) throw new Error("FCM service account is not configured");

    const iat = Math.floor(now / 1000);
    const exp = iat + 3600;
    const claims = {
      iss: account.clientEmail,
      scope: FCM_SCOPE,
      aud: GOOGLE_TOKEN_URL,
      iat,
      exp,
    };
    const encode = (o: unknown): string =>
      Buffer.from(JSON.stringify(o)).toString("base64url");
    const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode(claims)}`;
    const signature = createSign("RSA-SHA256")
      .update(unsigned)
      .sign(account.privateKey, "base64url");
    const assertion = `${unsigned}.${signature}`;

    const res = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      // Status only — the body can carry credential detail.
      throw new Error(`token exchange failed with status ${res.status}`);
    }
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new Error("token exchange returned no access_token");

    this.cachedToken = {
      value: json.access_token,
      expiresAtMs: now + ((json.expires_in ?? 3600) - TOKEN_SKEW_SECONDS) * 1000,
    };
    return json.access_token;
  }
}
