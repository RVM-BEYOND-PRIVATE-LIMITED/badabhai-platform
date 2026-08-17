import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Anek_Latin, Inter } from "next/font/google";
import "./globals.css";

/**
 * Both fonts are SELF-HOSTED by Next at build time (next/font/google downloads and
 * serves them from this app's own origin) — zero third-party request, zero
 * render-blocking `<link>`, and no layout shift. `variable` publishes each family as a
 * CSS custom property on <html>, which tokens.css's `--font-display` / `--font-sans`
 * chains reference — so the token layer stays the single place a component looks up a
 * font, exactly like the payer-web port.
 */
const anekLatin = Anek_Latin({
  subsets: ["latin"],
  weight: ["600", "700", "800"],
  variable: "--font-anek",
  display: "swap",
});
const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "600", "700"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  title: "BadaBhai — AI-first hiring for India's workforce",
  description:
    "BadaBhai digitizes blue-collar, grey-collar, industrial, construction, and skilled-trade workers through AI-guided profiling and connects them with the employers who need exactly their skills.",
  openGraph: {
    type: "website",
    siteName: "BadaBhai",
    title: "BadaBhai — AI-first hiring for India's workforce",
    description:
      "Skilled workers, verified employers, matched by AI. No resume required to get found; no keyword guesswork to hire.",
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${anekLatin.variable} ${inter.variable}`}>
      <body>{children}</body>
    </html>
  );
}
