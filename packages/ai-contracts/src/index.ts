/**
 * @badabhai/ai-contracts — the request/response contracts between the NestJS API
 * and the FastAPI AI service.
 *
 * IMPORTANT: these contracts are mirrored as Pydantic models in
 * `apps/ai-service/app/contracts.py`. Keep the two in sync.
 *
 * PRIVACY: by design these contracts never carry raw worker identity (no phone,
 * full name, address, or employer name). Profiling/extraction inputs are passed
 * through the pseudonymization gateway before any LLM call. Resume generation
 * receives only the structured profile — the backend re-attaches the worker's
 * real name when assembling the final artifact, so the name never reaches the
 * AI service.
 */

export * from "./common";
export * from "./conversation";
export * from "./occupation";
export * from "./profile";
export * from "./job-posting";
export * from "./skills";
export * from "./voice";
