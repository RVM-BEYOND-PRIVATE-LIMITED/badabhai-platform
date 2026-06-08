import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { Nav } from "../components/nav";
import { publicConfig } from "../lib/config";

export const metadata: Metadata = {
  title: "BadaBhai Ops Console",
  description: "Internal operations console for the BadaBhai platform (Phase 1).",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="layout">
          <aside className="sidebar">
            <div className="brand">
              BadaBhai
              <small>Ops Console · Phase 1</small>
            </div>
            <Nav />
          </aside>
          <main className="main">
            {children}
            <div className="footer">
              Environment: {publicConfig.NEXT_PUBLIC_ENVIRONMENT} · API:{" "}
              {publicConfig.NEXT_PUBLIC_API_URL}
              <br />
              Internal tool · Worker Profiling. Employer/unlock/payments are not in Phase 1.
            </div>
          </main>
        </div>
      </body>
    </html>
  );
}
