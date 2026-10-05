import { beforeEach, describe, expect, it, vi } from "vitest";
import { PayerValidationError } from "../../../../../lib/payer-errors";

/**
 * AI job-posting chat Server Actions (#1912). The chat has no per-field inputs, so a
 * publish 400's field-NAMING issues are surfaced as the error message itself — not the
 * generic retry copy.
 */
const publishJobPostingChatSession = vi.fn();

vi.mock("../../../../../lib/payer-api", () => ({
  publishJobPostingChatSession: (id: unknown) => publishJobPostingChatSession(id),
  startJobPostingChatSession: vi.fn(),
  sendJobPostingChatMessage: vi.fn(),
  getJobPostingChatTranscript: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { publishJobPostingChatAction } = await import("./actions");

const SESSION = "cccc3333-0000-4000-8000-000000000001";

beforeEach(() => {
  publishJobPostingChatSession.mockReset();
});

describe("publishJobPostingChatAction (#1912)", () => {
  it("surfaces a validation 400's field-naming message instead of the generic retry copy", async () => {
    publishJobPostingChatSession.mockRejectedValueOnce(
      new PayerValidationError("x", [
        { path: "role_title", message: "remove contact details from the title" },
      ]),
    );
    const res = await publishJobPostingChatAction({ sessionId: SESSION });
    expect(res).toEqual({ ok: false, error: "remove contact details from the title" });
  });

  it("a 409 (not ready / already published) stays the generic retryable copy", async () => {
    publishJobPostingChatSession.mockRejectedValueOnce(new Error("payer API x returned 409"));
    const res = await publishJobPostingChatAction({ sessionId: SESSION });
    expect(res).toEqual({
      ok: false,
      error: "Could not publish this posting yet. Please retry.",
    });
  });

  it("success returns the posting id + the unset card fields", async () => {
    publishJobPostingChatSession.mockResolvedValueOnce({
      jobPostingId: "job-1",
      unsetCardFields: ["role_kind"],
      unmappedFields: [],
    });
    const res = await publishJobPostingChatAction({ sessionId: SESSION });
    expect(res).toEqual({ ok: true, postingId: "job-1", unsetCardFields: ["role_kind"] });
  });
});
