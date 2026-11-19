import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Anek_Latin, Inter } from "next/font/google";
import "./globals.css";

/**
 * Brand fonts: Inter is self-hosted by Next at build time (next/font/google).
 * Headings render Kilimanjaro Sans via the shared @badabhai/design-tokens
 * @font-face (Sept 2026 brand kit, bundled woff); Anek Latin stays behind it
 * for glyphs the display face lacks (₹, Devanagari). `variable` publishes
 * each family as a CSS custom property on <html>.
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
