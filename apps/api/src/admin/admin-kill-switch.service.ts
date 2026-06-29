import { Inject, Injectable, Logger } from "@nestjs/common";
import type { PayloadInputOf } from "@badabhai/event-schema";
import {
  type ServerConfig,
  areRealAiCallsEnabled,
  realAiCallsBlockedReason,
  areRealPaymentsEnabled,
  realPaymentsBlockedReason,
  areRealMessagesEnabled,
  realMessagingBlockedReason,
} from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import type { RequestContext } from "../common/request-context";
import { EventsService } from "../events/events.service";
import type {
  AdminKillSwitchPauseRequestDto,
  AdminKillSwitchPauseRequestResponse,
  KillSwitchStatusItem,
  KillSwitchStatusResponse,
} from "./admin-kill-switch.dto";

/**
 * The ADMIN-3c kill-switch surface (ADR-0025 OQ-6) — DISPLAY + safe-direction PAUSE INTENT only.
 *
 * OQ-6 (RECONCILED, the HARD LINE): the portal (a) DISPLAYS the live state of the platform's
 * provider/operational switches (read-only observability) and (b) records a safe-direction PAUSE
 * INTENT. ENABLING any real provider stays env/deploy-gated, staging-first, key-required — NEVER a
 * portal toggle (§2 #5 / §7). This service therefore:
 *   - reads the EXISTING server-config gates to build a PII-free status snapshot, and
 *   - emits a value-free `admin.kill_switch_pause_requested` audit event on a pause request.
 * It NEVER mutates a flag, writes a config, or enables anything — there is no such code path.
 *
 * VALUE-FREE SPINE (CLAUDE.md invariant #2): the pause event carries the opaque admin_id + a
 * switch KEY enum + a reason CODE only. No secret, no provider key, no toggle value — `.strict()`
 * on the payload is the structural backstop.
 */
@Injectable()
export class AdminKillSwitchService {
  private readonly logger = new Logger(AdminKillSwitchService.name);

  constructor(
    private readonly events: EventsService,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
  ) {}

  /**
   * Build the read-only switch snapshot from server config (OQ-6 a). PII-FREE: enums, labels,
   * booleans, and a PII-free operational reason ONLY — never a secret/value. Pure (no I/O, no
   * event): a status read is observability, not a state change, so it emits nothing.
   */
  buildStatus(): KillSwitchStatusResponse {
    const c = this.config;
    const switches: KillSwitchStatusItem[] = [
      {
        key: "ai_real_calls",
        label: "AI real LLM calls",
        category: "ai",
        real_spend: true,
        state: areRealAiCallsEnabled(c) ? "live" : "blocked",
        detail: realAiCallsBlockedReason(c),
        pause_via: "set AI_ENABLE_REAL_CALLS=false (env/deploy)",
      },
      {
        key: "real_payments",
        label: "Real payments",
        category: "payments",
        real_spend: true,
        state: areRealPaymentsEnabled(c) ? "live" : "blocked",
        detail: realPaymentsBlockedReason(c),
        pause_via: "set PAYMENTS_ENABLE_REAL=false (env/deploy)",
      },
      {
        key: "real_messaging",
        label: "Real WhatsApp messaging",
        category: "messaging",
        real_spend: true,
        state: areRealMessagesEnabled(c) ? "live" : "blocked",
        detail: realMessagingBlockedReason(c),
        pause_via: "set MESSAGING_ENABLE_REAL=false (env/deploy)",
      },
      {
        key: "worker_otp_sms",
        // Worker OTP is REAL-ONLY (Fast2SMS); the lever is the global daily cap (0 = paused).
        label: "Worker OTP SMS (global daily send cap)",
        category: "auth_otp",
        real_spend: true,
        state: c.OTP_GLOBAL_MAX_SENDS_PER_DAY === 0 ? "paused" : "live",
        detail: `global daily send cap = ${c.OTP_GLOBAL_MAX_SENDS_PER_DAY}`,
        pause_via: "set OTP_GLOBAL_MAX_SENDS_PER_DAY=0 (env/deploy)",
      },
      {
        key: "payer_otp_email",
        label: "Payer OTP email (global daily send cap)",
        category: "auth_otp",
        real_spend: true,
        state: c.PAYER_OTP_GLOBAL_MAX_SENDS_PER_DAY === 0 ? "paused" : "live",
        detail: `global daily send cap = ${c.PAYER_OTP_GLOBAL_MAX_SENDS_PER_DAY}`,
        pause_via: "set PAYER_OTP_GLOBAL_MAX_SENDS_PER_DAY=0 (env/deploy)",
      },
      {
        key: "resume_render",
        label: "Resume + interview-kit PDF render",
        category: "render",
        real_spend: false,
        state: c.RESUME_RENDER_ENABLED ? "live" : "disabled",
        detail: c.RESUME_RENDER_ENABLED ? null : "RESUME_RENDER_ENABLED is false",
        pause_via: "set RESUME_RENDER_ENABLED=false (env/deploy)",
      },
      {
        key: "admin_pii_reveal",
        label: "Admin worker-PII reveal (ADMIN-3b)",
        category: "admin_pii",
        real_spend: false,
        state: c.ADMIN_PII_REVEAL_ENABLED ? "live" : "disabled",
        detail: c.ADMIN_PII_REVEAL_ENABLED ? null : "ADMIN_PII_REVEAL_ENABLED is false",
        pause_via: "set ADMIN_PII_REVEAL_ENABLED=false (env/deploy)",
      },
    ];

    return {
      switches,
      note: "Display + safe-direction PAUSE intent only. Enabling any real provider stays env/deploy-gated (never a portal toggle).",
    };
  }

  /**
   * Record an admin's SAFE-DIRECTION pause INTENT (OQ-6 b). Emits exactly ONE value-free
   * `admin.kill_switch_pause_requested` audit event (opaque admin_id + switch KEY + reason CODE).
   * It does NOT change runtime — the actual pause is applied via env/deploy (§2 #5). There is no
   * enable path anywhere in this service.
   *
   * @param adminId the session admin (`@CurrentAdmin().id`) — the non-spoofable actor.
   */
  async requestPause(
    adminId: string,
    dto: AdminKillSwitchPauseRequestDto,
    ctx: RequestContext,
  ): Promise<AdminKillSwitchPauseRequestResponse> {
    await this.events.emit({
      event_name: "admin.kill_switch_pause_requested",
      actor: { actor_type: "admin", actor_id: adminId },
      // A switch is not a uuid entity — the switch identity is the closed `switch_key` enum in
      // the payload; the subject_id is null (the `kill_switch` subject).
      subject: { subject_type: "kill_switch", subject_id: null },
      payload: {
        admin_id: adminId,
        switch_key: dto.switch_key,
        reason_code: dto.reason_code,
      } satisfies PayloadInputOf<"admin.kill_switch_pause_requested">,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
      // One audited intent per (admin, switch, request) — value-free dedup key.
      idempotencyKey: `admin_kill_switch_pause:${dto.switch_key}:${adminId}:${ctx.requestId}`,
    });

    // Log the FACT only — opaque admin id slice + switch KEY + reason CODE; never a value.
    this.logger.warn(
      `admin kill-switch PAUSE intent recorded admin_id=${adminId.slice(0, 8)}… switch=${dto.switch_key} reason=${dto.reason_code}`,
    );

    return {
      switch_key: dto.switch_key,
      recorded: true,
      action_required: `Apply the pause via env/deploy: ${pauseLeverFor(dto.switch_key)}. This portal records intent only — enabling or disabling a real provider is an env/deploy action, never a portal toggle.`,
    };
  }
}

/** The safe-direction env lever for a switch (mirrors the status `pause_via`) — a var name, no secret. */
function pauseLeverFor(key: AdminKillSwitchPauseRequestDto["switch_key"]): string {
  switch (key) {
    case "ai_real_calls":
      return "AI_ENABLE_REAL_CALLS=false";
    case "real_payments":
      return "PAYMENTS_ENABLE_REAL=false";
    case "real_messaging":
      return "MESSAGING_ENABLE_REAL=false";
    case "worker_otp_sms":
      return "OTP_GLOBAL_MAX_SENDS_PER_DAY=0";
    case "payer_otp_email":
      return "PAYER_OTP_GLOBAL_MAX_SENDS_PER_DAY=0";
    case "resume_render":
      return "RESUME_RENDER_ENABLED=false";
    case "admin_pii_reveal":
      return "ADMIN_PII_REVEAL_ENABLED=false";
  }
}
