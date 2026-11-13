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
  // GitHub sends X-RateLimit-Reset, GitLab RateLimit-Reset; both are epoch seconds.
  const reset = res.headers.get("x-ratelimit-reset") ?? res.headers.get("ratelimit-reset");
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

/** The rel="last" URL of an RFC 8288 Link header. */
function lastLink(link: string | null): string | null {
  return link?.match(/<([^>]+)>;\s*rel="last"/)?.[1] ?? null;
}

export interface PageOptions {
  /** Pages to read before giving up (default 20). */
  maxPages?: number;
  /** Past maxPages, throw instead of returning what was read. For oldest-first lists, where the dropped pages hold the newest entries. */
  strict?: boolean;
  /** Oldest-first list with a rel="last" link: read its last maxPages pages, so the newest entries survive. */
  tail?: boolean;
}

/** Fetches every page and concatenates the arrays `pick` extracts from each body; newest-first lists may be truncated at maxPages. */
export async function getAllPages<T>(
  url: string,
  headers: Record<string, string>,
  deps: HttpDeps = defaultHttp,
  pick: (body: any) => T[] = (body) => body,
  { maxPages = 20, strict = false, tail = false }: PageOptions = {},
): Promise<T[]> {
  const out: T[] = [];
  let res: JsonResponse<unknown> = await getJson<unknown>(url, headers, deps);
  if (tail) {
    const last = lastLink(res.headers.get("link"));
    const lastPage = Number(last && new URL(last).searchParams.get("page"));
    if (last && lastPage > maxPages) {
      for (let page = lastPage - maxPages + 1; page <= lastPage; page++) {
        const u = new URL(last);
        u.searchParams.set("page", String(page));
        out.push(...pick((await getJson<unknown>(u.toString(), headers, deps)).data));
      }
      return out;
    }
  }
  out.push(...pick(res.data));
  let next = nextLink(res.headers.get("link"));
  for (let page = 1; next && page < maxPages; page++) {
    res = await getJson<unknown>(next, headers, deps);
    out.push(...pick(res.data));
    next = nextLink(res.headers.get("link"));
  }
  if (next && strict) throw new Error(`more than ${maxPages} pages at ${url}`);
  return out;
}
