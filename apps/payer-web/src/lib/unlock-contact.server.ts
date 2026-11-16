import "server-only";
import { getUnlockContact } from "./payer-api";
import { isPayerRateLimited } from "./payer-errors";
import { mapContactLookup, type ContactLookupView } from "./unlock-view";

/**
 * #2747 — read what each LIVE credit opened, once per screen load.
 *
 * The contact route is read every time the screen opens and its response is never cached, stored
 * or logged (`Cache-Control: no-store`). A 404 (the rule off for this company) and the neutral 200
 * body both leave today's opened screen in place; a 429 is the hourly disclosure cap and shows a
 * polite line; any other failure is kept quiet too — a contact read is never allowed to break a
 * feed.
 *
 * The result is keyed by `unlockId` (one grant per worker, but the id is what the route takes) and
 * lives only in the page's props for this render.
 */
export async function readUnlockContacts(
  unlocks: ReadonlyArray<{ unlockId: string }>,
): Promise<Record<string, ContactLookupView | null>> {
  const entries = await Promise.all(
    unlocks.map(async (u): Promise<[string, ContactLookupView | null]> => {
      try {
        return [u.unlockId, mapContactLookup(await getUnlockContact(u.unlockId))];
      } catch (e) {
        return [u.unlockId, isPayerRateLimited(e) ? { kind: "limited" } : null];
      }
    }),
  );
  return Object.fromEntries(entries);
}
