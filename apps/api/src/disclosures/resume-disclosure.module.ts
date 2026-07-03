import { Module } from "@nestjs/common";
import { ConsentModule } from "../consent/consent.module";
import { PayersModule } from "../payers/payers.module";
import { StorageModule } from "../storage/storage.module";
import { ResumeDisclosureController } from "./resume-disclosure.controller";
import { ResumeDisclosureService } from "./resume-disclosure.service";
import { ResumeDisclosureRepository } from "./resume-disclosure.repository";
import { ResumeRenderer } from "../resume/resume-renderer.service";

/**
 * Resume Disclosure (ADR-0013 Decision C / the resume-disclosure threat-model
 * addendum): the FREE, consented, capped, no-oracle, identity-MASKED employer resume
 * disclosure. controller (thin, InternalServiceGuard) → ResumeDisclosureService (the
 * fail-closed chokepoint + the single decrypt + masking + event emission) →
 * ResumeDisclosureRepository (resume_disclosures writes + the SHARED-cap reads).
 *
 * Imports ConsentModule (ConsentRepository — the employer_sharing gate), StorageModule
 * (StorageService — masked-PDF upload + short-TTL signed URL), and PayersModule
 * (PayerOrgsRepository — the ADR-0027 B5.x Inc 4 payer→org tenancy resolver). The
 * ResumeRenderer is provided here (its only dep, PdfRenderer, is @Global via PdfModule).
 * EventsService, the Drizzle DATABASE, WorkersRepository, PiiCryptoService, and
 * SERVER_CONFIG are all @Global, so they need no import.
 */
@Module({
  imports: [ConsentModule, PayersModule, StorageModule],
  controllers: [ResumeDisclosureController],
  providers: [ResumeDisclosureService, ResumeDisclosureRepository, ResumeRenderer],
  // Exported so the payer portal can mount a PayerAuthGuard'd disclosure surface
  // (PayerDisclosureController) over the SAME chokepoint, exactly as ReachModule exports
  // ReachService for PayerReachController. The InternalServiceGuard ops route is unchanged.
  exports: [ResumeDisclosureService],
})
export class ResumeDisclosureModule {}
