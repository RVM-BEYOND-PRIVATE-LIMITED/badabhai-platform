import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "BadaBhai Admin", template: "%s · BadaBhai Admin" },
  description: "Internal operations console for the BadaBhai platform.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* Display + body faces. Roboto Mono is self-hosted (tokens.css) so IDs, ₹ amounts
            and timestamps render identically even with no network. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        {/* UI-1 — Inter is the Latin UI face (--font-sans); Roboto stays as the Devanagari
            half of that chain, and Anek carries the brand voice on headings and buttons. */}
        <link
          href="https://fonts.googleapis.com/css2?family=Anek+Latin:wght@500;600;700&family=Inter:wght@400;500;600;700&family=Roboto:wght@400;500;700&display=swap"
          rel="stylesheet"
        />
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
