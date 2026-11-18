import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { PiiCryptoService } from "../common/pii-crypto.service";
import {
  agencyNameByCodeStatement,
  type ReferralHelperNameRepository,
} from "./referral-helper-name.repository";
import { ReferralHelperNameService } from "./referral-helper-name.service";

const CODE = "abcdef012345";

function make(nameEnc: string | null | Error = null) {
  const repo = {
    findAgencyNameEnc: vi.fn(async (_code: string): Promise<string | null> => {
      if (nameEnc instanceof Error) throw nameEnc;
      return nameEnc;
    }),
  };
  const pii = { decrypt: vi.fn((token: string) => token.replace(/^enc:/, "")) };
  const svc = new ReferralHelperNameService(
    repo as unknown as ReferralHelperNameRepository,
    pii as unknown as PiiCryptoService,
  );
  return { svc, repo, pii };
}

describe("ReferralHelperNameService.displayName (#2753 item 12)", () => {
  it("a live agency code → the decrypted company name", async () => {
    const { svc, repo, pii } = make("enc:Sharma Placement Agency");
    await expect(svc.displayName(CODE)).resolves.toBe("Sharma Placement Agency");
    expect(repo.findAgencyNameEnc).toHaveBeenCalledWith(CODE);
    expect(pii.decrypt).toHaveBeenCalledWith("enc:Sharma Placement Agency");
  });

  it("trims the stored name, and a blank one is null", async () => {
    await expect(make("enc:  Sharma Agency  ").svc.displayName(CODE)).resolves.toBe(
      "Sharma Agency",
    );
    await expect(make("enc:   ").svc.displayName(CODE)).resolves.toBeNull();
  });

  it("no agency row (a worker's code, unknown, expired, spent) → null, nothing decrypted", async () => {
    const { svc, pii } = make(null);
    await expect(svc.displayName(CODE)).resolves.toBeNull();
    expect(pii.decrypt).not.toHaveBeenCalled();
  });

  it.each([
    ["upper-case hex", "ABCDEF012345"],
    ["too short", "abcdef01234"],
    ["too long", "abcdef0123456"],
    ["not hex", "ghijkl012345"],
    ["padded", " abcdef012345"],
    ["empty", ""],
    ["missing", undefined],
    ["repeated (an array)", [CODE, CODE]],
    ["an object", { code: CODE }],
  ])(
    "a malformed code (%s) → null, after the SAME one query with a never-a-code value",
    async (_n, code) => {
      // The repo would answer a name if asked with the real code: the shape check must win.
      const { svc, repo, pii } = make("enc:Sharma Placement Agency");
      await expect(svc.displayName(code)).resolves.toBeNull();
      expect(repo.findAgencyNameEnc).toHaveBeenCalledOnce();
      const asked = repo.findAgencyNameEnc.mock.calls[0]![0];
      expect(asked).not.toEqual(code);
      expect(asked).not.toMatch(/^[a-f0-9]{12}$/);
      expect(pii.decrypt).not.toHaveBeenCalled();
    },
  );

  it("a lookup failure is null (fail closed), never a throw", async () => {
    const { svc } = make(new Error("db down"));
    await expect(svc.displayName(CODE)).resolves.toBeNull();
  });

  it("a decrypt failure is null (fail closed), never a throw", async () => {
    const { svc, pii } = make("enc:garbled");
    pii.decrypt.mockImplementation(() => {
      throw new Error("bad tag");
    });
    await expect(svc.displayName(CODE)).resolves.toBeNull();
  });
});

describe("agencyNameByCodeStatement — what the one query can return", () => {
  const compiled = new PgDialect().sqlToQuery(agencyNameByCodeStatement(CODE));
  const text = compiled.sql.replace(/\s+/g, " ");

  it("binds the code as a parameter, never into the text", () => {
    expect(text).not.toContain(CODE);
    expect(compiled.params.every((p) => p === CODE)).toBe(true);
  });

  it("returns only the payer's org-name ciphertext and names no worker table", () => {
    expect(text).toMatch(/^select p\.org_name_enc as "name_enc" from payers p /);
    expect(text).not.toMatch(/\bworkers\b|full_name|phone/);
  });

  it("only an ACTIVE agency, from an unspent agency invite or an unexpired agent link", () => {
    expect(text).toContain("p.role = 'agent'");
    expect(text).toContain("p.status = 'active'");
    expect(text).toContain("ai.invited_worker_id is null");
    expect(text).toContain("rl.kind = 'agent'");
    expect(text).toContain("(rl.expires_at is null or rl.expires_at > now())");
  });

  it("never for a worker's invite or a résumé QR (where the attribution hook stops)", () => {
    expect(text).toContain("not exists (select 1 from invites i where i.code = $");
    expect(text).toMatch(
      /not exists \( select 1 from referral_links q where q\.code = \$\d+ and q\.kind = 'resume_qr' \)/,
    );
  });
});
