/**
 * The keys of the rail's non-folder destinations — the recycle bin and the admin
 * console — and nothing else about them.
 *
 * **Why the keys live here and the rows live in `pages/rail.ts`.** The router
 * has to know which URL segments are destinations rather than folder ids, and it
 * used to learn that by importing `DESTINATIONS` from `pages/rail` — its only
 * import from `pages/`, and the one edge that made the layer graph cyclic.
 *
 * Moving the whole list here would have dragged `IconName` from `ui/` into
 * `core/` to carry labels and icons the router never reads. So the split follows
 * what each side actually needs: `core/` owns the identity, `pages/rail.ts` owns
 * how it looks.
 *
 * **Adding a key here does NOT force the rail to grow a row** — `DESTINATIONS`
 * is an array, so a missing entry type-checks. (It is an array because the order
 * is the display order; a `Record<DestinationKey, …>` would buy exhaustiveness
 * and lose that.) The consequence of forgetting is small and visible: the router
 * would treat the segment as a place, and the rail would show nothing for it.
 */
export type DestinationKey = "bin" | "admin";

/** Every destination key, for the router's "is this segment a place?" test. */
export const DESTINATION_KEYS: readonly DestinationKey[] = ["bin", "admin"];
