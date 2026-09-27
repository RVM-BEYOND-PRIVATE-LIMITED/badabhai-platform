import "reflect-metadata";
import { BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import type { AuthenticatedWorker } from "../auth/worker-auth.guard";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import type { RequestContext } from "../common/request-context";
import { WorkerQualificationsController } from "./worker-qualifications.controller";
import { SetMyQualificationsSchema } from "./worker-qualifications.dto";
import type { WorkerQualificationsService } from "./worker-qualifications.service";
import {
  EDUCATION_COUNCILS,
  EDUCATION_QUALIFICATIONS,
  TRADE_FORM_EDUCATION_QUALIFICATIONS,
} from "./worker-preferences.vocabulary";

/**
 * The qualifications page's OPTIONS contract, and the one place the chips and the labels part.
 *
 * ADR-0045 §6 widened the credential ladder to eight (`postgraduate`, `doctorate`) for the general
 * road and kept the trade forms' choices at six. The trade forms render `education_credential`
 * as-is, so that key is where R1 ("the 21 keep today's path exactly") is either held or broken —
 * and nothing else would notice: every existing test reads the dictionaries, not this response.
 *
 * The service is not constructed for `options()`: it is a pure read of static dictionaries, and a
 * null service is the assertion that it stays one.
 */
function controller(service: unknown = null): WorkerQualificationsController {
  return new WorkerQualificationsController(service as WorkerQualificationsService);
}

describe("GET /workers/me/qualifications/options", () => {
  it("serves exactly three keys — the ADR-0045 label map is the only addition", () => {
    expect(Object.keys(controller().options()).sort()).toEqual([
      "education_council",
      "education_credential",
      "education_credential_labels",
    ]);
  });

  it("keeps the trade forms' credential CHIPS at today's six, in ladder order", () => {
    const { education_credential: chips } = controller().options();
    // By reference: the subset constant is the one place the trade forms' choice is made.
    expect(chips).toBe(TRADE_FORM_EDUCATION_QUALIFICATIONS);
    // And pinned literally, because a reference check alone passes whatever the constant becomes.
    expect(Object.entries(chips)).toEqual([
      ["below_10", "Below 10th"],
      ["class_10", "10th pass"],
      ["class_12", "12th pass"],
      ["iti", "ITI"],
      ["diploma", "Diploma"],
      ["graduate", "Graduate"],
    ]);
    expect(chips).not.toHaveProperty("postgraduate");
    expect(chips).not.toHaveProperty("doctorate");
  });

  it("labels EVERY credential the validator accepts, so a stored postgraduate row has a label", () => {
    const { education_credential: chips, education_credential_labels: labels } =
      controller().options();
    expect(labels).toBe(EDUCATION_QUALIFICATIONS);
    expect(labels.postgraduate).toBe("Postgraduate");
    expect(labels.doctorate).toBe("Doctorate");
    // THE CHIPS ARE A SUBSET OF THE LABELS, WORD FOR WORD — a trade-form chip and the label an
    // extracted-review screen prints for the same slug must never differ.
    for (const [slug, label] of Object.entries(chips)) expect(labels[slug], slug).toBe(label);
    // EVERY LABELLED SLUG IS ONE THE PUT ACCEPTS, so the label map can never name a credential the
    // worker could not have stored.
    for (const credential of Object.keys(labels)) {
      expect(
        SetMyQualificationsSchema.safeParse({ educations: [{ credential }] }).success,
        credential,
      ).toBe(true);
    }
  });

  it("serves the councils by reference, unchanged", () => {
    expect(controller().options().education_council).toBe(EDUCATION_COUNCILS);
  });

  it("discloses no worker data", () => {
    expect(JSON.stringify(controller().options())).not.toMatch(
      /worker_?id|phone|full_?name|email/i,
    );
  });
});

describe("PUT /workers/me/qualifications", () => {
  const WORKER: AuthenticatedWorker = { id: "w-1", sid: "s-1" };
  const CTX = { requestId: "r-1" } as RequestContext;
  const pipe = new ZodValidationPipe(SetMyQualificationsSchema);

  function withService() {
    const qualifications = {
      replaceForWorker: vi.fn(async () => ({
        worker_id: "w-1",
        certificate_count: 0,
        education_count: 1,
      })),
    };
    return { controller: controller(qualifications), qualifications };
  }

  it("accepts a postgraduate row through the PUT's own pipe, from any client (ADR-0045 §6)", async () => {
    // THE VALIDATOR IS SHARED: a trade-form build does not offer the chip, but a body carrying the
    // slug — the general form's, or an extracted correction — is the same valid write everywhere.
    const dto = pipe.transform({
      educations: [{ credential: "postgraduate", field: "M.Sc Chemistry", year: 2019 }],
    });
    expect(dto.educations?.[0]?.credential).toBe("postgraduate");

    const { controller: c, qualifications } = withService();
    const res = await c.setMyQualifications(WORKER, dto, CTX);
    // The worker id is the SESSION's, and the answer is counts only.
    expect(qualifications.replaceForWorker).toHaveBeenCalledWith("w-1", dto, CTX);
    expect(res).toEqual({ ok: true, certificate_count: 0, education_count: 1 });
    expect(JSON.stringify(res)).not.toContain("Chemistry");
  });

  it("refuses a credential slug no dictionary holds, naming the field", () => {
    let thrown: unknown;
    try {
      pipe.transform({ educations: [{ credential: "phd" }] });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(BadRequestException);
    const body = (thrown as BadRequestException).getResponse() as {
      issues: { path: string }[];
    };
    expect(body.issues.map((i) => i.path)).toContain("educations.0.credential");
  });
});
