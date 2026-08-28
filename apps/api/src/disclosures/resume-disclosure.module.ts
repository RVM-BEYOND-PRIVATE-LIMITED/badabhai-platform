import { Module } from "@nestjs/common";
import { ConsentModule } from "../consent/consent.module";
import { StorageModule } from "../storage/storage.module";
import { ResumeDisclosureController } from "./resume-disclosure.controller";
import { ResumeDisclosureService } from "./resume-disclosure.service";
import { ResumeDisclosureRepository } from "./resume-disclosure.repository";
import { ResumeRenderer } from "../resume/resume-renderer.service";
import { WorkerAttributesRepository } from "../profiles/worker-attributes.repository";
import { WorkerEmploymentRepository } from "../profiles/worker-employment.repository";

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
 *
 * `WorkerAttributesRepository` is PROVIDED HERE RATHER THAN IMPORTED FROM ProfilesModule, for
 * the same reason ResumeRenderer is: its only dependency is the @Global DATABASE, so providing
 * it costs nothing and adds no edge to the module graph. Importing ProfilesModule for one
 * read-only repository would couple the payer disclosure surface to the whole profiles subtree
 * and give a future change there a way to break THIS module's boot — the failure mode that
 * typecheck, lint and unit tests all pass straight through. It feeds the trade capability block
 * on the masked sheet.
 *
 * `WorkerEmploymentRepository` is provided on exactly the same terms and feeds Zone 4. Its two
 * dependencies — the @Global DATABASE and the @Global CryptoModule's PiiCryptoService — are both
 * already resolvable here, so it adds no edge either.
 */
@Module({
  imports: [ConsentModule, StorageModule],
  controllers: [ResumeDisclosureController],
  providers: [
    ResumeDisclosureService,
    ResumeDisclosureRepository,
    ResumeRenderer,
    WorkerAttributesRepository,
    WorkerEmploymentRepository,
  ],
  // Exported so the payer portal can mount a PayerAuthGuard'd disclosure surface
  // (PayerDisclosureController) over the SAME chokepoint, exactly as ReachModule exports
  // ReachService for PayerReachController. The InternalServiceGuard ops route is unchanged.
  exports: [ResumeDisclosureService],
})
export class ResumeDisclosureModule {}
