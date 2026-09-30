import { Module } from "@nestjs/common";
import { ReferralLinkRepository } from "./referral-link.repository";
import { ReferralLinkService } from "./referral-link.service";
import { ResumeQrLinkService } from "./resume-qr-link.service";

/**
 * The B4 RESOLVER PRIMITIVE's data + logic (`referral_links` / `referral_clicks`), as a module of
 * its own so a second consumer can reach it without importing the whole attribution chain (#1800).
 *
 * Two consumers, both one-directional (no cycle — this module imports nothing):
 *  - {@link ReferralAttributionModule} — the `GET /r/:code` resolver controller and the
 *    first-touch claim (`ReferralLinkService`).
 *  - `ResumeModule` — the render worker's get-or-create of the worker's `resume_qr` link
 *    (`ResumeQrLinkService`), whose `/r/<code>` their own résumé QR encodes.
 *
 * NO IMPORTS NEEDED: DatabaseModule, EventsModule, ConfigModule and CryptoModule are all
 * `@Global()`. ONE INSTANCE of each provider: `ReferralAttributionModule` no longer declares the
 * repository or the service itself, it imports them from here.
 */
@Module({
  providers: [ReferralLinkRepository, ReferralLinkService, ResumeQrLinkService],
  exports: [ReferralLinkRepository, ReferralLinkService, ResumeQrLinkService],
})
export class ReferralLinksModule {}
