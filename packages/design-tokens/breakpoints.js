/**
 * Layout breakpoints (min-width, px, mobile first) — the TS twin of the `@custom-media --bp-*`
 * declarations in tokens.css. Keep the two in step (fenced by
 * apps/payer-web/src/app/design-tokens-motion.test.ts).
 */
export const BREAKPOINTS = Object.freeze({
  phone: 375,
  tablet: 600,
  desktop: 1024,
  wide: 1280,
});
