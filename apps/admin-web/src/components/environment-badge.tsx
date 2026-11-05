/**
 * The environment names the API reports (`NODE_ENV`), as the badge says them. A name this build
 * does not know is shown as the API wrote it — never guessed into one of these.
 */
const ENVIRONMENT_LABELS: Readonly<Record<string, string>> = {
  production: "Production",
  staging: "Staging",
  development: "Development",
  test: "Test",
};

/** The badge's words for an environment, or for none (the probe could not say). */
export function environmentLabel(environment: string | null): string {
  if (environment === null) return "Environment unknown";
  return Object.hasOwn(ENVIRONMENT_LABELS, environment)
    ? ENVIRONMENT_LABELS[environment]!
    : environment;
}

/**
 * THE ENVIRONMENT BADGE (A6, #2576), in the topbar beside the avatar menu: which environment the
 * console's API is running in, read from the API's health probe (`lib/environment.ts`), never a
 * label baked into this app. Production wears the brand's structural navy so it is the one an
 * operator cannot mistake; every other environment, and "unknown", the quiet sunken pill.
 *
 * Server-safe: no hooks — the shell renders it from the value the layout read.
 */
export function EnvironmentBadge({ environment }: { environment: string | null }) {
  const production = environment === "production";
  return (
    <span
      className={production ? "topbar__env topbar__env--production" : "topbar__env"}
      title={
        environment === null
          ? "The API's health probe did not answer, so its environment is unknown."
          : "The environment the API behind this console reports."
      }
    >
      {environment === null ? null : <span className="sr-only">Environment: </span>}
      {environmentLabel(environment)}
    </span>
  );
}
