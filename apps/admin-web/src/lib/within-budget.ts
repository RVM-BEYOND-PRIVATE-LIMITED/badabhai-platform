/**
 * `work`'s result if it settles within `ms`, otherwise — or if it fails — `fallback`.
 *
 * For a read a page can do without (a filter's suggestion list): the console renders with no
 * loading boundary (app/no-loading-boundary-anywhere.test.ts), so a server component awaits every
 * read it makes, and one that hangs until the 15s request timeout would hold the whole page — the
 * list the operator came for included. Past the budget the page renders without it. The work is
 * not cancelled: it settles on its own, and a cached read is then there for the next render.
 */
export async function withinBudget<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([work.catch(() => fallback), late]);
  } finally {
    clearTimeout(timer);
  }
}
