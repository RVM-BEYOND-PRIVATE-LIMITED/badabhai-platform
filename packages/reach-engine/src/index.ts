/**
 * @badabhai/reach-engine — the deterministic day-one RANK core of the Reach Engine
 * (TD8, ADR-0005). Given a job and a set of workers, it scores each worker's
 * relevance (§3 checklist) and orders them best-first, flagging the "hot" top
 * ~10–15% — and it NEVER drops anyone (sort, never block).
 *
 * SCOPE: pure, dependency-free scoring + ranking. The Phase-2 surfaces that
 * consume it — the employer/job entity, the worker feed, unlock/contact/payments,
 * PACE (waves) and PROTECT (contact caps) and LEARN (behavioural re-ranking) — are
 * intentionally NOT here. LLMs must never rank/decide matches; this engine does.
 */
export * from "./types";
export { scoreWorkerForJob, haversineKm, WEIGHTS } from "./scoring";
export { rankWorkersForJob } from "./ranking";
