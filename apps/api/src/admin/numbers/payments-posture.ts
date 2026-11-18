import {
  areRealPaymentsEnabled,
  realPaymentsBlockedReason,
  type ServerConfig,
} from "@badabhai/config";
import type { PaymentsPosture } from "../admin-finance.dto";

/**
 * Whether money on the numbers screen is real — the finance summary's posture, from the SAME config
 * helpers the kill-switch surface uses, so the screens can never disagree. Every response of the
 * numbers screen that carries money carries this beside it.
 */
export function numbersPaymentsPosture(config: ServerConfig): PaymentsPosture {
  return {
    mode: areRealPaymentsEnabled(config) ? "real" : "mock",
    blocked_reason: realPaymentsBlockedReason(config),
  };
}
