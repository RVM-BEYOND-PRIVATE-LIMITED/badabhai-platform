/**
 * The guard that decides whether an ops runner may touch the database in front of it.
 *
 * ===========================================================================
 * WHY THE EXISTING GUARD IS BACKWARDS
 * ===========================================================================
 * Ten runners in this package guard with the same line:
 *
 *     if (process.env.NODE_ENV === "production") throw ...
 *
 * That protects the wrong thing. `NODE_ENV` is a label on the PROCESS; the blast radius is
 * decided by `DATABASE_URL`, which is a label on the TARGET. The two are set independently and
 * routinely disagree, so the guard produces both failures at once:
 *
 *   FALSE REFUSAL   a READ-ONLY dry run is blocked because a shell happens to export
 *                   NODE_ENV=production. This is not merely annoying: the obvious workaround is
 *                   to unset NODE_ENV, and that unblocks `--apply` at the same time. A guard
 *                   people routinely disable is worse than no guard, because it also carries
 *                   authority.
 *
 *   FALSE PERMIT    a MUTATING run against the production database proceeds because NODE_ENV
 *                   happens to be unset. This is the one that costs something, and it is the
 *                   default state of a developer laptop whose `.env` points at production —
 *                   which is exactly the configuration this repository ships to work in.
 *
 * ===========================================================================
 * WHAT THIS DOES INSTEAD
 * ===========================================================================
 * The target is classified from the connection string, and the two questions are separated:
 *
 *   READING a production database    allowed, announced loudly. Dry runs are how an operator
 *                                    finds out what a run would do; blocking them is what
 *                                    taught everyone to unset the variable.
 *   WRITING to a production database  refused, unless authorised by TWO independent signals.
 *
 * Two signals, not one, and neither is a bare boolean:
 *
 *   1. `--i-am-authorised-to-write-to-production` on the command line — deliberate, visible in
 *      shell history, impossible to inherit from an environment.
 *   2. `OPS_ALLOW_PRODUCTION=<script-name>` naming THIS runner — so a stale export left over
 *      from authorising a different script does not silently authorise this one.
 *
 * `NODE_ENV=production` still refuses a write on its own. It is kept as a second, independent
 * tripwire rather than replaced: an operator who has correctly labelled their process should
 * not be rescued by a connection string this function failed to classify.
 */

/**
 * Coarse classification of the target, derived from the connection string alone.
 *
 * Deliberately coarse: it must never print or leak the credential, and an operator needs to
 * know which KIND of database they are pointed at, not its address.
 */
export type TargetClass = "LOCAL DOCKER" | "SUPABASE (remote)" | "OTHER-REMOTE" | "UNPARSEABLE";

export function hostClass(connectionString: string): TargetClass {
  let host: string;
  try {
    host = new URL(connectionString).hostname;
  } catch {
    return "UNPARSEABLE";
  }
  if (/^(localhost|127\.0\.0\.1|::1|\[::1\])$/i.test(host)) return "LOCAL DOCKER";
  if (/supabase/i.test(host)) return "SUPABASE (remote)";
  return "OTHER-REMOTE";
}

/**
 * Is this target one where an accidental write would be a real incident?
 *
 * Fails CLOSED: anything that is not provably local counts as production-like, including an
 * unparseable string. A guard that has to understand a URL before it protects you is a guard
 * that stops protecting you the first time someone uses a connection format it has not seen.
 */
export function isProductionLike(connectionString: string): boolean {
  return hostClass(connectionString) !== "LOCAL DOCKER";
}

export const PRODUCTION_WRITE_FLAG = "--i-am-authorised-to-write-to-production";
export const PRODUCTION_WRITE_ENV = "OPS_ALLOW_PRODUCTION";

export interface OpsGuardInput {
  /** The runner's short name, e.g. "retag". Must match `OPS_ALLOW_PRODUCTION` to authorise. */
  readonly script: string;
  readonly connectionString: string;
  /** `process.env.NODE_ENV`. */
  readonly nodeEnv: string | undefined;
  /** `process.env.OPS_ALLOW_PRODUCTION`. */
  readonly allowEnv: string | undefined;
  readonly argv: readonly string[];
  /** Does this invocation WRITE? A dry run passes false. */
  readonly mutating: boolean;
}

export interface OpsGuardVerdict {
  readonly allowed: boolean;
  /** Why it was refused. `null` when allowed. */
  readonly refusal: string | null;
  /** Printed whenever the target is production-like, allowed or not. */
  readonly warning: string | null;
  readonly target: TargetClass;
}

/**
 * The whole decision. Pure — no env reads, no IO — so every branch is testable, which matters
 * more here than usual: the branch that must never be wrong is the one that does nothing.
 */
export function opsGuard(input: OpsGuardInput): OpsGuardVerdict {
  const target = hostClass(input.connectionString);
  const productionLike = isProductionLike(input.connectionString);
  const labelledProduction = input.nodeEnv === "production";

  const warning =
    productionLike || labelledProduction
      ? `[${input.script}] TARGET IS ${target}${labelledProduction ? " and NODE_ENV=production" : ""} — ` +
        `${input.mutating ? "this run WRITES" : "read-only; nothing will be written"}.`
      : null;

  if (!input.mutating) {
    // Reading is always allowed. A dry run is how an operator learns what a run would do, and
    // refusing it is what trained everyone to unset NODE_ENV — which then also unblocks writes.
    return { allowed: true, refusal: null, warning, target };
  }

  if (!productionLike && !labelledProduction) {
    return { allowed: true, refusal: null, warning, target };
  }

  const flagged = input.argv.includes(PRODUCTION_WRITE_FLAG);
  const named = input.allowEnv === input.script;

  if (flagged && named) {
    return {
      allowed: true,
      refusal: null,
      warning: `${warning ?? ""} AUTHORISED by ${PRODUCTION_WRITE_FLAG} + ${PRODUCTION_WRITE_ENV}=${input.script}.`.trim(),
      target,
    };
  }

  const missing: string[] = [];
  if (!flagged) missing.push(`the ${PRODUCTION_WRITE_FLAG} flag`);
  if (!named) {
    missing.push(
      input.allowEnv === undefined
        ? `${PRODUCTION_WRITE_ENV}=${input.script}`
        : `${PRODUCTION_WRITE_ENV}=${input.script} (it is currently "${input.allowEnv}", which authorises a different runner)`,
    );
  }

  return {
    allowed: false,
    refusal:
      `[${input.script}] REFUSING TO WRITE. Target is ${target}` +
      `${labelledProduction ? " and NODE_ENV=production" : ""}. ` +
      `Missing: ${missing.join(" and ")}. ` +
      `Both are required, and they are separate on purpose: a flag cannot be inherited from an ` +
      `environment, and an environment variable that names this runner cannot be left over from ` +
      `authorising another one.`,
    warning,
    target,
  };
}
