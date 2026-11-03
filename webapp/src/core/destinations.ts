/**
 * The keys of the rail's non-folder destinations. They live in `core/` so the
 * router can tell destinations from folder ids without importing `pages/`;
 * labels and icons stay in `pages/rail.ts`, which is not forced to match.
 */
export type DestinationKey = "bin" | "admin";

/** Every destination key, for the router's "is this segment a place?" test. */
export const DESTINATION_KEYS: readonly DestinationKey[] = ["bin", "admin"];
