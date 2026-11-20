import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PayerBadRequestError,
  PayerConflictError,
  PayerForbiddenError,
} from "../../../lib/payer-errors";

/**
 * #2813 — campus-drive Server Actions. Pins:
 *  - the body goes to the seam in the form's shape, with the ONE idempotency key it was given;
 *  - a 403 `company_not_verified` carries the `missing` steps through;
 *  - the roles-note 400 and the reused-key 409 keep their machine reason;
 *  - cancel reads its 409 reason.
 * No contact name/phone is ever included in an error result.
 */

const createCampusDriveRequest = vi.fn();
const cancelCampusDriveRequest = vi.fn();
const revalidatePath = vi.fn();

vi.mock("../../../lib/payer-api", () => ({
  createCampusDriveRequest: (input: unknown, key: unknown) =>
    createCampusDriveRequest(input, key),
  cancelCampusDriveRequest: (id: unknown) => cancelCampusDriveRequest(id),
}));
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => revalidatePath(p) }));

const { createCampusDriveAction, cancelCampusDriveAction } = await import("./actions");

const ID = "5a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const INPUT = {
  branchIds: [1],
  preferredFrom: "2026-12-01",
  preferredTo: "2026-12-15",
  openings: 12,
  rolesNote: "CNC operators",
  contactName: "Ravi Sharma",
  contactPhone: "+919876543210",
  idempotencyKey: "key-01234567",
};

beforeEach(() => {
  createCampusDriveRequest.mockReset().mockResolvedValue({ id: ID, status: "requested" });
  cancelCampusDriveRequest.mockReset().mockResolvedValue({ id: ID, status: "cancelled" });
  revalidatePath.mockReset();
});

describe("createCampusDriveAction", () => {
  it("sends the validated body and the ONE idempotency key to the seam", async () => {
    const res = await createCampusDriveAction(INPUT);
    expect(res).toEqual({ ok: true, request: { id: ID, status: "requested" } });
    expect(createCampusDriveRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        branchIds: [1],
        preferredFrom: "2026-12-01",
        preferredTo: "2026-12-15",
        openings: 12,
        rolesNote: "CNC operators",
        contactName: "Ravi Sharma",
        contactPhone: "+919876543210",
      }),
      "key-01234567",
    );
    expect(revalidatePath).toHaveBeenCalledWith("/campus-drives");
  });

  it("a 403 company_not_verified carries the missing steps (no contact in the result)", async () => {
    createCampusDriveRequest.mockRejectedValueOnce(
      new PayerForbiddenError("/payer/campus-drive-requests", "company_not_verified", [
        "admin_approval",
        "gst_number",
      ]),
    );
    const res = await createCampusDriveAction(INPUT);
    expect(res).toEqual({
      ok: false,
      reason: "company_not_verified",
      missing: ["admin_approval", "gst_number"],
    });
    expect(JSON.stringify(res)).not.toContain("Ravi");
    expect(JSON.stringify(res)).not.toContain("9876543210");
  });

  it("the roles-note identifier 400 keeps its reason", async () => {
    createCampusDriveRequest.mockRejectedValueOnce(
      new PayerBadRequestError("/payer/campus-drive-requests", "roles_note_has_identifier"),
    );
    await expect(createCampusDriveAction(INPUT)).resolves.toEqual({
      ok: false,
      reason: "roles_note_has_identifier",
    });
  });

  it("the reused idempotency key 409 keeps its reason", async () => {
    createCampusDriveRequest.mockRejectedValueOnce(
      new PayerConflictError("/payer/campus-drive-requests", null, "idempotency_key_reused"),
    );
    await expect(createCampusDriveAction(INPUT)).resolves.toEqual({
      ok: false,
      reason: "idempotency_key_reused",
    });
  });

  it("a malformed key is refused before the wire", async () => {
    const res = await createCampusDriveAction({ ...INPUT, idempotencyKey: "bad key" });
    expect(res).toEqual({ ok: false, reason: "idempotency_key_required" });
    expect(createCampusDriveRequest).not.toHaveBeenCalled();
  });
});

describe("cancelCampusDriveAction", () => {
  it("returns the cancelled request on success", async () => {
    await expect(cancelCampusDriveAction(ID)).resolves.toEqual({
      ok: true,
      request: { id: ID, status: "cancelled" },
    });
  });

  it("keeps the 409 not-cancellable reason", async () => {
    cancelCampusDriveRequest.mockRejectedValueOnce(
      new PayerConflictError("/payer/campus-drive-requests", null, "drive_request_not_cancellable"),
    );
    await expect(cancelCampusDriveAction(ID)).resolves.toEqual({
      ok: false,
      reason: "drive_request_not_cancellable",
    });
  });
});
