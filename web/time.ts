// Relative times for the item list ("4 min ago", "yesterday", "3 Nov").

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function relativeTime(iso: string | null, now: Date = new Date()): string {
  if (!iso) return "";
  const t = new Date(iso);
  const ago = now.getTime() - t.getTime();
  if (ago < MINUTE) return "just now";
  if (ago < HOUR) return `${Math.floor(ago / MINUTE)} min ago`;
  if (ago < DAY) return `${Math.floor(ago / HOUR)} h ago`;
  if (ago < 2 * DAY) return "yesterday";
  if (ago < 7 * DAY) return `${Math.floor(ago / DAY)} days ago`;
  const sameYear = t.getFullYear() === now.getFullYear();
  return t.toLocaleDateString(undefined, sameYear ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" });
}

export function absoluteTime(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : "";
}
