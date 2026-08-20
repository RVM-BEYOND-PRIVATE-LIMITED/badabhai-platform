"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { AI_TRACE_TASK_TYPES } from "../../../lib/ai-trace-view";
import { taskTypeLabel } from "../../../lib/ai-cost";

/**
 * AI-call filters — three narrowings, and one that is deliberately absent.
 *
 * ── THERE IS NO TEXT SEARCH HERE, AND THERE MUST NEVER BE ───────────────────────────────
 * Not over the prompt, not over the reply, not over a hash of either. The server offers no
 * such parameter and this form must not grow a client-side equivalent: a substring search
 * across this table is a search across everything every worker has ever said to the platform
 * — "find every worker who mentioned a salary" wearing a convenience feature's costume. The
 * feedback list refuses exactly this over one screen's worth of complaints; the corpus here is
 * larger by orders of magnitude.
 *
 * The worker field below is NOT that. It takes an id the operator already holds, from a roster
 * they were already entitled to read, and narrows a page they could reach by scrolling. It
 * selects rows and discovers nobody.
 *
 * ── EVERY VALUE TRAVELS RAW ─────────────────────────────────────────────────────────────
 * A hand-edited task type or a malformed uuid is forwarded and earns an honest 400, which the
 * page renders as a refusal. Dropping it here would show the unfiltered list under a URL
 * claiming a filter — and an operator reading every worker's calls under a heading that says
 * one worker's would have no way to know.
 */
export function AiCallFilterBar({
  taskType,
  success,
  workerId,
}: {
  taskType: string;
  success: string;
  workerId: string;
}) {
  const router = useRouter();
  const [values, setValues] = useState({ taskType, success, workerId });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(values)) {
      const t = v.trim();
      if (t) q.set(k, t);
    }
    const qs = q.toString();
    // The cursor is NOT carried. Page three's cursor applied to a different query returns an
    // arbitrary slice of it, which looks like data rather than like an error.
    router.push(qs ? `/ai-calls?${qs}` : "/ai-calls");
  }

  return (
    <form className="filters" onSubmit={submit} role="search">
      <label className="field">
        <span className="field__label">Task</span>
        <select
          className="field__input"
          value={values.taskType}
          onChange={(e) => setValues((v) => ({ ...v, taskType: e.target.value }))}
        >
          <option value="">Any</option>
          {AI_TRACE_TASK_TYPES.map((t) => (
            <option key={t} value={t}>
              {taskTypeLabel(t)}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span className="field__label">Outcome</span>
        <select
          className="field__input"
          value={values.success}
          onChange={(e) => setValues((v) => ({ ...v, success: e.target.value }))}
        >
          <option value="">Any</option>
          {/* "false" first: the triage question this whole surface exists to make cheap is
              "what is failing", and it is the option an operator reaches for under pressure. */}
          <option value="false">Failed</option>
          <option value="true">Succeeded</option>
        </select>
      </label>

      <label className="field">
        <span className="field__label">Worker id</span>
        <input
          className="field__input mono"
          value={values.workerId}
          onChange={(e) => setValues((v) => ({ ...v, workerId: e.target.value }))}
          placeholder="full UUID"
          spellCheck={false}
          autoComplete="off"
        />
      </label>

      <div className="filters__actions">
        <button className="btn btn--primary" type="submit">
          Apply
        </button>
      </div>
    </form>
  );
}
