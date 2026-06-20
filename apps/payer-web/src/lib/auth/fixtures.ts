import type { PayerSession } from "./types";

/**
 * MOCK payer accounts (ADR-0019 Phase 1 — staging-only, no real IdP / B-R1 OPEN).
 *
 * These are demo logins for the mock seam ONLY. The `payerId`s are fixed opaque
 * UUIDs — the SAME ids the mock data store (`mock-store.ts`) is keyed by, so a
 * logged-in demo payer sees a self-consistent, payer-SCOPED dataset. There is NO
 * real password hashing here on purpose: this is a throwaway staging credential,
 * never a production identity. Real auth (hashing, MFA, lockout) lands with B-R1.
 *
 * The email/password are dev credentials, NOT payer PII of a real business — they
 * never leave the server and never enter an event/log (invariant #2 / B-R2).
 */

export interface MockAccount {
  readonly email: string;
  readonly session: PayerSession;
}

export const MOCK_ACCOUNTS: readonly MockAccount[] = [
  {
    email: "demo@acme-tools.example",
    session: {
      payerId: "11111111-1111-4111-8111-111111111111",
      displayLabel: "Acme Tools (mock)",
      role: "employer",
    },
  },
  {
    email: "demo@hire-fast.example",
    session: {
      payerId: "22222222-2222-4222-8222-222222222222",
      displayLabel: "HireFast Agency (mock)",
      role: "agent",
    },
  },
];

/** Find a mock account by a case-insensitive email (the OTP-flow lookup key). */
export function matchMockAccountByEmail(email: string): MockAccount | null {
  const norm = email.trim().toLowerCase();
  return MOCK_ACCOUNTS.find((a) => a.email === norm) ?? null;
}
