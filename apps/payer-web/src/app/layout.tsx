import type { Metadata } from "next";
import type { ReactNode } from "react";
import { cookies } from "next/headers";
import "./globals.css";
import { publicConfig, resolvePayerTheme, THEME_COOKIE_NAME } from "../lib/config";
import { ASYNC_CSS_SCRIPT, ASYNC_STYLESHEETS, THEME_NO_FOUC_SCRIPT } from "../lib/theme";

export const metadata: Metadata = {
  title: "BadaBhai for Employers",
  description: "Self-serve hiring portal — post jobs, view faceless applicants, unlock contacts.",
};

/**
 * Root layout for the EXTERNAL payer portal (ADR-0019 Decision A — a distinct
 * public-origin app, NOT the internal ops console). The session chrome
 * (top-nav + logout) lives in the authenticated route group so the /login page
 * renders clean. Only `NEXT_PUBLIC_*` config is read here (no server secret).
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  // THEME-1 — resolve the light/dark (paper/ink) theme for the FIRST paint:
  //   explicit `bb_theme` cookie (paper/ink) → env PAYER_THEME (back-compat) → system/paper.
  // `data-theme="ink"` flips the whole token-driven portal. On the `system`/no-cookie path the
  // server renders the stable paper baseline and the inline no-FOUC script (below) corrects it
  // from `prefers-color-scheme` BEFORE first paint — so the cookie path never mismatches on
  // hydration, and the system path is fixed before React mounts.
  const themeCookie = (await cookies()).get(THEME_COOKIE_NAME)?.value;
  const theme = resolvePayerTheme(themeCookie);
  return (
    <html lang="en" data-theme={theme === "ink" ? "ink" : undefined}>
      <head>
        {/* Mobile browser chrome matches the theme. The inline no-FOUC script (next) sets the
            content from the COMPUTED --surface-page token before paint, and the toggle keeps it
            in sync — so no raw color literal lives in this source (adherence stays green). */}
        <meta name="theme-color" />
        {/* No-FOUC: correct data-theme from the OS preference on the system/first-visit path
            and sync the theme-color meta, before paint + before hydration. No-op when an
            explicit paper/ink cookie already drove the SSR data-theme. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_NO_FOUC_SCRIPT }} />
        {/* Baloo 2 (display) + Mukta (body/multilingual) — the BadaBhai type tokens
            (--font-display / --font-sans). Roboto Mono (--font-mono) is self-hosted via
            @font-face in src/styles/tokens.css. Devanagari+Latin for Hinglish/regional copy.
            Phosphor (`ph ph-*`) supplies the DS glyphs, always beside a text label.

            NON-RENDER-BLOCKING (B4): these four CROSS-ORIGIN sheets used to be `<link
            rel=stylesheet>` in this head, which made them 4 of 6 render-blocking stylesheets
            and 250,748 B from two extra origins — measured on the PUBLIC `/i/<code>` install
            page, which uses no icons at all and exists to convert a worker on a congested 3G
            tower. They are now appended at runtime by ASYNC_CSS_SCRIPT (an inline head
            script, the same pattern the no-FOUC script above already uses), so nothing
            third-party blocks first paint. The preconnects stay: they warm the DNS/TLS
            handshake for exactly those origins, which is now pure upside.
            The <noscript> twins below keep both working with JavaScript disabled. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <script dangerouslySetInnerHTML={{ __html: ASYNC_CSS_SCRIPT }} />
        <noscript>
          {ASYNC_STYLESHEETS.map((href) => (
            <link key={href} rel="stylesheet" href={href} />
          ))}
        </noscript>
      </head>
      <body>
        {children}
        <div className="chrome-footer">
          BadaBhai for Employers · {publicConfig.NEXT_PUBLIC_ENVIRONMENT} · Worker identities
          are masked and consent-gated.
        </div>
      </body>
    </html>
  );
}
