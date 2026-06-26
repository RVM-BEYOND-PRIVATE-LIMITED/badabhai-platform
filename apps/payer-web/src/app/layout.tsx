import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { publicConfig } from "../lib/config";

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
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* Baloo 2 (display) + Mukta (body/multilingual) — the BadaBhai type tokens
            (--font-display / --font-sans). Roboto Mono (--font-mono) is self-hosted via
            @font-face in src/styles/tokens.css. Devanagari+Latin for Hinglish/regional copy. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Baloo+2:wght@400;500;600;700;800&family=Mukta:wght@300;400;500;600;700;800&display=swap"
        />
      </head>
      <body>
        {children}
        <div className="footer">
          BadaBhai for Employers · {publicConfig.NEXT_PUBLIC_ENVIRONMENT} · Staging preview —
          mock payments, no real money. Worker identities are masked and consent-gated.
        </div>
      </body>
    </html>
  );
}
