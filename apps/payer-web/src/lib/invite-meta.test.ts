import { describe, expect, it } from "vitest";
import { inviteContextSlugError, parseInviteMeta } from "./invite-meta";

/**
 * INVITE METADATA (W1) — the closed shape is the whole security property.
 *
 * `context` is written to `agency_invites.payload` (jsonb) by an AGENCY-facing endpoint. A
 * free-shape object there would be the widest PII surface that table has ever had: an
 * agency could park `{name, phone, notes}` per invite and rebuild the dead bulk upload one
 * row at a time. So these tests pin REFUSAL, not just acceptance — and specifically that an
 * unknown key is a LOUD failure rather than a silent strip, which is the rule the backend
 * DTO states explicitly.
 */

describe("parseInviteMeta — medium", () => {
  it("accepts the two real media", () => {
    expect(parseInviteMeta({ medium: "organic" })).toEqual({
      ok: true,
      medium: "organic",
      context: undefined,
    });
    expect(parseInviteMeta({ medium: "paid" })).toEqual({
      ok: true,
      medium: "paid",
      context: undefined,
    });
  });

  it("treats an untouched (empty) select as ABSENT, not invalid", () => {
    // An unset optional field posts "" and must behave exactly like a pre-W1 mint.
    expect(parseInviteMeta({ medium: "" })).toEqual({
      ok: true,
      medium: undefined,
      context: undefined,
    });
  });

  it("refuses anything outside the closed pair", () => {
    // The column has a CHECK constraint; letting an unknown value through would turn a
    // reviewable refusal into a 500 from Postgres.
    for (const bad of ["sms-blast", "ORGANIC", "email", "organic paid"]) {
      const res = parseInviteMeta({ medium: bad });
      expect(res.ok, `medium=${JSON.stringify(bad)} should be refused`).toBe(false);
    }
  });

  it("trims surrounding whitespace rather than refusing over it", () => {
    // Stray whitespace is a transport artefact, not a different value — refusing it would
    // be a confusing dead end for something the caller cannot see.
    expect(parseInviteMeta({ medium: "  paid  " })).toEqual({
      ok: true,
      medium: "paid",
      context: undefined,
    });
  });
});

describe("parseInviteMeta — context is a CLOSED shape", () => {
  it("accepts role and city slugs", () => {
    expect(parseInviteMeta({ context: { role: "welder", city: "pune-west" } })).toEqual({
      ok: true,
      medium: undefined,
      context: { role: "welder", city: "pune-west" },
    });
  });

  it("accepts just one of the two", () => {
    const res = parseInviteMeta({ context: { role: "cnc-operator" } });
    expect(res).toEqual({ ok: true, medium: undefined, context: { role: "cnc-operator" } });
  });

  it("sends NOTHING when both are blank", () => {
    expect(parseInviteMeta({ context: { role: "  ", city: "" } })).toEqual({
      ok: true,
      medium: undefined,
      context: undefined,
    });
  });

  it("REFUSES an unknown key loudly instead of silently dropping it", () => {
    // The failure mode this guards: cherry-picking role/city would drop `{name, phone}`
    // silently, so an attempted misuse would leave no trace and the caller would believe
    // it had been stored.
    const res = parseInviteMeta({
      context: { name: "Ramesh Kumar", phone: "+919812345678" },
    } as unknown as { context: { role?: string } });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/only a role and a city/i);
  });

  it("REFUSES a known key whose value is a person, not a slug", () => {
    for (const bad of ["Ramesh Kumar", "+91 98123 45678", "ramesh@example.com"]) {
      const res = parseInviteMeta({ context: { role: bad } });
      expect(res.ok, `role=${JSON.stringify(bad)} should be refused`).toBe(false);
    }
  });

  it("REFUSES a slug that is not lowercase-hyphen shaped", () => {
    for (const bad of ["Welder", "pune west", "-pune", "welder!", "a".repeat(49)]) {
      expect(parseInviteMeta({ context: { role: bad } }).ok, `role=${bad}`).toBe(false);
    }
  });

  it("never echoes the offending content back in the message", () => {
    const res = parseInviteMeta({ context: { role: "Ramesh Kumar" } });
    expect(res.ok).toBe(false);
    // The reason a value is rejected is precisely that it might be someone's name, so
    // repeating it into an error string (which gets rendered, and may get logged) is the
    // one thing this must not do.
    if (!res.ok) expect(res.error).not.toContain("Ramesh");
  });

  it("REFUSES a non-string value rather than coercing it", () => {
    const res = parseInviteMeta({ context: { role: 42 } } as unknown as {
      context: { role?: string };
    });
    expect(res.ok).toBe(false);
  });
});

describe("inviteContextSlugError — the inline screen", () => {
  it("passes an empty field (optional)", () => {
    expect(inviteContextSlugError("role", "")).toBeNull();
    expect(inviteContextSlugError("role", "   ")).toBeNull();
  });

  it("passes a real slug", () => {
    expect(inviteContextSlugError("role", "welder")).toBeNull();
    expect(inviteContextSlugError("city", "pune-west")).toBeNull();
  });

  it("names the field it is complaining about", () => {
    expect(inviteContextSlugError("city", "Pune West")).toContain("city");
    expect(inviteContextSlugError("role", "Ramesh Kumar")).toContain("role");
  });

  it("rejects a name/phone/email without echoing it", () => {
    for (const bad of ["Ramesh Kumar", "+91 98123 45678", "ramesh@example.com"]) {
      const err = inviteContextSlugError("role", bad);
      expect(err, `should reject ${bad}`).not.toBeNull();
      expect(err!).not.toContain(bad);
    }
  });

  it("rejects an over-long value", () => {
    expect(inviteContextSlugError("role", "a".repeat(49))).toMatch(/too long/i);
  });

  it("agrees with parseInviteMeta — the inline screen never admits what the action refuses", () => {
    // Two screens that disagree are worse than one: the agent gets through the form and is
    // then rejected by a round-trip with a different message.
    for (const value of ["welder", "pune-west", "Ramesh Kumar", "Pune West", "a".repeat(49), "x"]) {
      const inlineOk = inviteContextSlugError("role", value) === null;
      const actionOk = parseInviteMeta({ context: { role: value } }).ok;
      expect(inlineOk, `disagreement on ${JSON.stringify(value)}`).toBe(actionOk);
    }
  });
});
