/**
 * The ONE place "Hiring capacity" lives: a section of Plans & capacity (`/plans`).
 *
 * `/capacity` is kept as a route (old links, the at-capacity alert on New posting) but it is a
 * redirect to this anchor, not a second page with the same tiles, panel and table. Companies
 * only: Plans & capacity sells entitlements on company postings (see plans/page.tsx).
 */
export const HIRING_CAPACITY_ANCHOR = "hiring-capacity";

export const HIRING_CAPACITY_HREF = `/plans#${HIRING_CAPACITY_ANCHOR}`;
