import { describe, expect, it } from "vitest";
import {
  AdminChangePasswordSchema,
  AdminLoginVerifySchema,
  AdminMfaCodeSchema,
  AdminMfaVerifySchema,
  AdminPasswordForgotSchema,
  AdminPasswordLoginSchema,
  AdminPasswordResetSchema,
} from "./admin-auth.dto";
import { AdminCreateDirectSchema } from "./admin-actions.dto";

const EMAIL = "Ops.Admin@BadaBhai.in ";
const DEVICE = "a".repeat(43);

describe("0144 admin auth DTOs", () => {
  it("login/password: normalizes the email; password bounded but NOT policy-checked", () => {
    const ok = AdminPasswordLoginSchema.parse({ email: EMAIL, password: "x" });
    expect(ok.email).toBe("ops.admin@badabhai.in");
    expect(AdminPasswordLoginSchema.safeParse({ email: EMAIL, password: "" }).success).toBe(false);
    expect(
      AdminPasswordLoginSchema.safeParse({ email: EMAIL, password: "x".repeat(129) }).success,
    ).toBe(false);
  });

  it("login/password: new_password IS policy-checked; device_token bounded 20..128", () => {
    const base = { email: EMAIL, password: "Temp-pass-1234" };
    expect(AdminPasswordLoginSchema.safeParse({ ...base, new_password: "short1" }).success).toBe(
      false,
    );
    expect(
      AdminPasswordLoginSchema.safeParse({ ...base, new_password: "lettersonly" }).success,
    ).toBe(false);
    expect(
      AdminPasswordLoginSchema.safeParse({ ...base, new_password: "Good-pass-1" }).success,
    ).toBe(true);
    expect(AdminPasswordLoginSchema.safeParse({ ...base, device_token: DEVICE }).success).toBe(
      true,
    );
    expect(AdminPasswordLoginSchema.safeParse({ ...base, device_token: "short" }).success).toBe(
      false,
    );
    expect(
      AdminPasswordLoginSchema.safeParse({ ...base, device_token: "a".repeat(129) }).success,
    ).toBe(false);
  });

  it("every 0144 body is .strict() — an unexpected key (an id, a role) is a 400", () => {
    expect(
      AdminPasswordLoginSchema.safeParse({ email: EMAIL, password: "x", admin_id: "y" }).success,
    ).toBe(false);
    expect(AdminPasswordForgotSchema.safeParse({ email: EMAIL, role: "super_admin" }).success).toBe(
      false,
    );
    expect(
      AdminChangePasswordSchema.safeParse({ new_password: "Good-pass-1", admin_id: "y" }).success,
    ).toBe(false);
    expect(AdminMfaCodeSchema.safeParse({ code: "123456", admin_id: "y" }).success).toBe(false);
  });

  it("login/verify gains an OPTIONAL device_token; old bodies still parse unchanged", () => {
    expect(AdminLoginVerifySchema.safeParse({ email: EMAIL, code: "123456" }).success).toBe(true);
    expect(
      AdminLoginVerifySchema.safeParse({ email: EMAIL, code: "123456", device_token: DEVICE })
        .success,
    ).toBe(true);
  });

  it("mfa/verify gains an OPTIONAL boolean trust_device; old bodies still parse unchanged", () => {
    expect(AdminMfaVerifySchema.safeParse({ email: EMAIL, code: "123456" }).success).toBe(true);
    expect(
      AdminMfaVerifySchema.safeParse({ email: EMAIL, code: "123456", trust_device: true }).success,
    ).toBe(true);
    expect(
      AdminMfaVerifySchema.safeParse({ email: EMAIL, code: "123456", trust_device: "yes" }).success,
    ).toBe(false);
  });

  it("password/reset: 4-8 digit code + a policy-checked new password", () => {
    expect(
      AdminPasswordResetSchema.safeParse({
        email: EMAIL,
        code: "123456",
        new_password: "Good-pass-1",
      }).success,
    ).toBe(true);
    expect(
      AdminPasswordResetSchema.safeParse({
        email: EMAIL,
        code: "12ab56",
        new_password: "Good-pass-1",
      }).success,
    ).toBe(false);
    expect(
      AdminPasswordResetSchema.safeParse({ email: EMAIL, code: "123456", new_password: "weak" })
        .success,
    ).toBe(false);
  });

  it("me/password: current_password optional (the SERVICE requires it when one exists)", () => {
    expect(AdminChangePasswordSchema.safeParse({ new_password: "Good-pass-1" }).success).toBe(true);
    expect(
      AdminChangePasswordSchema.safeParse({ current_password: "x", new_password: "Good-pass-1" })
        .success,
    ).toBe(true);
    expect(AdminChangePasswordSchema.safeParse({ new_password: "nodigits" }).success).toBe(false);
  });

  it("me/mfa/confirm|disable: exactly six digits", () => {
    expect(AdminMfaCodeSchema.safeParse({ code: "123456" }).success).toBe(true);
    expect(AdminMfaCodeSchema.safeParse({ code: "12345" }).success).toBe(false);
    expect(AdminMfaCodeSchema.safeParse({ code: "1234567" }).success).toBe(false);
  });

  it("admins/direct: trimmed name 1..100, closed role, policy-checked temporary password, strict", () => {
    const base = {
      email: EMAIL,
      name: "  Asha R ",
      role: "ops_admin",
      temporary_password: "Temp-pass-1234",
    };
    const ok = AdminCreateDirectSchema.parse(base);
    expect(ok.name).toBe("Asha R");
    expect(ok.email).toBe("ops.admin@badabhai.in");
    expect(AdminCreateDirectSchema.safeParse({ ...base, name: "   " }).success).toBe(false);
    expect(AdminCreateDirectSchema.safeParse({ ...base, name: "x".repeat(101) }).success).toBe(
      false,
    );
    expect(AdminCreateDirectSchema.safeParse({ ...base, role: "root" }).success).toBe(false);
    expect(
      AdminCreateDirectSchema.safeParse({ ...base, temporary_password: "weakpass" }).success,
    ).toBe(false);
    expect(AdminCreateDirectSchema.safeParse({ ...base, status: "active" }).success).toBe(false);
  });
});
