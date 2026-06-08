/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  eslint: {
    // The monorepo lints via the root flat ESLint config (`pnpm lint`), so we
    // don't run Next's own ESLint during `next build`.
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
