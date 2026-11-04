// Fake forge API for adapter tests: maps "path?query" (without the API base) to a response;
// an unrouted path fails with status 599.
import type { HttpDeps } from "../src/core/http.ts";

/** A JSON body, a bare status code, or a full Response (for custom headers). */
export type Route = unknown;

export interface FakeApi {
  http: HttpDeps;
  /** Requested paths, in order (without the API base). */
  calls: string[];
  /** Request headers of each call, in the same order. */
  headers: Record<string, string>[];
}

export function fakeApi(base: string, routes: Record<string, Route>): FakeApi {
  const calls: string[] = [];
  const headers: Record<string, string>[] = [];
  const http: HttpDeps = {
    fetchFn: async (url, init) => {
      if (!url.startsWith(base)) throw new Error(`request outside the API base: ${url}`);
      const path = url.slice(base.length);
      calls.push(path);
      headers.push({ ...(init?.headers as Record<string, string>) });
      const body = routes[path];
      // Not a 404: adapters treat some 404s as "absent", which would hide a wrongly built URL.
      // Tests route intentional 404s explicitly.
      if (body === undefined) return new Response(`no route for ${path}`, { status: 599 });
      if (body instanceof Response) return body.clone();
      if (typeof body === "number") return new Response("", { status: body });
      return Response.json(body);
    },
    sleep: async () => {},
    retries: 0,
    timeoutMs: 1000,
  };
  return { http, calls, headers };
}
