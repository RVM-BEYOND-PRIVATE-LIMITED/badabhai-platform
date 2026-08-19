import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  eslint: {
    // The monorepo lints via the root flat ESLint config (`pnpm lint`), so we
    // don't run Next's own ESLint during `next build`.
    ignoreDuringBuilds: true,
  },
  // The box container (apps/admin-web/Dockerfile) needs a lean, self-contained runtime
  // image rather than shipping the whole builder tree — `standalone` traces only the
  // files this app actually needs (including the workspace `@badabhai/config`,
  // `@badabhai/pricing` and `@badabhai/validators` packages it imports) and emits a
  // minimal `server.js`.
  //
  // VERIFIED SAFE for what THIS app actually uses, not assumed by analogy with
  // payer-web — the three things standalone changes or does not support were each
  // checked against this app's own source before this line was added:
  //   * NO `middleware.ts` / `middleware.js` anywhere in this app. Worth stating
  //     explicitly because an admin portal doing auth is exactly where you would expect
  //     one: this portal's auth is instead per-route, in the `(portal)` layout and the
  //     server actions (`src/lib/auth/*` reading the httpOnly `bb_admin_token` cookie).
  //     Standalone DOES support middleware, but it lands in a different place in the
  //     traced output — so if middleware is ever added here, re-verify the Dockerfile's
  //     COPY set rather than assuming it still holds.
  //   * NO `next/image` usage anywhere in `src`, so the runtime image needs no `sharp`.
  //   * NO `next/font` usage. The four RobotoMono files under `public/fonts/` are plain
  //     static assets, and standalone does NOT copy `public/` — the Dockerfile copies it
  //     explicitly, which is what keeps them from 404ing.
  output: "standalone",
  // Monorepo root, explicit rather than inferred. Next infers the workspace root by
  // walking up for a lockfile, which is usually right but prints a warning (and, in a
  // Docker builder stage that COPYs the whole repo, is worth pinning rather than
  // trusting auto-detection silently picks the same root every time). This must match
  // the Dockerfile's build context (repo root).
  outputFileTracingRoot: path.join(__dirname, "../.."),
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
