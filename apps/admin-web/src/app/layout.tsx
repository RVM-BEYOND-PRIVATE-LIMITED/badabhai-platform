import type { Metadata } from "next";
import {
  ADMIN_THEME_COOKIE_NAME,
  createThemeNoFoucScript,
  displayThemeToPreference,
} from "@badabhai/theme-web";
import { getDisplayPrefsCached } from "../lib/display-prefs";
import { adminRootTheme } from "../lib/theme";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "BadaBhai Admin", template: "%s · BadaBhai Admin" },
  description: "Internal operations console for the BadaBhai platform.",
  robots: { index: false, follow: false },
};

/**
 * Root layout for the INTERNAL admin portal.
 *
 * THEME (#2821): admin-web stays Light while `THEME_ROLLOUT` is closed for the admin — the root
 * `data-theme` is only ever set when `/admin/me/display-prefs` says `theme_open`, and the cookie
 * (`bb_admin_theme`, NEVER `bb_theme`) is ignored in that closed state. When open, the server
 * value drives the first paint and the no-FOUC script resolves `system` from the OS before paint.
 */
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const displayPrefs = await getDisplayPrefsCached();
  const themeOpen = displayPrefs?.theme_open === true;
  const theme = adminRootTheme(displayPrefs);
  const serverPreference = themeOpen
    ? displayThemeToPreference(displayPrefs?.theme)
    : undefined;
  const noFouc = themeOpen
    ? createThemeNoFoucScript(ADMIN_THEME_COOKIE_NAME, serverPreference)
    : undefined;

  return (
    <html lang="en" data-theme={theme === "ink" ? "ink" : undefined}>
      <head>
        {/* Display + body faces. Roboto Mono is self-hosted (tokens.css) so IDs, ₹ amounts
            and timestamps render identically even with no network. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        {/* UI-1 — Inter is the Latin UI face (--font-sans); Roboto stays as the Devanagari
            half of that chain, and Anek carries the brand voice on headings and buttons. */}
        <link
          href="https://fonts.googleapis.com/css2?family=Anek+Latin:wght@500;600;700;800&family=Inter:wght@400;500;600;700&family=Roboto:wght@400;500;700&display=swap"
          rel="stylesheet"
        />
        {noFouc ? (
          <>
            <meta name="theme-color" />
            <script dangerouslySetInnerHTML={{ __html: noFouc }} />
          </>
        ) : null}
      </head>
      <body>
        {/* First tab stop on every page. The portal is keyboard-heavy by design — an
            operator scanning a 200-row table should never have to tab the whole sidebar. */}
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
