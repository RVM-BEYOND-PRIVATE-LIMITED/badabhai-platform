import { Module } from "@nestjs/common";
import { ConsentModule } from "../consent/consent.module";
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
 * Imports ConsentModule (ConsentRepository — the employer_sharing gate) and
 * StorageModule (StorageService — masked-PDF upload + short-TTL signed URL). The
 * ResumeRenderer is provided here (its only dep, PdfRenderer, is @Global via PdfModule).
 * EventsService, the Drizzle DATABASE, WorkersRepository, PiiCryptoService, and
 * SERVER_CONFIG are all @Global, so they need no import.
 */
@Module({
  imports: [ConsentModule, StorageModule],
  controllers: [ResumeDisclosureController],
  providers: [ResumeDisclosureService, ResumeDisclosureRepository, ResumeRenderer],
})
export class ResumeDisclosureModule {}
