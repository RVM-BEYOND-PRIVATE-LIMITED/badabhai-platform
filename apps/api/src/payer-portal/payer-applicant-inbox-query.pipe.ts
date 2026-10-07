import { Inject, Injectable, type PipeTransform } from "@nestjs/common";
import { SERVER_CONFIG } from "../config/config.module";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { applicantStagesEnabled, type ApplicantStagesConfig } from "./payer-applicant-stages.flag";
import {
  PayerApplicantInboxQuerySchema,
  PayerApplicantInboxStagedQuerySchema,
  type PayerApplicantInboxQueryDto,
} from "./payer-applicant-inbox.dto";

/**
 * `GET /payer/reach/applicants` query validation, by flag (owner ruling 2026-10-07):
 *  - `PAYER_APPLICANT_STAGES_ENABLED` OFF → {@link PayerApplicantInboxQuerySchema}, the query as it
 *    has always been: `?stage=` is an unknown key and the SAME 400 body as before;
 *  - ON → {@link PayerApplicantInboxStagedQuerySchema}, which adds the optional `stage` filter.
 *
 * A pipe rather than a check in the handler so validation still runs where it always ran — before
 * the handler, before the reach cap is charged — and the controller keeps its single typed `query`.
 * Injectable (constructed by Nest with the @Global `SERVER_CONFIG`), the error is the shared
 * `ZodValidationPipe`'s, byte for byte.
 */
@Injectable()
export class PayerApplicantInboxQueryPipe implements PipeTransform {
  constructor(@Inject(SERVER_CONFIG) private readonly config: ApplicantStagesConfig) {}

  transform(value: unknown): PayerApplicantInboxQueryDto {
    const schema = applicantStagesEnabled(this.config)
      ? PayerApplicantInboxStagedQuerySchema
      : PayerApplicantInboxQuerySchema;
    return new ZodValidationPipe(schema).transform(value);
  }
}
