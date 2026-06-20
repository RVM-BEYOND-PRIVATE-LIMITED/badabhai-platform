import { Inject, Injectable } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { realMessagingBlockedReason } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import type { WhatsAppMessage, WhatsAppProvider, WhatsAppSendResult } from "./whatsapp.provider";

/**
 * Real Meta WhatsApp Cloud API provider — STUB, human-gated (ADR-0020 Phase 3).
 *
 * Selected only when `MESSAGING_ENABLE_REAL=true` AND the WhatsApp keys are set
 * (`realMessagingBlockedReason` === null). It is intentionally NOT implemented: a
 * real send means provider SPEND + a worker's phone reaching Meta, which require a
 * recorded human sign-off, template approval, and staging-first rollout (CLAUDE.md
 * §7). It FAILS CLOSED — `send` throws — so that even if the flag + keys are set, no
 * real message goes out until this is deliberately built behind the human gate.
 */
@Injectable()
export class MetaWhatsAppProvider implements WhatsAppProvider {
  constructor(@Inject(SERVER_CONFIG) private readonly config: ServerConfig) {}

  async send(_message: WhatsAppMessage): Promise<WhatsAppSendResult> {
    const blocked = realMessagingBlockedReason(this.config);
    if (blocked) {
      // Defense-in-depth: should never be selected while blocked.
      throw new Error(`Real WhatsApp send blocked: ${blocked}`);
    }
    throw new Error(
      "Real WhatsApp send is not implemented — human-gated (ADR-0020 Phase 3: keys/spend, " +
        "template approval, staging-first). Mock provider is the alpha default.",
    );
  }
}
