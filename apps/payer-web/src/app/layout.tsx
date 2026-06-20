import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import "./globals.css";
import { API_BASE_URL, ENVIRONMENT } from "../lib/config";

export const metadata: Metadata = {
  title: "BadaBhai for Business",
  description: "Self-serve portal for Companies and Agencies (ADR-0019 Phase 1 — mock + staging).",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <Link href="/" className="brand" style={{ display: "block" }}>
            BadaBhai
            <small>for Business · Companies &amp; Agencies</small>
          </Link>
          {children}
          <div className="footer">
            Environment: {ENVIRONMENT} · API: {API_BASE_URL}
            <br />
            Self-serve payer portal. Mock + staging only — no real payments. You only ever see
            your own account&apos;s data.
          </div>
        </div>
      </body>
    </html>
  );
}
