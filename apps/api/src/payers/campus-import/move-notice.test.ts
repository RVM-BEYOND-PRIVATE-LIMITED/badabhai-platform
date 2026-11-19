import { describe, expect, it } from "vitest";
import { parseImportCampusCompaniesArgs } from "../import-campus-companies.cli";
import { composeMoveEmail, parseSignInUrl, skipReason } from "./move-notice";

/**
 * #2787 — the first sign-in message to a moved company: what it says, who cannot get it on which
 * channel, and the CLI flags of `--notify`. The send log and the once-per-channel rule are proved
 * against Postgres in `campus-company-import.db.test.ts`.
 */
const URL_ = "https://payer.example.in/login";

describe("composeMoveEmail", () => {
  it("a proven phone is told to sign in by SMS code, naming only its last four digits", () => {
    const m = composeMoveEmail({ signInUrl: URL_, signInBy: "sms_code", phoneLast4: "3210" });
    expect(m.subject).toBe("Your company account has moved to BadaBhai");
    expect(m.text).toContain(URL_);
    expect(m.text).toContain("ending in 3210");
    expect(m.text).toContain("code by SMS");
    expect(m.text).not.toContain("Account page");
    expect(m.html).toContain(`<a href="${URL_}">`);
  });

  it("no proven phone: sign in by email code, then confirm the phone", () => {
    const m = composeMoveEmail({ signInUrl: URL_, signInBy: "email_code", phoneLast4: null });
    expect(m.text).toContain("enter this email address");
    expect(m.text).toContain("Account page");
    expect(m.text).not.toContain("ending in");
  });

  it("says the jobs and the unused CV views moved, and carries no code or secret", () => {
    const m = composeMoveEmail({ signInUrl: URL_, signInBy: "email_code", phoneLast4: null });
    expect(m.text).toContain("live jobs");
    expect(m.text).toContain("CV views (now credits)");
    expect(m.text).not.toMatch(/\b\d{6}\b/);
  });

  it("escapes the address in the html", () => {
    const m = composeMoveEmail({ signInUrl: 'https://x.in/?a="<b>"', signInBy: "email_code", phoneLast4: null });
    expect(m.html).not.toContain("<b>");
    expect(m.html).toContain("&lt;b&gt;");
  });
});

describe("skipReason", () => {
  const ok = { status: "pending", email: "a@b.in", phoneE164: "+919876543210", phoneProven: true };

  it("delivers email and SMS to a reachable company with a proven phone and a template", () => {
    expect(skipReason(ok, "email", "123")).toBeNull();
    expect(skipReason(ok, "sms", "123")).toBeNull();
    expect(skipReason({ ...ok, status: "active" }, "email", null)).toBeNull();
  });

  it("an archived or suspended account gets nothing", () => {
    expect(skipReason({ ...ok, status: "archived" }, "email", "123")).toBe("account_archived");
    expect(skipReason({ ...ok, status: "suspended" }, "sms", "123")).toBe("account_suspended");
  });

  it("email needs an address, and never a reserved .invalid one (a synthetic pilot company)", () => {
    expect(skipReason({ ...ok, email: null }, "email", null)).toBe("no_email");
    expect(skipReason({ ...ok, email: "pilot1@seed.INVALID" }, "email", null)).toBe("undeliverable_address");
  });

  it("SMS needs a proven phone, then an approved template", () => {
    expect(skipReason({ ...ok, phoneProven: false }, "sms", "123")).toBe("phone_not_proven");
    expect(skipReason({ ...ok, phoneE164: null, phoneProven: false }, "sms", "123")).toBe("phone_not_proven");
    expect(skipReason(ok, "sms", null)).toBe("template_missing");
  });
});

describe("parseSignInUrl", () => {
  it("accepts https, and http only on a local stack", () => {
    expect(parseSignInUrl(URL_)).toBe(URL_);
    expect(parseSignInUrl("http://localhost:3002/login")).toBe("http://localhost:3002/login");
    expect(() => parseSignInUrl("http://payer.example.in/login")).toThrow(/https/);
    expect(() => parseSignInUrl("payer.example.in")).toThrow(/full address/);
    expect(() => parseSignInUrl("https://u:p@payer.example.in")).toThrow(/credentials/);
  });
});

describe("the --notify arguments", () => {
  const base = ["--notify", "--batch", "pilot-2", "--signin-url", URL_];

  it("without --send it is a preview and needs no operator label", () => {
    expect(parseImportCampusCompaniesArgs(base)).toEqual({
      mode: "notify",
      batch: "pilot-2",
      send: false,
      runBy: "preview",
      signInUrl: URL_,
      smsTemplateId: null,
    });
  });

  it("--send needs who is running it, and takes an optional numeric template id", () => {
    expect(() => parseImportCampusCompaniesArgs([...base, "--send"])).toThrow(/--run-by/);
    expect(
      parseImportCampusCompaniesArgs([...base, "--send", "--run-by", "prakash", "--sms-template-id", "171234"]),
    ).toMatchObject({ mode: "notify", send: true, runBy: "prakash", smsTemplateId: "171234" });
    expect(() => parseImportCampusCompaniesArgs([...base, "--sms-template-id", "abc"])).toThrow(/numeric/);
  });

  it("needs a batch and a sign-in address, and takes no bundle or import flag", () => {
    expect(() => parseImportCampusCompaniesArgs(["--notify", "--signin-url", URL_])).toThrow(/--batch/);
    expect(() => parseImportCampusCompaniesArgs(["--notify", "--batch", "pilot-2"])).toThrow(/--signin-url/);
    expect(() => parseImportCampusCompaniesArgs([...base, "--bundle", "x"])).toThrow(/--bundle/);
    expect(() => parseImportCampusCompaniesArgs([...base, "--apply"])).toThrow(/cannot be combined/);
    expect(() => parseImportCampusCompaniesArgs([...base, "--test"])).toThrow(/--notify/);
  });

  it("the notify flags need --notify", () => {
    expect(() => parseImportCampusCompaniesArgs(["--bundle", "x", "--send"])).toThrow(/--send needs --notify/);
    expect(() => parseImportCampusCompaniesArgs(["--bundle", "x", "--signin-url", URL_])).toThrow(/needs --notify/);
    expect(() => parseImportCampusCompaniesArgs(["--bundle", "x", "--sms-template-id", "1"])).toThrow(/needs --notify/);
  });
});
