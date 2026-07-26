// A tiny pair of time formatters for the "history of this file" list: a coarse
// RELATIVE label ("2 days ago") shown on the row, and the ABSOLUTE date/time
// carried in `title=` so the exact instant is one hover away. Pure and
// dependency-free so it is unit-tested directly (no DOM, no clock).
//
// The relative form is deliberately COARSE — minute/hour/day/month/year buckets,
// never "1.7 hours" — because a version list is scanned, not measured, and a
// self-revising precise number is the same trap the find counter avoids. The
// absolute form is the source of truth for anyone who needs the real moment.

/**
 * A coarse "time since" label for an epoch-ms instant, relative to `now`
 * (defaults to `Date.now()` so callers rarely pass it; tests always do). Clamps a
 * future or just-now stamp to "just now" rather than inventing a negative age.
 */
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

/**
 * The full date and time of an epoch-ms instant, for the row's `title` tooltip —
 * "3 Jul 2026, 14:20", en-GB like the recycle bin's own stamps so the two
 * surfaces read identically.
 */
export function absoluteTime(then: number): string {
  const d = new Date(then);
  const date = d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return `${date}, ${time}`;
}
