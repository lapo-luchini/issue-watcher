// Helpers shared by the forge adapters.
import { GoneError, HttpError, RateLimitError } from "../core/http.ts";

/**
 * Only a 404/410 on the item itself means it is gone; on a sub-request (timeline, commits,
 * CI…) it is an ordinary failure, so the item is retried instead of being marked gone.
 */
export async function notGone<T>(request: Promise<T>): Promise<T> {
  try {
    return await request;
  } catch (err) {
    if (err instanceof GoneError) throw new HttpError(err.status, err.url, err.message);
    throw err;
  }
}

/** null when the request is forbidden or not found; rate limits and other errors still throw. */
export async function optional<T>(request: Promise<T>): Promise<T | null> {
  try {
    return await request;
  } catch (err) {
    if (err instanceof HttpError && !(err instanceof RateLimitError) && (err.status === 403 || err.status === 404)) return null;
    throw err;
  }
}

/**
 * True when `body` @-mentions `user` (case-insensitive, whole login only). Logins may
 * contain dots (GitLab, Forgejo), so "@lapo.luchini" is not "@lapo", but "@lapo." is.
 */
export function mentions(body: string, user: string): boolean {
  const escaped = user.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w.@-])@${escaped}(?![\\w-]|\\.\\w)`, "i").test(body);
}

/** Parses a URL, or returns null when it is not one. */
export function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}
