import { describe, expect, it } from "vitest";
import { shouldUseSecureCookie } from "./shared";

describe("shouldUseSecureCookie", () => {
  it("is insecure with no signals (local http dev)", () => {
    expect(shouldUseSecureCookie({})).toBe(false);
  });

  it("is secure when NODE_ENV=production", () => {
    expect(shouldUseSecureCookie({ NODE_ENV: "production" })).toBe(true);
  });

  it.each(["staging", "production", "Staging", " PRODUCTION "])(
    "is secure when NEXT_PUBLIC_ENVIRONMENT=%s",
    (env) => {
      expect(shouldUseSecureCookie({ NEXT_PUBLIC_ENVIRONMENT: env })).toBe(true);
    },
  );

  it("is insecure for NEXT_PUBLIC_ENVIRONMENT=development", () => {
    expect(shouldUseSecureCookie({ NEXT_PUBLIC_ENVIRONMENT: "development" })).toBe(false);
  });

  it("is secure when NEXT_PUBLIC_SITE_URL is https", () => {
    expect(shouldUseSecureCookie({ NEXT_PUBLIC_SITE_URL: "https://payer.badabhai.in" })).toBe(
      true,
    );
  });

  it("is insecure when NEXT_PUBLIC_SITE_URL is http", () => {
    expect(shouldUseSecureCookie({ NEXT_PUBLIC_SITE_URL: "http://localhost:3002" })).toBe(false);
  });

  it("is secure when VERCEL_URL is set (always https by Vercel convention)", () => {
    expect(shouldUseSecureCookie({ VERCEL_URL: "payer-web.vercel.app" })).toBe(true);
  });

  it("ignores the API URL -- a different host that could be https in local dev", () => {
    expect(
      shouldUseSecureCookie({ NEXT_PUBLIC_API_URL: "https://api.badabhai.in" }),
    ).toBe(false);
  });

  it("defaults to reading process.env when no env is passed", () => {
    expect(typeof shouldUseSecureCookie()).toBe("boolean");
  });
});
