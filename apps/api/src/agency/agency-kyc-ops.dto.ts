import { z } from "zod";
import { AgencyKycRejectReason } from "@badabhai/event-schema";

/** Ops route param — the target agency payer id (uuid), never a body id. */
export const OpsAgencyKycParamSchema = z.object({ payerId: z.string().uuid() }).strict();
export type OpsAgencyKycParamDto = z.infer<typeof OpsAgencyKycParamSchema>;

/** Ops reject body — a bounded reason CODE only (never a free-text note that could carry PII). */
export const OpsRejectAgencyKycSchema = z.object({ reason: AgencyKycRejectReason }).strict();
export type OpsRejectAgencyKycDto = z.infer<typeof OpsRejectAgencyKycSchema>;
