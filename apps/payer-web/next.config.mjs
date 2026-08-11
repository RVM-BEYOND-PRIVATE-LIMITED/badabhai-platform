/**
 * PAY-SEC-08 — baseline security headers for the portal.
 *
 * SCOPE NOTE, deliberately: there is NO `Content-Security-Policy` here yet. The root layout
 * injects an inline no-FOUC theme script (`src/lib/theme.ts` → `<head>`), so a strict CSP needs
 * a nonce or hash threaded through that script or the portal renders unstyled on first paint.
 * That change has to be verified against a running app, and this repo has no browser test of any
 * kind (GAP-XC-07) — so shipping a CSP blind would risk breaking every page to satisfy a header.
 * The headers below are the ones that are safe without runtime verification. CSP stays open as
 * follow-up work, tracked in GAP_REGISTER.md.
 *
 * `Strict-Transport-Security` is likewise omitted: TLS terminates at the host/edge (the portal is
 * not deployed by any workflow today — GAP-XC-06), and emitting HSTS from a local dev server
 * would pin the developer's browser to https for the whole domain.
 */

const securityHeaders = [
  // Stop the browser second-guessing a declared Content-Type.
  { key: "X-Content-Type-Options", value: "nosniff" },
  // The portal is never legitimately framed; clickjacking has no use case here.
  { key: "X-Frame-Options", value: "DENY" },
  // Portal URLs carry posting/worker ids in the path — never leak them to a third party.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // No feature of the portal needs these; deny by default rather than on request.
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  },
  { key: "X-DNS-Prefetch-Control", value: "off" },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Absent is better than decorative — do not advertise the framework.
  poweredByHeader: false,
  eslint: {
    // The monorepo lints via the root flat ESLint config (`pnpm lint`), so we
    // don't run Next's own ESLint during `next build`.
    ignoreDuringBuilds: true,
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
