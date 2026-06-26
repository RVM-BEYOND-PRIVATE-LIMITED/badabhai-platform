import { describe, expect, it } from "vitest";
import { inviteOrgMember, listOrgMembers, removeOrgMember } from "./org-members";

/**
 * (e) STUB data source — proves there is NO fabricated member data and the mutations are inert
 * no-ops until the org directory API lands. listOrgMembers returns an EMPTY list (the Owner UI
 * scaffolds an empty state, never fake members); invite/remove report a neutral not-available.
 * `server-only` is aliased to a no-op in vitest (see vitest.config.ts) so this module loads here.
 */
describe("org-members STUB — no fabricated data; inert until the org API lands", () => {
  it("listOrgMembers returns an EMPTY list (no member directory yet — zero fabricated rows)", async () => {
    expect(await listOrgMembers()).toEqual([]);
  });

  it("inviteOrgMember is a no-op that reports not-yet-available (never a fabricated success)", async () => {
    const res = await inviteOrgMember({ email: "recruiter@example.test", orgRole: "recruiter" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/isn.t available yet|org directory/i);
  });

  it("removeOrgMember is a no-op that reports not-yet-available", async () => {
    const res = await removeOrgMember({ memberId: "stub-member-1" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/isn.t available yet|org directory/i);
  });
});
