// Test-only no-op stub for the `server-only` package. Aliased in vitest.config.ts
// so server-only seam modules can be imported in the node test env. This does NOT
// weaken the production guarantee: Next still resolves the real `server-only`
// package at build time, which errors if a Client Component imports a server module.
export {};
