import { Inject, Injectable, type PipeTransform } from "@nestjs/common";
import { SERVER_CONFIG } from "../config/config.module";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { applicantStagesEnabled, type ApplicantStagesConfig } from "./payer-applicant-stages.flag";
import {
  PayerApplicantFeedQuerySchema,
  type PayerApplicantFeedQueryDto,
} from "./payer-applicant-feed-query.dto";

/**
 * `GET /payer/reach/jobs/:jobId/applicants` query validation, by flag (#2737):
 *  - `PAYER_APPLICANT_STAGES_ENABLED` OFF → no query contract at all, exactly as before the
 *    stage filter existed (`{}`; `?stage=` cannot silently filter a board that is not saved);
 *  - ON → {@link PayerApplicantFeedQuerySchema}: optional `stage` (`new` when absent, or
 *    `shortlist` / `passed` / `all`).
 *
 * A pipe rather than a check in the handler so validation still runs before the reach cap is
 * charged, and the controller keeps its single typed `query`. Injectable (constructed by Nest
 * with the @Global `SERVER_CONFIG`), the error is the shared `ZodValidationPipe`'s, byte for byte.
 */
@Injectable()
export class PayerApplicantFeedQueryPipe implements PipeTransform {
  constructor(@Inject(SERVER_CONFIG) private readonly config: ApplicantStagesConfig) {}

  transform(value: unknown): PayerApplicantFeedQueryDto {
    if (!applicantStagesEnabled(this.config)) return {};
    return new ZodValidationPipe(PayerApplicantFeedQuerySchema).transform(value);
  }
}
