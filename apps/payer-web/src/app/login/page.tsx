import { redirect } from "next/navigation";
import { payerAuth } from "../../lib/auth";
import { LoginForm } from "./login-form";

export const dynamic = "force-dynamic";

/**
 * Payer login (ADR-0019 Phase 1 — MOCK seam, B-R1 OPEN).
 *
 * The mock provider is the ONLY authorized login in Phase 1; a real IdP is a
 * separate human gate. Demo credentials are shown only outside production so the
 * staging surface is exercisable without leaking anything sensitive.
 */
export default async function LoginPage() {
  const existing = await payerAuth().currentSession();
  if (existing) redirect("/dashboard");

  const showDemo = process.env.NODE_ENV !== "production";

  return (
    <div className="login-wrap">
      <div style={{ width: "100%", maxWidth: 480 }}>
        <div className="brand" style={{ marginBottom: 16 }}>
          BadaBhai for Employers
          <small style={{ color: "var(--muted)", fontWeight: 400 }}>
            Self-serve hiring · staging preview (mock)
          </small>
        </div>
        <LoginForm />
        {showDemo ? (
          <div className="note" style={{ marginTop: 16 }}>
            <strong>Staging demo logins (mock auth):</strong>
            <br />
            <span className="mono">demo@acme-tools.example / demo-payer-1</span>
            <br />
            <span className="mono">demo@hire-fast.example / demo-payer-2</span>
            <br />
            Real login (IdP, MFA) is a Phase-2 human gate (ADR-0019 B-R1).
          </div>
        ) : null}
      </div>
    </div>
  );
}
