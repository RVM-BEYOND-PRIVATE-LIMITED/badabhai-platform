import { type CanActivate, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";

/**
 * Launch gate for the AGENCY SUPPLY-MONEY surface (ADR-0022 Amendment 2). When
 * `AGENCY_PAYOUTS_ENABLED` is OFF (the fail-safe default) EVERY agency KYC/earnings/payout
 * route is a NEUTRAL 404 — the surface is fully inert, and no financial PII (PAN/bank) can even
 * be collected. Mirrors the `TEST_LOGIN_ENABLED` inert-404 pattern. Flipping the flag ON is a
 * launch decision that presupposes the legal/DPDP sign-off on live KYC collection (ADR-0022
 * Appendix D#2) and stays MOCK for money (real disbursement is the separate §7 gate).
 */
@Injectable()
export class AgencyPayoutsEnabledGuard implements CanActivate {
  constructor(@Inject(SERVER_CONFIG) private readonly config: ServerConfig) {}

  canActivate(): boolean {
    if (!this.config.AGENCY_PAYOUTS_ENABLED) {
      // Neutral 404 — indistinguishable from a non-existent route (no "disabled" oracle).
      throw new NotFoundException();
    }
    return true;
  }
}
