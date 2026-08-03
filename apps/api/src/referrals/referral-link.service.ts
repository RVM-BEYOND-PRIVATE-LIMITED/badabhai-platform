import { Inject, Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { ServerConfig } from "@badabhai/config";
import type { InviteInstallSource } from "@badabhai/event-schema";
import type { ReferralClickPlatform, ReferralLinkKind, ReferralLinkMedium } from "@badabhai/db";
import { SERVER_CONFIG } from "../config/config.module";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { EventsService } from "../events/events.service";
import { ReferralLinkRepository } from "./referral-link.repository";
import {
  fallbackTarget,
  isLikelyBot,
  isWellFormedReferralCode,
  platformFromUserAgent,
  resolveTarget,
} from "./referral-resolve";

/** How long the same (code, hashed visitor) pair is treated as one click. */
const CLICK_DEDUPE_WINDOW_MS = 10 * 60 * 1000;

export interface ResolveOutcome {
  /** Where to 302 the visitor. ALWAYS set — a shared link never dead-ends. */
  redirectTo: string;
  /** Internal diagnostics (tests + logs). Never surfaced to the visitor. */
  leg: "app_link" | "masked_page" | "fallback";
  clickRecorded: boolean;
}

export interface ClaimOutcome {
  claimed: boolean;
  /** Internal reason for a no-op. NEVER returned to a client. */
  reason?: "unknown_code" | "outside_window" | "already_claimed" | "error";
  referralLinkId?: string | null;
}

/**
 * The B4 RESOLVER PRIMITIVE — `referral_links` + `referral_clicks`.
 *
 * Owns two things and nothing else:
 *  1. RESOLVE (`GET /r/:code`) — log the click with a HASHED identifier, then hand back the
 *     redirect. Every branch and the whole fallback chain live in `referral-resolve.ts`
 *     (pure); this class only does IO around them.
 *  2. CLAIM — resolve a worker's first-touch attribution against the MATCH WINDOW, exactly
 *     once, under concurrency. The locking + the unique-index backstop live in
 *     {@link ReferralLinkRepository.claimFirstTouch}.
 *
 * INVARIANTS:
 *  - PII BOUNDARY (#2): the raw IP and User-Agent are hashed HERE, at the edge, and the raw
 *    values are never persisted, logged, or evented. `click_hash` is a keyed HMAC (the same
 *    `PiiCryptoService` boundary as `phone_hash` / `device_hash`).
 *  - THE CODE IS A BEARER TOKEN: it goes into the redirect URL and the click row, and
 *    NOWHERE else — not into an event payload, not into a log line.
 *  - FAIL-SAFE: resolve NEVER throws. A DB outage costs the funnel statistic, never the
 *    worker's install page — the visitor still gets redirected.
 */
@Injectable()
export class ReferralLinkService {
  private readonly logger = new Logger(ReferralLinkService.name);

  constructor(
    private readonly repo: ReferralLinkRepository,
    private readonly events: EventsService,
    private readonly pii: PiiCryptoService,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
  ) {}

  /** The two configured match windows, in hours, keyed by medium. */
  private windowHours(): Record<ReferralLinkMedium, number> {
    return {
      organic: this.config.REFERRAL_MATCH_WINDOW_ORGANIC_HOURS,
      paid: this.config.REFERRAL_MATCH_WINDOW_PAID_HOURS,
    };
  }

  /** Mint a shareable link (agent code, worker share, campaign URL, QR). */
  async mintLink(input: {
    kind: ReferralLinkKind;
    medium?: ReferralLinkMedium;
    agentPayerId?: string | null;
    ownerWorkerId?: string | null;
    campaignId?: string | null;
    payload?: Record<string, unknown>;
    expiresAt?: Date | null;
  }): Promise<{ referral_link_id: string; code: string; url: string }> {
    const code = randomUUID().replace(/-/g, "").slice(0, 12);
    const medium = input.medium ?? "organic";
    const row = await this.repo.createLink({
      code,
      kind: input.kind,
      medium,
      agentPayerId: input.agentPayerId ?? null,
      ownerWorkerId: input.ownerWorkerId ?? null,
      campaignId: input.campaignId ?? null,
      payload: input.payload ?? {},
      expiresAt: input.expiresAt ?? null,
    });
    await this.events.emit({
      event_name: "referral.link_created",
      actor: input.ownerWorkerId
        ? { actor_type: "worker", actor_id: input.ownerWorkerId }
        : { actor_type: "system", actor_id: null },
      subject: { subject_type: "referral_link", subject_id: row.id },
      payload: {
        referral_link_id: row.id,
        kind: input.kind,
        medium,
        ...(input.campaignId ? { campaign_id: input.campaignId } : {}),
      },
      idempotencyKey: `referral.link_created:${row.id}`,
    });
    return {
      referral_link_id: row.id,
      code,
      // The SHORT link — what actually gets shared.
      url: `${this.config.REFERRAL_SHORT_LINK_BASE.replace(/\/+$/, "")}/r/${code}`,
    };
  }

  /**
   * Resolve `GET /r/:code`: record the click, then say where to send the visitor.
   *
   * NEVER THROWS. Every failure — malformed code, unknown code, expired link, DB down —
   * degrades to a redirect. The visitor's worst case is landing on the install page
   * unattributed, which is strictly better than an error page.
   */
  async resolve(input: {
    code: string;
    ip: string | undefined;
    userAgent: string | undefined;
    /**
     * Skip the click WRITE but still compute the redirect. Used when the per-IP cap is
     * breached. CRITICAL that this does not fall back to the code-less URL: the landing
     * page pings server-side from payer-web's single egress IP, so a crowd at one factory
     * gate shares one bucket. Dropping the code there would strip attribution from
     * legitimate workers — the exact failure this workstream exists to fix. Shedding the
     * write costs a funnel statistic; the code still reaches the Play Store referrer.
     */
    skipClick?: boolean;
  }): Promise<ResolveOutcome> {
    const base = this.config.REFERRAL_SHORT_LINK_BASE;
    const platform = platformFromUserAgent(input.userAgent);

    if (!isWellFormedReferralCode(input.code)) {
      return { redirectTo: fallbackTarget(base), leg: "fallback", clickRecorded: false };
    }

    const target = resolveTarget({ base, code: input.code, platform });

    // A crawler's prefetch must not become a worker's "first touch" (see isLikelyBot).
    if (input.skipClick || isLikelyBot(input.userAgent)) {
      return { redirectTo: target.url, leg: target.leg, clickRecorded: false };
    }

    let clickRecorded = false;
    try {
      clickRecorded = await this.recordClick({ code: input.code, ip: input.ip, platform });
    } catch (err) {
      // Fail-safe: the redirect below still happens. Log the error CLASS only — never the
      // code (bearer token), never the IP.
      this.logger.warn(`referral click not recorded (neutralized) (${(err as Error).name})`);
    }
    return { redirectTo: target.url, leg: target.leg, clickRecorded };
  }

  /** Insert the click row (+ event when it resolved to one of our links). */
  private async recordClick(input: {
    code: string;
    ip: string | undefined;
    platform: ReferralClickPlatform;
  }): Promise<boolean> {
    // Keyed HMAC over (ip + UA-derived platform). The raw IP never lands anywhere.
    const clickHash = this.pii.hmac(`${input.ip ?? "unknown"}|${input.platform}`);

    if (
      await this.repo.hasRecentClick({
        code: input.code,
        clickHash,
        since: new Date(Date.now() - CLICK_DEDUPE_WINDOW_MS),
      })
    ) {
      return false;
    }

    const link = await this.repo.findLinkByCode(input.code);
    // An EXPIRED link still logs a click (the funnel wants to see it) but is never
    // claimable — `claimInstall` re-checks expiry at claim time.
    const row = await this.repo.recordClick({
      referralLinkId: link?.id ?? null,
      code: input.code,
      clickHash,
      medium: link?.medium ?? "organic",
      platform: input.platform,
    });

    // Only OUR links get a `referral.*` event. A legacy `invites`/`agency_invites` code
    // keeps emitting its own `invite.clicked` via the existing public click path, so the
    // spine never double-counts one tap.
    if (link) {
      await this.events.emit({
        event_name: "referral.link_clicked",
        actor: { actor_type: "system", actor_id: null },
        subject: { subject_type: "referral_link", subject_id: link.id },
        payload: { referral_link_id: link.id, medium: link.medium, platform: input.platform },
        idempotencyKey: `referral.link_clicked:${row.id}`,
      });
    }
    return true;
  }

  /**
   * Resolve a worker's FIRST-TOUCH claim for `code`, inside the match window, exactly once.
   *
   * Called from the attribution hook after the consent gate has passed. Returns an outcome
   * rather than throwing: an unclaimable code is an ordinary result, not an error, and the
   * caller (attribution) is a best-effort side-signal that must never break onboarding.
   */
  async claimInstall(input: {
    code: string;
    workerId: string;
    source: InviteInstallSource;
  }): Promise<ClaimOutcome> {
    try {
      const now = new Date();
      const link = await this.repo.findLinkByCode(input.code);
      // Expiry is enforced at CLAIM time, not click time: a link that expired between the
      // click and the install must not pay out.
      if (link?.expiresAt && link.expiresAt.getTime() <= now.getTime()) {
        return { claimed: false, reason: "outside_window" };
      }

      const claimed = await this.repo.claimFirstTouch({
        code: input.code,
        workerId: input.workerId,
        windowHoursByMedium: this.windowHours(),
        now,
      });
      if (!claimed) return { claimed: false, reason: "unknown_code" };

      const windowHours = this.windowHours()[claimed.medium];
      const ageHours = Math.max(
        0,
        Math.floor((now.getTime() - claimed.clickedAt.getTime()) / (60 * 60 * 1000)),
      );

      await this.events.emit({
        event_name: "referral.install_claimed",
        actor: { actor_type: "worker", actor_id: input.workerId },
        subject: { subject_type: "referral_link", subject_id: claimed.referralLinkId },
        payload: {
          referral_link_id: claimed.referralLinkId,
          worker_id: input.workerId,
          medium: claimed.medium,
          source: input.source,
          age_hours: ageHours,
          window_hours: windowHours,
        },
        // Keyed on the CLICK row: an at-least-once retry writes exactly one event, and the
        // unique index already guarantees one claimed click per worker.
        idempotencyKey: `referral.install_claimed:${claimed.id}`,
      });

      return { claimed: true, referralLinkId: claimed.referralLinkId };
    } catch (err) {
      // The partial unique index firing (a lost race) lands here and is neutralised — the
      // winner already recorded the claim, so this is a correct no-op, not a failure.
      this.logger.warn(
        `referral claim not resolved (neutralized) worker=${input.workerId.slice(0, 8)}… (${
          (err as Error).name
        })`,
      );
      return { claimed: false, reason: "already_claimed" };
    }
  }
}
