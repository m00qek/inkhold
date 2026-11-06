// The breakpoints of `00-tokens.css`, for code that must lay out by them
// (media queries can't share a variable with script).

/** A phone: below 700px. */
export const PHONE_QUERY = "(max-width: 699px)";

/** True on a phone-width window now. */
export function isPhone(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(PHONE_QUERY).matches;
}
