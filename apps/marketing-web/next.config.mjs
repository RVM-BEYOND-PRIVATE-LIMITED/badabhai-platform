/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  /**
   * `next dev` and `next build` must never share a dist directory. Running a
   * production build while the dev server is up overwrites `.next/server/*`
   * and the live server then dies with "Cannot find module './<chunk>.js'".
   * Dev keeps `.next`; build/start use `.next-build`, so both can coexist.
   */
  distDir: process.env.NODE_ENV === "production" ? ".next-build" : ".next",
  eslint: {
    // The monorepo lints via the root flat ESLint config (`pnpm lint`), so we
    // don't run Next's own ESLint during `next build`.
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
