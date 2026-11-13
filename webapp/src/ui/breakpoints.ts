// The breakpoints of `00-tokens.css`, for code that must lay out by them
// (media queries can't share a variable with script).

/** A phone: below 700px. */
export const PHONE_QUERY = "(max-width: 699px)";

/** True on a phone-width window now. */
export function isPhone(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(PHONE_QUERY).matches;
}

/** A desktop: from 1100px, where a list and its open item sit side by side. */
export const WIDE_QUERY = "(min-width: 1100px)";

/** True on a desktop-width window now. */
export function isWide(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(WIDE_QUERY).matches;
}
