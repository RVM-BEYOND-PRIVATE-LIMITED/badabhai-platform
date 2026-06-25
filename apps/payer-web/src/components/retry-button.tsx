"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";

/**
 * IN-PAGE RETRY for server-read failure fallbacks (B6).
 *
 * A read that fails on the server renders a NEUTRAL "Service unavailable" fallback; this
 * small client control lets the user re-run the server read in place via `router.refresh()`
 * (the page is `force-dynamic`, so the read re-executes) — no full navigation, no reload.
 *
 * NO-LEAK: it carries NO error detail and renders NO data — only a button. It never logs
 * anything. The fallback copy stays neutral; this only adds the retry affordance.
 */
export function RetryButton({ label = "Retry" }: { label?: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <button
      className="btn secondary"
      type="button"
      disabled={pending}
      onClick={() => startTransition(() => router.refresh())}
    >
      {pending ? "Retrying…" : label}
    </button>
  );
}
