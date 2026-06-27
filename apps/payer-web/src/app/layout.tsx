import type { Metadata } from "next";
import type { ReactNode } from "react";
import { cookies } from "next/headers";
import "./globals.css";
import { publicConfig, resolvePayerTheme, THEME_COOKIE_NAME } from "../lib/config";
import { THEME_NO_FOUC_SCRIPT } from "../lib/theme";

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
            @font-face in src/styles/tokens.css. Devanagari+Latin for Hinglish/regional copy. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Baloo+2:wght@400;500;600;700;800&family=Mukta:wght@300;400;500;600;700;800&display=swap"
        />
        {/* Phosphor icon font (the DS pairs `ph ph-*` glyphs with text labels — StatTile,
            Button, Select chevron, Input icons). Regular + bold + fill weights. Icons degrade
            to empty marks if this fails to load, so text always carries the meaning. */}
        <link rel="stylesheet" href="https://unpkg.com/@phosphor-icons/web@2.1.1/src/regular/style.css" />
        <link rel="stylesheet" href="https://unpkg.com/@phosphor-icons/web@2.1.1/src/bold/style.css" />
        <link rel="stylesheet" href="https://unpkg.com/@phosphor-icons/web@2.1.1/src/fill/style.css" />
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
