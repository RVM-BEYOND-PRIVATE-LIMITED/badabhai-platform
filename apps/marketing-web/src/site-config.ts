/**
 * Single source of truth for Razorpay-compliance copy on the public
 * marketing site (badabhai.ai).
 *
 * Entity/address/email below were supplied by the owner (must match the
 * Certificate of Incorporation + Razorpay KYC 100%).
 *
 * TODO(razorpay): SUPPORT_PHONE is a placeholder. Replace with the real
 * active customer-support number before submitting the URL to Razorpay —
 * a contact form alone (or a dummy number) fails the audit.
 */
export const SITE = {
  legalName: "BADABHAI LABS PRIVATE LIMITED",
  brandName: "BadaBhai",
  domain: "badabhai.ai",
  registeredAddress: [
    "PLOT NO 4 PART 20, MATHURA Road,",
    "NEW INDUSTRIAL AREA, G.T. Road, Ballabgarh,",
    "Faridabad – 121006, Haryana, India",
  ],
  supportEmail: "support@badabhai.ai",
  /**
   * Real support number — set NEXT_PUBLIC_SUPPORT_PHONE (e.g. "+911294000000")
   * before deploying. The fallback is a visible placeholder so an unfilled
   * number can never ship silently; Razorpay rejects a dummy support line.
   */
  supportPhoneDisplay: process.env.NEXT_PUBLIC_SUPPORT_PHONE || "+91-XXXXXXXXXX",
  supportPhoneHref: `tel:${(process.env.NEXT_PUBLIC_SUPPORT_PHONE || "").replace(/[^\d+]/g, "") || "+91XXXXXXXXXX"}`,
  supportHours: "Mon–Sat, 10:00 AM – 6:00 PM IST",
  jurisdiction: "Faridabad, Haryana, India",
  governingLaw: "the laws of India, with exclusive jurisdiction of the courts at Faridabad, Haryana",
  lastUpdated: "19 November 2026",
  gstNote: "All prices in INR (₹), exclusive of 18% GST",
} as const;

export interface PriceTier {
  code: string;
  name: string;
  priceInr: number;
  blurb: string;
}

/** Mirrors packages/pricing DEFAULT_CATALOG (the live payer catalogue). */
export const PRICING: {
  contactPacks: PriceTier[];
  postings: PriceTier[];
  boosts: PriceTier[];
  capacity: PriceTier[];
  managedHiring: PriceTier[];
} = {
  contactPacks: [
    { code: "pack_50", name: "Starter — 50 credits", priceInr: 2000, blurb: "50 candidate contact unlocks · 14-day window · ≈₹40/unlock" },
    { code: "pack_200", name: "Standard — 200 credits", priceInr: 8000, blurb: "200 candidate contact unlocks · 14-day window · ≈₹40/unlock" },
    { code: "pack_1000", name: "Scale — 1,000 credits", priceInr: 32000, blurb: "1,000 candidate contact unlocks · 14-day window · ≈₹32/unlock (20% volume saving)" },
  ],
  postings: [
    { code: "standard", name: "Job posting — Standard", priceInr: 1000, blurb: "14 days live · 10 applicant views" },
    { code: "pro", name: "Job posting — Pro", priceInr: 2500, blurb: "30 days live · 30 applicant views" },
  ],
  boosts: [
    { code: "boost_7", name: "Boost — 7 days", priceInr: 499, blurb: "Priority rank in worker feed for 7 days" },
    { code: "boost_15", name: "Boost — 15 days", priceInr: 999, blurb: "Priority rank in worker feed for 15 days" },
    { code: "boost_30", name: "Boost — 30 days", priceInr: 1799, blurb: "Priority rank in worker feed for 30 days" },
  ],
  capacity: [
    { code: "cap_5", name: "Hiring capacity — 5 vacancies", priceInr: 5000, blurb: "5 concurrent active vacancies · 30 days" },
    { code: "cap_15", name: "Hiring capacity — 15 vacancies", priceInr: 12000, blurb: "15 concurrent active vacancies · 30 days" },
  ],
  managedHiring: [
    { code: "standard", name: "Managed hiring — Standard", priceInr: 4000, blurb: "Up to 5 vacancies · 5 phone-confirmed workers in 7 working days · free extension to day 30" },
    { code: "large", name: "Managed hiring — Large", priceInr: 8000, blurb: "6–10 vacancies or skilled roles · 5 phone-confirmed workers in 7 working days · free extension to day 30" },
  ],
};

export function inr(n: number): string {
  return `₹${n.toLocaleString("en-IN")}`;
}

export const COMPLIANCE_LINKS = [
  { href: "/pricing", label: "Pricing" },
  { href: "/contact", label: "Contact Us" },
  { href: "/terms", label: "Terms & Conditions" },
  { href: "/privacy", label: "Privacy Policy" },
  { href: "/refund-policy", label: "Refund & Cancellation" },
] as const;
