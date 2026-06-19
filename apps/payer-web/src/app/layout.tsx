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
