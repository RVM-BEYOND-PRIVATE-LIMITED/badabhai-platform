/**
 * The failed-sign-in shake (#2587): one 6px shake over 200ms on the form (globals.css
 * `login-shake-a` / `login-shake-b`, both zero under reduced motion).
 *
 * `count` is the number of refused attempts so far. A CSS animation restarts only when its NAME
 * changes, so consecutive refusals alternate between two identical keyframes — every refusal
 * shakes once, and the form is never remounted (focus and typed values stay put). 0 = never
 * refused: no class, no motion on arrival.
 */
export function shakeClass(count: number): string {
  if (count <= 0) return "";
  return count % 2 === 1 ? " login-form--shake-a" : " login-form--shake-b";
}
