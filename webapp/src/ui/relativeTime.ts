// Coarse relative ("2 days ago") and absolute date formatters, for the file
// history list and digests.

/** Coarse "time since" label; a future or just-now stamp clamps to "just now". */
export function relativeTime(then: number, now: number = Date.now()): string {
  const secs = Math.round((now - then) / 1000);
  if (!Number.isFinite(secs) || secs < 45) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 45) return mins === 1 ? "1 minute ago" : `${mins} minutes ago`;
  const hours = Math.round(secs / 3600);
  if (hours < 22) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  const days = Math.round(secs / 86_400);
  if (days < 26) return days === 1 ? "yesterday" : `${days} days ago`;
  const months = Math.round(secs / (86_400 * 30));
  if (months < 11) return months === 1 ? "1 month ago" : `${months} months ago`;
  const years = Math.round(secs / (86_400 * 365));
  return years <= 1 ? "1 year ago" : `${years} years ago`;
}

/** The day alone, en-GB like {@link absoluteTime}: "8 Nov 2026". */
export function absoluteDate(then: number): string {
  return new Date(then).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/** Full date and time, en-GB to match the recycle bin's stamps. */
export function absoluteTime(then: number): string {
  const time = new Date(then).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return `${absoluteDate(then)}, ${time}`;
}
