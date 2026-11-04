// Minimal JSON-over-HTTP helper shared by all adapters: timeout, retry with backoff on
// transient failures, typed errors for "gone" and "rate limited", Link-header pagination.

export class HttpError extends Error {
  constructor(readonly status: number, readonly url: string, message?: string) {
    super(message ?? `HTTP ${status} for ${url}`);
  }
}

/** 404/410: the item was deleted, made private, or never existed. */
export class GoneError extends HttpError {}

export class RateLimitError extends HttpError {
  constructor(status: number, url: string, readonly resetAt: Date | null) {
    super(status, url, `rate limited on ${url}` + (resetAt ? ` until ${resetAt.toISOString()}` : ""));
  }
}

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface HttpDeps {
  fetchFn: FetchFn;
  sleep: (ms: number) => Promise<void>;
  retries: number;
  timeoutMs: number;
}

export const defaultHttp: HttpDeps = {
  fetchFn: (url, init) => fetch(url, init),
  sleep: (ms) => Bun.sleep(ms),
  retries: 3,
  timeoutMs: 30_000,
};

export interface JsonResponse<T> {
  data: T;
  headers: Headers;
}

const backoff = (attempt: number) => 500 * 2 ** attempt;

function isRateLimited(res: Response): boolean {
  if (res.status === 429) return true;
  return res.status === 403 && (res.headers.get("x-ratelimit-remaining") === "0" || res.headers.has("retry-after"));
}

function resetTime(res: Response): Date | null {
  const retryAfter = res.headers.get("retry-after");
  if (retryAfter && /^\d+$/.test(retryAfter)) return new Date(Date.now() + Number(retryAfter) * 1000);
  const reset = res.headers.get("x-ratelimit-reset");
  if (reset && /^\d+$/.test(reset)) return new Date(Number(reset) * 1000);
  return null;
}

export async function getJson<T>(url: string, headers: Record<string, string>, deps: HttpDeps = defaultHttp): Promise<JsonResponse<T>> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await deps.fetchFn(url, { headers, signal: AbortSignal.timeout(deps.timeoutMs) });
    } catch (err) {
      if (attempt < deps.retries) {
        await deps.sleep(backoff(attempt));
        continue;
      }
      throw new Error(`network error for ${url}: ${(err as Error).message}`);
    }
    if (res.ok) return { data: (await res.json()) as T, headers: res.headers };
    if (res.status === 404 || res.status === 410) throw new GoneError(res.status, url);
    if (isRateLimited(res)) throw new RateLimitError(res.status, url, resetTime(res));
    if (res.status >= 500 && attempt < deps.retries) {
      await deps.sleep(backoff(attempt));
      continue;
    }
    throw new HttpError(res.status, url, `HTTP ${res.status} for ${url}: ${(await res.text()).slice(0, 200)}`);
  }
}

/** Extracts the rel="next" URL from an RFC 8288 Link header (GitHub, GitLab, Forgejo). */
export function nextLink(link: string | null): string | null {
  return link?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
}

/** Fetches every page and concatenates the arrays `pick` extracts from each body. */
export async function getAllPages<T>(
  url: string,
  headers: Record<string, string>,
  deps: HttpDeps = defaultHttp,
  pick: (body: any) => T[] = (body) => body,
  maxPages = 20,
): Promise<T[]> {
  const out: T[] = [];
  let next: string | null = url;
  for (let page = 0; next && page < maxPages; page++) {
    const res: JsonResponse<unknown> = await getJson<unknown>(next, headers, deps);
    out.push(...pick(res.data));
    next = nextLink(res.headers.get("link"));
  }
  return out;
}
