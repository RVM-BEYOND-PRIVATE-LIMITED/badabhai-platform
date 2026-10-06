import { ROLE_ART_KINDS, type RoleArtKind } from "./generated/role-art-data";

const KNOWN: ReadonlySet<string> = new Set(ROLE_ART_KINDS);

/** The fallback every card without a (known) role draws. */
export const ROLE_ART_FALLBACK = "generic" satisfies RoleArtKind;

/**
 * The art to draw for a posting's `role_kind`, which comes off a wire or a form and is
 * `unknown` here on purpose: null, missing, malformed or a kind this build has no art for all
 * draw the generic illustration — never an error, never a blank. Membership is a Set lookup on
 * the closed list, so `"toString"` / `"__proto__"` are unknown, not inherited.
 */
export function resolveRoleArtKind(roleKind: unknown): RoleArtKind {
  return typeof roleKind === "string" && KNOWN.has(roleKind)
    ? (roleKind as RoleArtKind)
    : ROLE_ART_FALLBACK;
}
