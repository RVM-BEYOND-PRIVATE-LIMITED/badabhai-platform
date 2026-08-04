/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  eslint: {
    // The monorepo lints via the root flat ESLint config (`pnpm lint`), so we
    // don't run Next's own ESLint during `next build`.
    ignoreDuringBuilds: true,
  },
  // The admin portal is INTERNAL and highly privileged. It must never be framed,
  // sniffed into a different content type, or leak a referrer to another origin.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          // The portal renders operator data; nothing here should ever be indexed.
          { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
        ],
      },
    ];
  },
};

export default nextConfig;
